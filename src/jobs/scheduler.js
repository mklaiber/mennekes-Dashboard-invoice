'use strict';

/**
 * Automatisierung der Monatsabrechnung via node-cron.
 *
 * node-cron kennt kein "L" (letzter Tag des Monats), und der Monatsletzte
 * wechselt zwischen 28 und 31. Lösung: der Job läuft täglich zur konfigurierten
 * Uhrzeit und prüft selbst, ob heute der Monatsletzte ist (`runPolicy`).
 * Das ist robuster als drei separate Cron-Ausdrücke für 28./30./31.
 */

const cron = require('node-cron');
const config = require('../config');
const logger = require('../utils/logger');
const settingsStore = require('../config/settings');
const { runMonthlyReport } = require('../services/reportService');
const { isLastDayOfMonth, partsInZone } = require('../utils/dates');

/**
 * Soll der Lauf jetzt stattfinden?
 *
 * @param {object} [options]
 * @param {string} [options.runPolicy] 'last-day-of-month' | 'always'
 * @param {string} [options.timezone]
 * @param {Date} [options.now]
 * @returns {boolean}
 */
function shouldRunNow({ runPolicy, timezone, now = new Date() } = {}) {
  const policy = runPolicy || settingsStore.load().scheduler.runPolicy || 'last-day-of-month';
  const zone = timezone || settingsStore.load().billing.timezone || config.billing.timezone;
  if (policy === 'always') return true;
  return isLastDayOfMonth(now, zone);
}

/**
 * Welcher Monat wird abgerechnet?
 *
 * Läuft der Job am Monatsletzten, ist der ABLAUFENDE Monat gemeint (nicht der
 * Vormonat) - am 31.03. um 23:30 soll der März abgerechnet werden.
 * Bei `runPolicy: 'always'` (manueller/Test-Betrieb) gilt dasselbe: der
 * aktuelle Monat, so weit er vorliegt.
 *
 * @param {Date} [now=new Date()]
 * @param {string} [timezone]
 * @returns {{year:number, month:number}}
 */
function periodForRun(now = new Date(), timezone) {
  const zone = timezone || settingsStore.load().billing.timezone || config.billing.timezone;
  const { year, month } = partsInZone(now, zone);
  return { year, month };
}

class ReportScheduler {
  /**
   * @param {object} [options]
   * @param {import('../services/mennekesClient')} [options.client]
   * @param {string} [options.cronExpression]
   * @param {string} [options.timezone]
   * @param {Function} [options.runner] injizierbar für Tests (Default: runMonthlyReport)
   */
  constructor(options = {}) {
    this.client = options.client;
    this.cronExpression = options.cronExpression || config.scheduler.cronExpression;
    this.timezone = options.timezone || config.scheduler.timezone;
    this.runner = options.runner || runMonthlyReport;
    /** @type {import('node-cron').ScheduledTask|null} */
    this.task = null;
    this.running = false;
    this.lastRun = null;
  }

  /**
   * Registriert den Cronjob.
   * @returns {import('node-cron').ScheduledTask|null} null, wenn deaktiviert
   */
  start() {
    const settings = settingsStore.load();
    const enabled = settings.scheduler.enabled ?? config.scheduler.enabled;

    if (!enabled) {
      logger.info('Cronjob deaktiviert (scheduler.enabled = false).');
      return null;
    }
    if (!cron.validate(this.cronExpression)) {
      logger.error(`Ungültiger Cron-Ausdruck "${this.cronExpression}" - Automatisierung wird NICHT gestartet.`);
      return null;
    }

    this.task = cron.schedule(
      this.cronExpression,
      () => { this.tick().catch((error) => logger.error('Cron-Lauf fehlgeschlagen:', error.message)); },
      { scheduled: true, timezone: this.timezone }
    );

    logger.info(`Cronjob aktiv: "${this.cronExpression}" (${this.timezone}), Policy: ${settings.scheduler.runPolicy}.`);
    return this.task;
  }

  /**
   * Ein Cron-Tick: prüft die Policy und startet ggf. den Lauf.
   * @param {Date} [now=new Date()]
   * @returns {Promise<object|null>} Ergebnis von runMonthlyReport oder null
   */
  async tick(now = new Date()) {
    const settings = settingsStore.load();
    const timezone = settings.billing.timezone || config.billing.timezone;

    if (!shouldRunNow({ runPolicy: settings.scheduler.runPolicy, timezone, now })) {
      logger.debug('Cron-Tick: heute ist kein Abrechnungstag - übersprungen.');
      return null;
    }
    // Ein noch laufender Report (z. B. manuell gestartet) darf nicht doppelt laufen.
    if (this.running) {
      logger.warn('Cron-Tick übersprungen: ein Lauf ist bereits aktiv.');
      return null;
    }

    this.running = true;
    const { year, month } = periodForRun(now, timezone);

    try {
      logger.info(`Cron-Lauf startet Abrechnung für ${year}-${String(month).padStart(2, '0')}.`);
      const result = await this.runner({ year, month, sendMail: true, client: this.client });

      this.lastRun = {
        at: new Date().toISOString(),
        period: `${year}-${String(month).padStart(2, '0')}`,
        ok: true,
        energyKwh: result?.report?.totals?.energyKwh ?? null,
        messageId: result?.mail?.messageId ?? null,
      };
      logger.info(`Cron-Lauf abgeschlossen: ${this.lastRun.energyKwh} kWh abgerechnet.`);
      return result;
    } catch (error) {
      this.lastRun = { at: new Date().toISOString(), period: `${year}-${String(month).padStart(2, '0')}`, ok: false, error: error.message };
      // Nicht weiterwerfen: ein Fehlschlag darf den Prozess nicht beenden,
      // der nächste Monat soll wieder laufen.
      logger.error(`Cron-Lauf fehlgeschlagen: ${error.message}`);
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Cronjob beenden. */
  stop() {
    if (!this.task) return;
    this.task.stop();
    this.task = null;
    logger.info('Cronjob gestoppt.');
  }
}

module.exports = { ReportScheduler, shouldRunNow, periodForRun };
