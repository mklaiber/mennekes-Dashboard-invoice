'use strict';

/**
 * PDF-Erzeugung: Handlebars-Template -> HTML -> Puppeteer -> A4-PDF.
 *
 * Der Browser wird als Singleton gehalten und wiederverwendet. Ein Chromium-Start
 * kostet ~300-800ms; bei manuell ausgelösten Reports aus der WebUI summiert sich das.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const config = require('../config');
const logger = require('../utils/logger');
const { formatNumber } = require('./billing');
const { formatDate, formatTime } = require('../utils/dates');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'views', 'pdf', 'invoice.hbs');

/** @type {import('puppeteer').Browser|null} */
let browserSingleton = null;
/** @type {HandlebarsTemplateDelegate|null} */
let compiledTemplate = null;

/**
 * Handlebars-Helper registrieren (idempotent).
 * @param {string} locale
 * @param {string} currency
 */
function registerHelpers(locale, currency) {
  // `money` und `num` lesen Locale/Währung aus dem Closure - deshalb bei jedem
  // Render neu registrieren, falls sich die Einstellungen geändert haben.
  handlebars.registerHelper('money', (value, decimals) => {
    const digits = typeof decimals === 'number' ? decimals : 2;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(Number.isFinite(value) ? value : 0);
  });

  handlebars.registerHelper('num', (value, decimals) =>
    formatNumber(value, typeof decimals === 'number' ? decimals : 2, locale));

  handlebars.registerHelper('eq', (a, b) => a === b);
}

/**
 * Lädt und kompiliert das Template (gecacht).
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<HandlebarsTemplateDelegate>}
 */
async function loadTemplate({ force = false } = {}) {
  if (compiledTemplate && !force) return compiledTemplate;
  const source = await fs.readFile(TEMPLATE_PATH, 'utf8');
  compiledTemplate = handlebars.compile(source);
  return compiledTemplate;
}

/**
 * Belegnummer nach Schema `WB-2026-03-0042` (Suffix = Anzahl Ladevorgänge).
 * @param {object} report
 * @returns {string}
 */
function documentNumber(report) {
  return `WB-${report.period.key}-${String(report.totals.sessionCount).padStart(4, '0')}`;
}

/**
 * Rendert den Report zu HTML - separat testbar, ohne Chromium zu starten.
 *
 * @param {object} report Ergebnis von buildMonthlyReport()
 * @param {object} settings persistente Einstellungen (siehe config/settings.js)
 * @returns {Promise<string>} vollständiges HTML-Dokument
 */
async function renderHtml(report, settings) {
  const locale = report.locale || 'de-DE';
  const currency = report.currency || 'EUR';
  registerHelpers(locale, currency);

  const template = await loadTemplate();
  return template({
    report,
    settings,
    documentNumber: documentNumber(report),
    generatedAtLabel: `${formatDate(report.generatedAt, locale, report.timezone)} ${formatTime(report.generatedAt, locale, report.timezone)} Uhr`,
  });
}

/**
 * Startet Chromium bzw. liefert die laufende Instanz.
 * @returns {Promise<import('puppeteer').Browser>}
 */
async function getBrowser() {
  if (browserSingleton && browserSingleton.connected !== false) return browserSingleton;

  // Lazy require: so lässt sich das Modul in Tests mocken, ohne Chromium zu laden.
  const puppeteer = require('puppeteer');

  const args = ['--disable-dev-shm-usage', '--disable-gpu'];
  // In Containern ohne eigenen unprivilegierten Namespace läuft Chromium sonst nicht.
  if (config.puppeteer.noSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');

  browserSingleton = await puppeteer.launch({
    headless: true,
    args,
    executablePath: config.puppeteer.executablePath || undefined,
  });

  logger.debug('Chromium gestartet.');
  return browserSingleton;
}

/**
 * Erzeugt das Abrechnungs-PDF.
 *
 * @param {object} report Ergebnis von buildMonthlyReport()
 * @param {object} settings persistente Einstellungen
 * @param {object} [options]
 * @param {string} [options.outputPath] wenn gesetzt, wird das PDF zusätzlich geschrieben
 * @returns {Promise<{buffer:Buffer, html:string, filePath:string|null}>}
 */
async function generateInvoicePdf(report, settings, options = {}) {
  const html = await renderHtml(report, settings);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // `domcontentloaded` statt `networkidle0`: Ohne externe Ressourcen würde
    // networkidle0 nur unnötig Zeit kosten. Ein externes Logo wird unten abgewartet.
    await page.setContent(html, { waitUntil: 'domcontentloaded' });

    if (settings?.billing?.logoUrl) {
      // Bilder müssen dekodiert sein, sonst rendert das PDF eine leere Box.
      // Der Callback wird serialisiert und laeuft im Browser-Kontext, nicht in
      // Node - `document` existiert dort, ist fuer ESLint hier aber unbekannt.
      /* eslint-disable no-undef */
      await page.evaluate(() => Promise.all(
        Array.from(document.images)
          .filter((img) => !img.complete)
          .map((img) => new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          }))
      )).catch(() => { /* Ein kaputtes Logo darf das PDF nicht verhindern. */ });
      /* eslint-enable no-undef */
    }

    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `
        <div style="width:100%;padding:0 13mm;font-size:7pt;color:#9ca3af;
                    font-family:Arial,sans-serif;display:flex;justify-content:space-between;">
          <span>Ladestrom-Abrechnung ${escapeHtml(report.period.label)}</span>
          <span>Seite <span class="pageNumber"></span> von <span class="totalPages"></span></span>
        </div>`,
      margin: { top: '14mm', right: '13mm', bottom: '18mm', left: '13mm' },
    });

    // Puppeteer v23 liefert je nach Aufrufweg Buffer oder Uint8Array.
    const pdfBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

    let filePath = null;
    if (options.outputPath) {
      await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
      await fs.writeFile(options.outputPath, pdfBuffer);
      filePath = options.outputPath;
      logger.info(`PDF geschrieben: ${filePath} (${pdfBuffer.length} Bytes)`);
    }

    return { buffer: pdfBuffer, html, filePath };
  } finally {
    await page.close().catch(() => { /* Seite ggf. schon geschlossen. */ });
  }
}

/** HTML-Escaping für Werte im Footer-Template (wird nicht von Handlebars behandelt). */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Dateiname nach Schema `ladestrom_2026-03_abrechnung.pdf`.
 * @param {object} report
 * @returns {string}
 */
function pdfFileName(report) {
  return `ladestrom_${report.period.key}_abrechnung.pdf`;
}

/** Chromium sauber beenden (Shutdown-Hook, Tests). */
async function closeBrowser() {
  if (!browserSingleton) return;
  try {
    await browserSingleton.close();
  } catch (error) {
    logger.warn(`Chromium konnte nicht sauber beendet werden: ${error.message}`);
  } finally {
    browserSingleton = null;
  }
}

/** Nur für Tests: Caches leeren. */
function _resetCaches() {
  browserSingleton = null;
  compiledTemplate = null;
}

module.exports = {
  generateInvoicePdf,
  renderHtml,
  loadTemplate,
  documentNumber,
  pdfFileName,
  closeBrowser,
  getBrowser,
  TEMPLATE_PATH,
  _resetCaches,
};

// Sicherstellen, dass das Template vorhanden ist - ein fehlendes Template soll
// beim Start auffallen und nicht erst am Monatsende.
if (!fsSync.existsSync(TEMPLATE_PATH)) {
  logger.error(`PDF-Template fehlt: ${TEMPLATE_PATH}`);
}
