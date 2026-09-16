'use strict';

/**
 * Historie der Abrechnungsläufe.
 *
 * Beantwortet im Betrieb die Fragen, die sonst nur im Log stehen: Ist der
 * Lauf für den Vormonat durchgelaufen? An wen ging die Mail? Warum kam nichts?
 */

const { db, now } = require('../db');

/**
 * Vermerkt den Beginn eines Laufs.
 * @param {{periodKey:string, triggeredBy?:string}} params
 * @returns {number} ID des Laufs
 */
function start({ periodKey, triggeredBy = '' }) {
  const info = db().prepare(`
    INSERT INTO report_runs (period_key, started_at, triggered_by) VALUES (?, ?, ?)
  `).run(periodKey, now(), String(triggeredBy).slice(0, 64));
  return Number(info.lastInsertRowid);
}

/**
 * Schliesst einen Lauf erfolgreich ab.
 * @param {number} id
 * @param {{report:object, files:object, mail:object|null}} result
 */
function finishOk(id, { report, files, mail }) {
  db().prepare(`
    UPDATE report_runs
       SET finished_at = ?, ok = 1, session_count = ?, energy_kwh = ?, cost = ?,
           pdf_file = ?, csv_detail_file = ?, csv_summary_file = ?,
           mail_to = ?, message_id = ?
     WHERE id = ?
  `).run(
    now(),
    report.totals.sessionCount,
    report.totals.energyKwh,
    report.totals.billableCost,
    files?.pdf?.fileName ?? null,
    files?.csvDetail?.fileName ?? null,
    files?.csvSummary?.fileName ?? null,
    mail ? mail.to.join(', ') : '',
    mail ? String(mail.messageId ?? '') : '',
    id
  );
}

/**
 * Vermerkt einen Fehlschlag.
 * @param {number} id
 * @param {string} message
 */
function finishFailed(id, message) {
  db().prepare('UPDATE report_runs SET finished_at = ?, ok = 0, error = ? WHERE id = ?')
    .run(now(), String(message).slice(0, 500), id);
}

/**
 * Letzte Läufe.
 * @param {number} [limit=20]
 */
function list(limit = 20) {
  const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 200);
  return db().prepare(`
    SELECT id, period_key AS periodKey, started_at AS startedAt, finished_at AS finishedAt,
           ok, session_count AS sessionCount, energy_kwh AS energyKwh, cost,
           pdf_file AS pdfFile, csv_detail_file AS csvDetailFile, csv_summary_file AS csvSummaryFile,
           mail_to AS mailTo, message_id AS messageId, error, triggered_by AS triggeredBy
      FROM report_runs ORDER BY started_at DESC LIMIT ?
  `).all(bounded).map((row) => ({ ...row, ok: Boolean(row.ok) }));
}

/**
 * Letzter Lauf für einen Abrechnungsmonat.
 * @param {string} periodKey z. B. "2026-03"
 */
function lastForPeriod(periodKey) {
  const row = db().prepare(`
    SELECT * FROM report_runs WHERE period_key = ? ORDER BY started_at DESC LIMIT 1
  `).get(periodKey);
  return row ? { ...row, ok: Boolean(row.ok) } : null;
}

module.exports = { start, finishOk, finishFailed, list, lastForPeriod };
