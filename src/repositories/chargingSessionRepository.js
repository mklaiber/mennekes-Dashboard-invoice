'use strict';

/**
 * Ladevorgänge, die der Connector aus dem Heimnetz liefert.
 *
 * Die Wallbox selbst ist von außen nicht erreichbar - deshalb ist diese Tabelle
 * im Connector-Betrieb die einzige Quelle für die Abrechnung. Entsprechend
 * vorsichtig: ein Datensatz wird nie verdoppelt, und der Rohdatensatz bleibt
 * erhalten, damit sich eine Abweichung später nachvollziehen lässt.
 */

const { db, now, transaction } = require('../db');
const logger = require('../utils/logger');
const fleet = require('./fleetRepository');

/** Wandelt eine Datenbankzeile in das Format, das die Abrechnung erwartet. */
function toSession(row) {
  return {
    id: row.id,
    start: new Date(row.startAt),
    end: row.endAt ? new Date(row.endAt) : null,
    durationSeconds: row.durationSeconds,
    energyKwh: row.energyKwh,
    rfid: row.rfid,
    rfidRaw: row.rfidRaw || null,
    meterStartKwh: row.meterStartKwh,
    meterEndKwh: row.meterEndKwh,
    // Beim Eintreffen eingefrorene Zuordnung. Klartext und ID: die ID fuer
    // Filter und Verknuepfung, der Klartext, damit ein geloeschter
    // Stammdatensatz eine alte Rechnung nicht unleserlich macht.
    vehicleId: row.vehicleId ?? null,
    companyId: row.companyId ?? null,
    vehiclePlate: row.vehiclePlate || '',
    companyName: row.companyName || '',
    employeeName: row.employeeName || '',
  };
}

const SELECT_COLUMNS = `
  id, start_at AS startAt, end_at AS endAt, duration_seconds AS durationSeconds,
  energy_kwh AS energyKwh, rfid, rfid_raw AS rfidRaw,
  meter_start_kwh AS meterStartKwh, meter_end_kwh AS meterEndKwh,
  source, received_at AS receivedAt,
  vehicle_id AS vehicleId, company_id AS companyId,
  vehicle_plate AS vehiclePlate, company_name AS companyName, employee_name AS employeeName
`;

/**
 * Nimmt Ladevorgänge entgegen.
 *
 * Bereits bekannte IDs werden aktualisiert statt eingefügt: der Connector darf
 * denselben Vorgang gefahrlos erneut senden, etwa nach einem Verbindungsabbruch
 * oder wenn die Wallbox einen laufenden Vorgang nachträglich abschließt.
 *
 * @param {Array<object>} sessions normalisierte Vorgänge (siehe MennekesClient.normalizeSession)
 * @param {{source?:string}} [options]
 * @returns {{accepted:number, inserted:number, updated:number, rejected:Array<{id:string, reason:string}>}}
 */
function upsertMany(sessions, options = {}) {
  const source = options.source || 'connector';
  const rejected = [];
  const valid = [];

  for (const session of sessions || []) {
    const problem = validate(session);
    if (problem) {
      rejected.push({ id: String(session?.id ?? '?'), reason: problem });
      continue;
    }
    valid.push(session);
  }

  let inserted = 0;
  let updated = 0;

  if (valid.length > 0) {
    const exists = db().prepare('SELECT 1 FROM charging_sessions WHERE id = ?');
    // Die Zuordnung wird beim Eintreffen aufgeloest und auf dem Datensatz
    // festgeschrieben - IDs und Klartext. Wuerde sie stattdessen beim
    // Abrechnen nachgeschlagen, aenderte jede spaetere Umbuchung rueckwirkend
    // bereits gestellte Rechnungen, und eine geloeschte Firma zerlegte den
    // Vorjahresbeleg.
    //
    // Beim erneuten Senden desselben Vorgangs bleibt eine bereits gesetzte
    // Zuordnung unangetastet (COALESCE/CASE unten). Eine noch LEERE wird
    // dagegen nachgetragen: war die Karte bei der ersten Lieferung noch
    // keinem Fahrzeug zugeordnet und ist sie es inzwischen, profitiert der
    // Vorgang davon, ohne dass jemand von Hand nacharbeiten muss.
    const upsert = db().prepare(`
      INSERT INTO charging_sessions
        (id, start_at, end_at, duration_seconds, energy_kwh, rfid, rfid_raw,
         meter_start_kwh, meter_end_kwh, source, received_at, payload,
         vehicle_id, company_id, vehicle_plate, company_name, employee_name)
      VALUES
        (@id, @startAt, @endAt, @durationSeconds, @energyKwh, @rfid, @rfidRaw,
         @meterStartKwh, @meterEndKwh, @source, @receivedAt, @payload,
         @vehicleId, @companyId, @vehiclePlate, @companyName, @employeeName)
      ON CONFLICT(id) DO UPDATE SET
        start_at         = excluded.start_at,
        end_at           = excluded.end_at,
        duration_seconds = excluded.duration_seconds,
        energy_kwh       = excluded.energy_kwh,
        rfid             = excluded.rfid,
        rfid_raw         = excluded.rfid_raw,
        meter_start_kwh  = excluded.meter_start_kwh,
        meter_end_kwh    = excluded.meter_end_kwh,
        received_at      = excluded.received_at,
        payload          = excluded.payload,
        vehicle_id    = COALESCE(charging_sessions.vehicle_id,  excluded.vehicle_id),
        company_id    = COALESCE(charging_sessions.company_id,  excluded.company_id),
        vehicle_plate = CASE WHEN charging_sessions.vehicle_id IS NULL
                             THEN excluded.vehicle_plate ELSE charging_sessions.vehicle_plate END,
        company_name  = CASE WHEN charging_sessions.vehicle_id IS NULL
                             THEN excluded.company_name  ELSE charging_sessions.company_name  END,
        employee_name = CASE WHEN charging_sessions.vehicle_id IS NULL
                             THEN excluded.employee_name ELSE charging_sessions.employee_name END
    `);

    transaction(() => {
      const timestamp = now();
      for (const session of valid) {
        if (exists.get(session.id)) updated += 1;
        else inserted += 1;

        const rfid = String(session.rfid || 'unbekannt');
        const attribution = fleet.resolveAttribution(rfid);

        upsert.run({
          ...attribution,
          id: String(session.id),
          startAt: new Date(session.start).toISOString(),
          endAt: session.end ? new Date(session.end).toISOString() : null,
          durationSeconds: Math.max(0, Math.round(Number(session.durationSeconds) || 0)),
          energyKwh: Number(session.energyKwh),
          rfid,
          rfidRaw: String(session.rfidRaw || ''),
          meterStartKwh: session.meterStartKwh ?? null,
          meterEndKwh: session.meterEndKwh ?? null,
          source,
          receivedAt: timestamp,
          payload: session.payload ? JSON.stringify(session.payload).slice(0, 4000) : '',
        });
      }
    });
  }

  if (rejected.length > 0) {
    logger.warn(`${rejected.length} Ladevorgang/Ladevorgänge abgewiesen: ${rejected.map((r) => r.reason).join(', ')}`);
  }

  return { accepted: valid.length, inserted, updated, rejected };
}

