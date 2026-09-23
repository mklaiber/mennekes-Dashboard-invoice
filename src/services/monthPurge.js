'use strict';

/**
 * Loeschen der Daten des laufenden Monats - etwa nach Testladungen.
 *
 * Geloescht werden die Ladevorgaenge des Monats, die Protokolleintraege der
 * Berichtslaeufe dieses Monats und die dazu erzeugten Dateien. Karten,
 * Fahrzeuge, Firmen, Benutzer, Einstellungen und das Audit-Protokoll bleiben
 * unberuehrt - letzteres ausdruecklich: es ist der Nachweis, DASS geloescht
 * wurde.
 *
 * Wirksam ist das nur im Modbus-Betrieb des Connectors. Im REST-Betrieb holt
 * er die Ladevorgaenge der letzten Tage (history_days) regelmaessig erneut aus
 * dem Speicher der Wallbox, und sie waeren nach dem naechsten Abgleich wieder
 * da. Die Modbus-Register kennen keinen Verlauf, dort bleibt geloescht auch
 * geloescht.
 */

const fs = require('fs/promises');
const path = require('path');
const { db, transaction } = require('../db');
const { monthRange, partsInZone } = require('../utils/dates');
const { periodPrefix } = require('../utils/reportFiles');
const logger = require('../utils/logger');

/**
 * Der laufende Monat in der Zeitzone der Abrechnung - dieselben Grenzen,
 * nach denen auch abgerechnet wird.
 */
function currentPeriod(timezone) {
  const { year, month } = partsInZone(new Date(), timezone);
  return monthRange(year, month, timezone);
}

async function filesOfPeriod(outputDir, key) {
  try {
    const prefix = periodPrefix(key);
    return (await fs.readdir(outputDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && /\.(pdf|csv)$/i.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// julianday statt Zeichenkettenvergleich: gespeichert wird ISO mit
// Millisekunden, aeltere oder von Hand eingefuegte Zeilen koennen ohne sein.
const IN_PERIOD = 'julianday(start_at) >= julianday(@start) AND julianday(start_at) < julianday(@end)';

/**
 * Was ein Loeschen jetzt betreffen wuerde - fuer die Rueckfrage.
 * @param {{timezone:string, outputDir:string}} options
 */
async function preview({ timezone, outputDir }) {
  const period = currentPeriod(timezone);
  const range = { start: period.start.toISOString(), end: period.end.toISOString() };
  const sessions = db().prepare(
    `SELECT COUNT(*) AS c, ROUND(COALESCE(SUM(energy_kwh), 0), 3) AS kwh FROM charging_sessions WHERE ${IN_PERIOD}`
  ).get(range);
  const runs = db().prepare('SELECT COUNT(*) AS c FROM report_runs WHERE period_key = ?').get(period.key);

  return {
    period: { key: period.key, label: period.label },
    sessionCount: sessions.c,
    energyKwh: sessions.kwh,
    reportRunCount: runs.c,
    fileCount: (await filesOfPeriod(outputDir, period.key)).length,
  };
}

/**
 * Loescht die Daten des laufenden Monats. Die Pruefungen (Rolle, Passwort,
 * Bestaetigung, richtiger Monat) liegen bewusst beim Aufrufer - hier wird nur
 * ausgefuehrt.
 *
 * @param {{timezone:string, outputDir:string}} options
 */
async function purgeCurrentMonth({ timezone, outputDir }) {
  const period = currentPeriod(timezone);
  const range = { start: period.start.toISOString(), end: period.end.toISOString() };

  const counts = transaction(() => ({
    sessions: db().prepare(`DELETE FROM charging_sessions WHERE ${IN_PERIOD}`).run(range).changes,
    reportRuns: db().prepare('DELETE FROM report_runs WHERE period_key = ?').run(period.key).changes,
  }));

  // Dateien NACH der Datenbank: scheitert das Loeschen einer Datei, sind die
  // Daten trotzdem weg, und die Datei laesst sich von Hand entfernen. Die
  // umgekehrte Reihenfolge haette bei einem Fehler Daten ohne Beleg hinterlassen.
  let files = 0;
  for (const name of await filesOfPeriod(outputDir, period.key)) {
    try {
      await fs.unlink(path.join(outputDir, name));
      files += 1;
    } catch (error) {
      logger.warn(`Datei ${name} nicht löschbar: ${error.message}`);
    }
  }

  logger.warn(`Daten für ${period.label} gelöscht: ${counts.sessions} Ladevorgänge, `
    + `${counts.reportRuns} Berichtsläufe, ${files} Dateien.`);
  return { period: { key: period.key, label: period.label }, ...counts, files };
}

module.exports = { currentPeriod, preview, purgeCurrentMonth };
