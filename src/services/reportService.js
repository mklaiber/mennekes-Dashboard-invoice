'use strict';

/**
 * Orchestrierung der Monatsabrechnung.
 *
 * Ablauf: Historie holen -> Report rechnen -> PDF + CSV erzeugen -> auf Platte
 * ablegen -> optional per E-Mail versenden.
 *
 * Bewusst der einzige Ort, an dem Wallbox-API, Billing, PDF, CSV und Mailer
 * zusammenlaufen - Routen und Cronjob rufen ausschließlich diese Funktionen auf.
 */

const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const settingsStore = require('../repositories/settingsRepository');
const fleet = require('../repositories/fleetRepository');
const MennekesClient = require('./mennekesClient');
const { buildMonthlyReport } = require('./billing');
const { generateInvoicePdf, pdfFileName } = require('./pdfService');
const { buildDetailCsv, buildSummaryCsv, csvFileName } = require('./csvService');
const { sendMonthlyReport } = require('./mailer');
const reportRuns = require('../repositories/reportRunRepository');
const { monthRange, previousMonth } = require('../utils/dates');
const sessionSource = require('./sessionSource');

/**
 * Holt die Ladehistorie und rechnet den Monat durch - ohne Dateien zu erzeugen.
 * Wird auch von der REST-API für die Vorschau im Dashboard genutzt.
 *
 * @param {object} params
 * @param {number} params.year
 * @param {number} params.month 1-12
 * @param {MennekesClient} [params.client]
 * @param {object} [params.settings]
 * @returns {Promise<object>} Report (siehe buildMonthlyReport)
 */
/**
 * Klartextbezeichnung eines Geltungsbereichs, fuer Protokoll und PDF-Kopf.
 * @param {{kind:string, id:number|null}} scope
 * @param {object|null} [company]
 */
function describeScope(scope, company = null) {
  if (!scope || scope.kind === 'all') return 'Gesamt';
  if (scope.kind === 'company')  return company ? company.name : `Firma ${scope.id}`;
  if (scope.kind === 'vehicle')  return `Fahrzeug ${scope.id}`;
  if (scope.kind === 'unassigned') return 'Nicht zugeordnet';
  return 'Gesamt';
}

async function buildReportForMonth({ year, month, client, settings, scope } = {}) {
  const activeSettings = settings || settingsStore.load();
  const activeScope = scope && scope.kind ? scope : { kind: 'all', id: null };

  // Bei einer Firma gilt deren eigener Arbeitspreis, sofern hinterlegt. null
  // heisst ausdruecklich "globale Einstellung" - 0 waere ein echter Preis.
  const company = activeScope.kind === 'company' && activeScope.id
    ? fleet.findCompany(activeScope.id)
    : null;
  const pricePerKwh = company && company.pricePerKwh !== null
    ? company.pricePerKwh
    : activeSettings.billing.pricePerKwh;
  const timezone = activeSettings.billing.timezone || config.billing.timezone;
  const period = monthRange(year, month, timezone);

  // Im Connector-Betrieb ist die Wallbox von hier aus nicht erreichbar - dann
  // liefert sessionSource die Daten aus der eigenen Datenbank und der Client
  // wird gar nicht erst gebaut.
  const activeClient = sessionSource.isConnectorMode()
    ? null
    : (client || new MennekesClient({ baseUrl: activeSettings.wallbox.baseUrl }));

  const sessions = await sessionSource.getSessions({
    from: period.start,
    to: period.end,
    client: activeClient,
  });

  logger.info(`${sessions.length} Ladevorgänge für ${period.label} geladen.`);

  return buildMonthlyReport({
    sessions,
    year,
    month,
    pricePerKwh,
    scope: activeScope,
    rfidLookup: settingsStore.rfidLookup(activeSettings.rfidMappings),
    currency: activeSettings.billing.currency,
    locale: activeSettings.billing.locale,
    timezone,
    meta: {
      // Bei einem Firmenbericht steht die Firma im Kopf, nicht die globale
      // Voreinstellung - sonst traegt jede Rechnung denselben Absender.
      companyName: company ? company.name : activeSettings.billing.companyName,
      companyAddress: company ? company.address : '',
      employeeName: activeSettings.billing.employeeName,
      vehiclePlate: activeSettings.billing.vehiclePlate,
      wallbox: activeSettings.wallbox.displayName,
      scopeLabel: describeScope(activeScope, company),
    },
  });
}

