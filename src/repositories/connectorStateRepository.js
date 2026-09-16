'use strict';

/**
 * Zustand des Home-Assistant-Connectors.
 *
 * Genau eine Zeile. Beantwortet im Betrieb die wichtigste Frage: meldet sich
 * der Connector noch? Bleibt er aus, ist das Dashboard still - ohne diesen
 * Zeitstempel wäre nicht unterscheidbar, ob gerade nicht geladen wird oder ob
 * die Verbindung ins Heimnetz abgerissen ist.
 */

const { db, now } = require('../db');
const config = require('../config');

/**
 * Vermerkt einen Kontakt des Connectors.
 * @param {object} params
 * @param {object} [params.status] zuletzt gemeldeter Live-Zustand
 * @param {string} [params.version] Version des Connectors
 * @param {string} [params.ip]
 * @param {number} [params.sessionsReceived] Anzahl in diesem Kontakt gelieferter Vorgänge
 */
function touch({ status, version, ip, sessionsReceived = 0 } = {}) {
  db().prepare(`
    UPDATE connector_state
       SET last_seen_at      = ?,
           last_status       = COALESCE(?, last_status),
           connector_version = COALESCE(NULLIF(?, ''), connector_version),
           remote_ip         = COALESCE(NULLIF(?, ''), remote_ip),
           sessions_received = sessions_received + ?
     WHERE id = 1
  `).run(
    now(),
    status === undefined ? null : JSON.stringify(status),
    String(version || '').slice(0, 32),
    String(ip || '').slice(0, 64),
    Math.max(0, Number(sessionsReceived) || 0)
  );
}

/** @returns {object} Rohzustand aus der Datenbank */
function read() {
  const row = db().prepare(`
    SELECT last_seen_at AS lastSeenAt, last_status AS lastStatus,
           connector_version AS version, remote_ip AS remoteIp,
           sessions_received AS sessionsReceived
      FROM connector_state WHERE id = 1
  `).get();

  let status = null;
  if (row?.lastStatus) {
    try {
      status = JSON.parse(row.lastStatus);
    } catch {
      status = null;
    }
  }

  return { ...row, status };
}

/**
 * Aufbereiteter Zustand für Dashboard und Health-Endpunkt.
 * @returns {{connected:boolean, stale:boolean, lastSeenAt:string|null,
 *            secondsSinceLastSeen:number|null, version:string, status:object|null}}
 */
function health() {
  const state = read();
  const lastSeen = state.lastSeenAt ? new Date(state.lastSeenAt) : null;
  const seconds = lastSeen ? Math.round((Date.now() - lastSeen.getTime()) / 1000) : null;

  return {
    connected: seconds !== null && seconds <= config.connector.staleAfterSeconds,
    // "stale" heißt: hat sich schon gemeldet, aber zu lange nicht mehr.
    stale: seconds !== null && seconds > config.connector.staleAfterSeconds,
    lastSeenAt: state.lastSeenAt || null,
    secondsSinceLastSeen: seconds,
    version: state.version || '',
    remoteIp: state.remoteIp || '',
    sessionsReceived: state.sessionsReceived || 0,
    status: state.status,
  };
}

module.exports = { touch, read, health };
