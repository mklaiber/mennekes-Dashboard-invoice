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
const settingsStore = require('../config/settings');
const MennekesClient = require('./mennekesClient');
const { buildMonthlyReport } = require('./billing');
const { generateInvoicePdf, pdfFileName } = require('./pdfService');
const { buildDetailCsv, buildSummaryCsv, csvFileName } = require('./csvService');
const { sendMonthlyReport } = require('./mailer');
const { monthRange, previousMonth } = require('../utils/dates');

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
async function buildReportForMonth({ year, month, client, settings } = {}) {
  const activeSettings = settings || settingsStore.load();
  const timezone = activeSettings.billing.timezone || config.billing.timezone;
  const period = monthRange(year, month, timezone);

  const activeClient = client || new MennekesClient({ baseUrl: activeSettings.wallbox.baseUrl });
  const sessions = await activeClient.getChargingSessions(period.start, period.end);

  logger.info(`${sessions.length} Ladevorgänge für ${period.label} geladen.`);

  return buildMonthlyReport({
    sessions,
    year,
    month,
    pricePerKwh: activeSettings.billing.pricePerKwh,
    rfidLookup: settingsStore.rfidLookup(activeSettings.rfidMappings),
    currency: activeSettings.billing.currency,
    locale: activeSettings.billing.locale,
    timezone,
    meta: {
      companyName: activeSettings.billing.companyName,
      employeeName: activeSettings.billing.employeeName,
      vehiclePlate: activeSettings.billing.vehiclePlate,
      wallbox: activeSettings.wallbox.displayName,
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
 * @returns {Promise<{report:object, files:object, mail:object|null}>}
 */
async function runMonthlyReport(params = {}) {
  const activeSettings = params.settings || settingsStore.load();
  const timezone = activeSettings.billing.timezone || config.billing.timezone;

  // Ohne Angabe wird der abgeschlossene Vormonat abgerechnet.
  const fallback = previousMonth(new Date(), timezone);
  const year = params.year ?? fallback.year;
  const month = params.month ?? fallback.month;

  logger.info(`Starte Monatsabrechnung für ${year}-${String(month).padStart(2, '0')}.`);

  const report = await buildReportForMonth({
    year,
    month,
    client: params.client,
    settings: activeSettings,
  });

  const files = await generateArtifacts(report, activeSettings, { outputDir: params.outputDir });

  let mail = null;
  if (params.sendMail !== false) {
    mail = await sendMonthlyReport({
      report,
      settings: activeSettings,
      to: params.to,
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

  return { report, files, mail };
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

module.exports = { buildReportForMonth, generateArtifacts, runMonthlyReport, listGeneratedFiles };