/**
 * Erzeugt PDF + CSV für einen Report und legt sie im Ausgabeverzeichnis ab.
 *
 * @param {object} report
 * @param {object} settings
 * @param {object} [options]
 * @param {string} [options.outputDir] Default: config.server.outputDir
 * @returns {Promise<{pdf:{fileName:string, filePath:string, buffer:Buffer},
 *   csvDetail:{fileName:string, filePath:string, content:string},
 *   csvSummary:{fileName:string, filePath:string, content:string}}>}
 */
async function generateArtifacts(report, settings, options = {}) {
  const outputDir = options.outputDir || config.server.outputDir;
  await fs.mkdir(outputDir, { recursive: true });

  const pdfName = pdfFileName(report);
  const pdfPath = path.join(outputDir, pdfName);
  const { buffer } = await generateInvoicePdf(report, settings, { outputPath: pdfPath });

  const detailName = csvFileName(report, 'detail');
  const detailPath = path.join(outputDir, detailName);
  const detailContent = buildDetailCsv(report);
  await fs.writeFile(detailPath, detailContent, 'utf8');

  const summaryName = csvFileName(report, 'summe');
  const summaryPath = path.join(outputDir, summaryName);
  const summaryContent = buildSummaryCsv(report);
  await fs.writeFile(summaryPath, summaryContent, 'utf8');

  logger.info(`Artefakte erzeugt in ${outputDir}: ${pdfName}, ${detailName}, ${summaryName}`);

  return {
    pdf: { fileName: pdfName, filePath: pdfPath, buffer },
    csvDetail: { fileName: detailName, filePath: detailPath, content: detailContent },
    csvSummary: { fileName: summaryName, filePath: summaryPath, content: summaryContent },
  };
}

/**
 * Kompletter Monatslauf: Daten holen, Dateien erzeugen, Mail versenden.
 *
 * @param {object} [params]
 * @param {number} [params.year]  Default: Vormonat
 * @param {number} [params.month] Default: Vormonat
 * @param {boolean} [params.sendMail=true]
 * @param {string[]} [params.to] Empfänger-Override (z. B. Testversand aus der WebUI)
 * @param {MennekesClient} [params.client]
 * @param {import('nodemailer').Transporter} [params.transporter]
 * @param {object} [params.settings]
 * @param {string} [params.outputDir]
 * @param {string} [params.triggeredBy] 'cron' oder 'manual:<benutzer>' für die Historie
 * @returns {Promise<{report:object, files:object, mail:object|null, runId:number}>}
 */
async function runMonthlyReport(params = {}) {
  const activeSettings = params.settings || settingsStore.load();
  const timezone = activeSettings.billing.timezone || config.billing.timezone;

  // Ohne Angabe wird der abgeschlossene Vormonat abgerechnet.
  const fallback = previousMonth(new Date(), timezone);
  const year = params.year ?? fallback.year;
  const month = params.month ?? fallback.month;

  const periodKey = `${year}-${String(month).padStart(2, '0')}`;
  logger.info(`Starte Monatsabrechnung für ${periodKey}.`);

  // Der Lauf wird vor der ersten Aktion vermerkt: bricht er ab, bleibt die
  // Zeile mit Fehlermeldung stehen statt spurlos zu verschwinden.
  const scope = params.scope && params.scope.kind ? params.scope : { kind: 'all', id: null };
  const scopeCompany = scope.kind === 'company' && scope.id ? fleet.findCompany(scope.id) : null;

  const runId = reportRuns.start({
    periodKey,
    triggeredBy: params.triggeredBy || 'unbekannt',
    scope,
    scopeLabel: describeScope(scope, scopeCompany),
  });

  try {
    const report = await buildReportForMonth({
      year,
      month,
      client: params.client,
      settings: activeSettings,
      scope,
    });

    const files = await generateArtifacts(report, activeSettings, { outputDir: params.outputDir });

    let mail = null;
    if (params.sendMail !== false) {
      mail = await sendMonthlyReport({
        report,
        settings: activeSettings,
        // Eine Firma bekommt ihre Rechnung an ihre eigene Adresse. Fehlt sie,
        // faellt es auf den globalen Empfaenger zurueck, statt den Lauf
        // scheitern zu lassen - lieber zugestellt als verloren.
        to: params.to || (scopeCompany && scopeCompany.contactEmail) || undefined,
        transporter: params.transporter,
        attachments: [
          { filename: files.pdf.fileName, content: files.pdf.buffer, contentType: 'application/pdf' },
          { filename: files.csvDetail.fileName, content: files.csvDetail.content, contentType: 'text/csv; charset=utf-8' },
          { filename: files.csvSummary.fileName, content: files.csvSummary.content, contentType: 'text/csv; charset=utf-8' },
        ],
      });
    } else {
      logger.info('Mailversand übersprungen (sendMail=false).');
    }

    reportRuns.finishOk(runId, { report, files, mail });
    return { report, files, mail, runId };
  } catch (error) {
    reportRuns.finishFailed(runId, error.message);
    throw error;
  }
}


