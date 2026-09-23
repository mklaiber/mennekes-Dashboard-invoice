'use strict';

/**
 * Protokoll sicherheitsrelevanter Vorgaenge.
 *
 * Zweck ist Nachvollziehbarkeit: Wer hat sich wann angemeldet, wer hat den
 * Strompreis geaendert, wer hat einen Report versendet. Bewusst schlank -
 * kein Volltext, keine Aufbewahrungslogik ausser der Mengenbegrenzung.
 */

const { db, now } = require('../db');

/** Bekannte Aktionen - als Konstanten, damit sich keine Tippfehler einschleichen. */
const ACTIONS = {
  LOGIN_OK: 'login.success',
  LOGIN_FAILED: 'login.failed',
  LOGOUT: 'logout',
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DELETED: 'user.deleted',
  PASSWORD_CHANGED: 'password.changed',
  SETTINGS_UPDATED: 'settings.updated',
  RFID_UPDATED: 'rfid.updated',
  REPORT_RUN: 'report.run',
  FLEET_COMPANY_CREATED: 'fleet.company.created',
  FLEET_COMPANY_UPDATED: 'fleet.company.updated',
  FLEET_VEHICLE_CREATED: 'fleet.vehicle.created',
  FLEET_VEHICLE_UPDATED: 'fleet.vehicle.updated',
  FLEET_CARD_ASSIGNED: 'fleet.card.assigned',
  FLEET_CARD_LEARNING: 'fleet.card.learning',
  DATA_PURGED: 'data.purged',
  DATA_PURGE_DENIED: 'data.purge.denied',
};

/**
 * Schreibt einen Protokolleintrag.
 * @param {object} entry
 * @param {string} entry.action  eine der ACTIONS
 * @param {object} [entry.user]  {id, username}
 * @param {string} [entry.detail]
 * @param {string} [entry.ip]
 */
function log({ action, user, detail = '', ip = '' }) {
  db().prepare(`
    INSERT INTO audit_log (at, user_id, username, action, detail, ip)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    now(),
    user?.id ?? null,
    String(user?.username ?? '').slice(0, 64),
    action,
    String(detail).slice(0, 500),
    String(ip).slice(0, 64)
  );
}

/**
 * Letzte Eintraege.
 * @param {{limit?:number, action?:string}} [options]
 */
function list({ limit = 100, action } = {}) {
  const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  if (action) {
    return db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY at DESC LIMIT ?').all(action, bounded);
  }
  return db().prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(bounded);
}

/**
 * Begrenzt die Tabelle auf die juengsten Eintraege.
 * Ohne das waechst das Protokoll auf einer Appliance unbegrenzt.
 * @param {number} [keep=5000]
 * @returns {number} Anzahl geloeschter Eintraege
 */
function prune(keep = 5000) {
  const info = db().prepare(`
    DELETE FROM audit_log
     WHERE id NOT IN (SELECT id FROM audit_log ORDER BY at DESC LIMIT ?)
  `).run(keep);
  return info.changes;
}

module.exports = { log, list, prune, ACTIONS };