/**
 * Prüft einen eingehenden Datensatz.
 * @param {object} session
 * @returns {string|null} Grund der Ablehnung oder null
 */
function validate(session) {
  if (!session || typeof session !== 'object') return 'kein Objekt';
  if (!session.id) return 'ohne ID';

  const start = new Date(session.start);
  if (Number.isNaN(start.getTime())) return `ungültiger Start (${session.id})`;

  const energy = Number(session.energyKwh);
  if (!Number.isFinite(energy) || energy < 0) return `ungültige Energiemenge (${session.id})`;
  // Eine Heim-Wallbox lädt mit höchstens 22 kW; mehr als 2000 kWh in einem
  // einzelnen Vorgang ist kein Messwert, sondern ein Einheitenfehler.
  if (energy > 2000) return `unplausible Energiemenge (${session.id}: ${energy} kWh)`;

  if (session.end) {
    const end = new Date(session.end);
    if (Number.isNaN(end.getTime())) return `ungültiges Ende (${session.id})`;
    if (end < start) return `Ende vor Beginn (${session.id})`;
  }

  return null;
}

/**
 * Ladevorgänge im Zeitraum [from, to).
 * @param {Date} from inklusiv
 * @param {Date} to exklusiv
 * @returns {Array<object>} im Format der Abrechnung
 */
function findInRange(from, to) {
  return db().prepare(`
    SELECT ${SELECT_COLUMNS}
      FROM charging_sessions
     WHERE start_at >= ? AND start_at < ?
     ORDER BY start_at
  `).all(new Date(from).toISOString(), new Date(to).toISOString()).map(toSession);
}

/** @returns {number} Gesamtzahl gespeicherter Vorgänge */
function count() {
  return db().prepare('SELECT COUNT(*) AS n FROM charging_sessions').get().n;
}

/**
 * Kennzahlen für die Betriebsanzeige.
 * @returns {{count:number, firstStart:string|null, lastStart:string|null, lastReceived:string|null}}
 */
function stats() {
  const row = db().prepare(`
    SELECT COUNT(*) AS count,
           MIN(start_at)    AS firstStart,
           MAX(start_at)    AS lastStart,
           MAX(received_at) AS lastReceived
      FROM charging_sessions
  `).get();
  return row;
}

/**
 * Entfernt sehr alte Vorgänge.
 * Standard: alles älter als 36 Monate - lange genug für Nachfragen des
 * Arbeitgebers, kurz genug, dass die Datei nicht unbegrenzt wächst.
 *
 * @param {number} [months=36]
 * @returns {number} Anzahl entfernter Datensätze
 */
function pruneOlderThan(months = 36) {
  const info = db().prepare(
    `DELETE FROM charging_sessions WHERE start_at < datetime('now', ?)`
  ).run(`-${Math.max(1, Math.round(months))} months`);
  return info.changes;
}

module.exports = { upsertMany, findInRange, count, stats, pruneOlderThan, validate };