/**
 * Monatslauf ueber den gesamten Fuhrpark.
 *
 * Erzeugt fuer jede Firma mit `own_report` einen eigenen Bericht an ihre
 * eigene Kontaktadresse - zwei Arbeitgeber bekommen nicht dieselbe PDF -
 * und zusaetzlich eine Gesamtuebersicht an den globalen Empfaenger.
 *
 * Ein Fehlschlag bei einer Firma bricht den Lauf NICHT ab: die uebrigen
 * Rechnungen sollen trotzdem herausgehen, und der Fehler steht in der
 * Lauf-Historie. Sonst haette eine falsch hinterlegte Mailadresse die
 * Abrechnung aller anderen verhindert.
 *
 * @param {object} [params] wie runMonthlyReport, ohne scope
 * @returns {Promise<{results:Array<object>, failed:Array<{scopeLabel:string, error:string}>}>}
 */
async function runMonthlyReports(params = {}) {
  const companies = fleet.listCompanies().filter((company) => company.ownReport);
  const results = [];
  const failed = [];

  for (const company of companies) {
    try {
      const run = await runMonthlyReport({ ...params, scope: { kind: 'company', id: company.id } });
      results.push({ scopeLabel: company.name, ...run });
    } catch (error) {
      logger.error(`Monatsbericht für "${company.name}" fehlgeschlagen: ${error.message}`);
      failed.push({ scopeLabel: company.name, error: error.message });
    }
  }

  // Gesamtuebersicht zum Schluss: sie enthaelt auch, was keiner Firma
  // zugeordnet ist, und ist damit die Arbeitsliste fuer Nacharbeiten.
  try {
    const overall = await runMonthlyReport({ ...params, scope: { kind: 'all', id: null } });
    results.push({ scopeLabel: 'Gesamt', ...overall });
  } catch (error) {
    logger.error(`Gesamtbericht fehlgeschlagen: ${error.message}`);
    failed.push({ scopeLabel: 'Gesamt', error: error.message });
  }

  logger.info(`Monatslauf abgeschlossen: ${results.length} Bericht(e), ${failed.length} Fehlschlag/Fehlschlaege.`);
  return { results, failed };
}

/**
 * Listet bereits erzeugte Reports im Ausgabeverzeichnis (für die WebUI).
 * @param {string} [outputDir]
 * @returns {Promise<Array<{fileName:string, sizeBytes:number, modifiedAt:Date}>>}
 */
async function listGeneratedFiles(outputDir = config.server.outputDir) {
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /\.(pdf|csv)$/i.test(entry.name))
        .map(async (entry) => {
          const stats = await fs.stat(path.join(outputDir, entry.name));
          return { fileName: entry.name, sizeBytes: stats.size, modifiedAt: stats.mtime };
        })
    );
    return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

module.exports = {
  buildReportForMonth, generateArtifacts, runMonthlyReport, runMonthlyReports,
  listGeneratedFiles, describeScope,
};
