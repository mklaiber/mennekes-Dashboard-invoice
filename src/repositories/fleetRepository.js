'use strict';

/**
 * Firmen und Fahrzeuge eines Privathaushalts.
 *
 * Die Beziehung ist bewusst schmal: eine Firma hat mindestens ein Auto, ein
 * Auto gehoert privat oder zu genau einer Firma, ein Auto hat seine Karten.
 * "Privat" ist dabei KEINE Firma, sondern schlicht das Fehlen einer - sonst
 * gaebe es zwei Schreibweisen fuer denselben Sachverhalt.
 *
 * Wer faehrt, ist ein Name am Auto und kein eigener Stammdatensatz: fuer
 * einen Haushalt mit ein paar Dienstwagen waere eine Mitarbeiterverwaltung
 * Ballast.
 */

const { db, now, transaction } = require('../db');
const logger = require('../utils/logger');

const text = (value, max) => String(value ?? '').trim().slice(0, max);

// ------------------------------------------------------------------- Firmen

function toCompany(row) {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    contactEmail: row.contactEmail,
    // null heisst ausdruecklich "globaler Arbeitspreis", nicht "0".
    pricePerKwh: row.pricePerKwh === null ? null : Number(row.pricePerKwh),
    ownReport: Boolean(row.ownReport),
    active: Boolean(row.active),
  };
}

const COMPANY_COLUMNS = `
  id, name, address,
  contact_email  AS contactEmail,
  price_per_kwh  AS pricePerKwh,
  own_report     AS ownReport,
  active
`;

/** @param {{includeInactive?:boolean}} [options] */
function listCompanies({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db().prepare(`
    SELECT ${COMPANY_COLUMNS} FROM companies ${where}
    ORDER BY name COLLATE NOCASE
  `).all().map(toCompany);
}

function findCompany(id) {
  const row = db().prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = ?`).get(id);
  return row ? toCompany(row) : null;
}

function createCompany(input) {
  const ts = now();
  const result = db().prepare(`
    INSERT INTO companies (name, address, contact_email, price_per_kwh, own_report, active, created_at, updated_at)
    VALUES (@name, @address, @contactEmail, @pricePerKwh, @ownReport, 1, @ts, @ts)
  `).run({
    name: text(input.name, 160),
    address: text(input.address, 400),
    contactEmail: text(input.contactEmail, 200),
    pricePerKwh: Number.isFinite(input.pricePerKwh) ? input.pricePerKwh : null,
    ownReport: input.ownReport === false ? 0 : 1,
    ts,
  });
  return findCompany(result.lastInsertRowid);
}

function updateCompany(id, patch) {
  const current = findCompany(id);
  if (!current) return null;
  const merged = { ...current, ...patch };
  db().prepare(`
    UPDATE companies
       SET name = @name, address = @address, contact_email = @contactEmail,
           price_per_kwh = @pricePerKwh, own_report = @ownReport, active = @active, updated_at = @ts
     WHERE id = @id
  `).run({
    id,
    name: text(merged.name, 160),
    address: text(merged.address, 400),
    contactEmail: text(merged.contactEmail, 200),
    pricePerKwh: Number.isFinite(merged.pricePerKwh) ? merged.pricePerKwh : null,
    ownReport: merged.ownReport ? 1 : 0,
    active: merged.active === false ? 0 : 1,
    ts: now(),
  });
  return findCompany(id);
}

// ----------------------------------------------------------------- Fahrzeuge

const VEHICLE_COLUMNS = `
  v.id, v.plate, v.label, v.notes, v.active,
  v.company_id    AS companyId,
  v.employee_name AS employeeName,
  c.name AS companyName
`;

function toVehicle(row, cards = []) {
  return {
    id: row.id,
    plate: row.plate,
    label: row.label,
    notes: row.notes,
    active: Boolean(row.active),
    companyId: row.companyId,
    companyName: row.companyName || '',
    // Kein Firmenbezug heisst privat - einen dritten Fall gibt es nicht.
    isPrivate: row.companyId === null,
    employeeName: row.employeeName || '',
    cards,
  };
}

/** Karten je Fahrzeug, damit die Liste nicht N+1 Abfragen ausloest. */
function cardsByVehicle() {
  const map = new Map();
  for (const row of db().prepare(`
    SELECT vehicle_id AS vehicleId, rfid, rfid_raw AS rfidRaw, name, billable
      FROM rfid_mappings WHERE vehicle_id IS NOT NULL ORDER BY rfid
  `).all()) {
    if (!map.has(row.vehicleId)) map.set(row.vehicleId, []);
    map.get(row.vehicleId).push({
      rfid: row.rfid, rfidRaw: row.rfidRaw, name: row.name, billable: Boolean(row.billable),
    });
  }
  return map;
}

function listVehicles({ includeInactive = false, companyId = null } = {}) {
  const clauses = [];
  if (!includeInactive) clauses.push('v.active = 1');
  if (companyId !== null) clauses.push('v.company_id = @companyId');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const cards = cardsByVehicle();
  return db().prepare(`
    SELECT ${VEHICLE_COLUMNS}
      FROM vehicles v
      LEFT JOIN companies c ON c.id = v.company_id
      ${where} ORDER BY v.plate COLLATE NOCASE
  `).all({ companyId }).map((row) => toVehicle(row, cards.get(row.id) || []));
}

function findVehicle(id) {
  const row = db().prepare(`
    SELECT ${VEHICLE_COLUMNS}
      FROM vehicles v
      LEFT JOIN companies c ON c.id = v.company_id
     WHERE v.id = ?
  `).get(id);
  if (!row) return null;
  return toVehicle(row, cardsByVehicle().get(row.id) || []);
}

function createVehicle(input) {
  const ts = now();
  const result = db().prepare(`
    INSERT INTO vehicles (plate, label, company_id, employee_name, notes, active, created_at, updated_at)
    VALUES (@plate, @label, @companyId, @employeeName, @notes, 1, @ts, @ts)
  `).run({
    plate: text(input.plate, 32),
    label: text(input.label, 120),
    companyId: input.companyId || null,
    employeeName: text(input.employeeName, 120),
    notes: text(input.notes, 400),
    ts,
  });
  return findVehicle(result.lastInsertRowid);
}

function updateVehicle(id, patch) {
  const current = findVehicle(id);
  if (!current) return null;
  const merged = { ...current, ...patch };
  db().prepare(`
    UPDATE vehicles
       SET plate = @plate, label = @label, company_id = @companyId,
           employee_name = @employeeName, notes = @notes, active = @active, updated_at = @ts
     WHERE id = @id
  `).run({
    id,
    plate: text(merged.plate, 32),
    label: text(merged.label, 120),
    companyId: merged.companyId || null,
    employeeName: text(merged.employeeName, 120),
    notes: text(merged.notes, 400),
    active: merged.active === false ? 0 : 1,
    ts: now(),
  });
  return findVehicle(id);
}

// --------------------------------------------------- Laden ohne Karte

/**
 * IdTags, die Wallboxen beim freien Laden ohne RFID melden. Sie sind keine
 * Karte: gelesen wurde gar nichts, die Wallbox traegt einen festen Wert ein.
 * Beobachtet an einer MENNEKES-Wallbox im Modbus-Betrieb (2026-09-23), dort
 * zweimal bei Testladungen ohne Karte.
 *
 * Die Liste greift nur, solange fuer die IdTag keine ausdrueckliche Angabe
 * vorliegt - wer hier falsch liegt, stellt es in der Oberflaeche um.
 */
const FREE_CHARGING_TAGS = new Set(['aaaabbbbccccddddeeee']);

/**
 * @param {string} rfid normalisiert
 * @param {'card'|'free'|null} [kind] ausdrueckliche Angabe an der Karte
 */
function isFreeCharging(rfid, kind = null) {
  if (kind === 'free') return true;
  if (kind === 'card') return false;
  return FREE_CHARGING_TAGS.has(rfid);
}

/** @returns {'card'|'free'|null} ausdrueckliche Angabe, falls vorhanden */
function cardKind(rfid) {
  const row = db().prepare('SELECT kind FROM rfid_mappings WHERE rfid = ?').get(rfid);
  return row ? row.kind : null;
}

/**
 * Legt fest, ob eine IdTag eine echte Karte ist oder "Laden ohne Karte".
 * @param {string} rfid
 * @param {'card'|'free'} kind
 */
function setCardKind(rfid, kind) {
  const value = kind === 'free' ? 'free' : 'card';
  const ts = now();
  const updated = db().prepare(
    'UPDATE rfid_mappings SET kind = ?, updated_at = ? WHERE rfid = ?'
  ).run(value, ts, rfid);
  if (updated.changes === 0) {
    db().prepare(`
      INSERT INTO rfid_mappings (rfid, rfid_raw, name, plate, billable, vehicle_id, kind, created_at, updated_at)
      VALUES (@rfid, @rfid, '', '', 1, NULL, @kind, @ts, @ts)
    `).run({ rfid, kind: value, ts });
  }
}

/**
 * Alle bekannten Ladekarten mit ihrem Fahrzeug und ihrer Aktivitaet.
 *
 * Die Liste vereint zwei Quellen: eingetragene Zuordnungen und Karten, die
 * bisher nur in Ladevorgaengen aufgetaucht sind. Frueher standen diese
 * getrennt - bekannte Karten in den Einstellungen, unbekannte im Fuhrpark -
 * und man musste zwischen zwei Seiten wechseln, um eine Karte umzubuchen.
 *
 * `openSessionCount` ist die Zahl der Ladevorgaenge dieser Karte OHNE
 * Zuordnung: genau die, die eine rueckwirkende Uebernahme betreffen wuerde.
 *
 * @returns {Array<object>} nicht zugeordnete Karten zuerst
 */
function listCards() {
  return db().prepare(`
    SELECT c.rfid,
           MAX(c.rfidRaw)                AS rfidRaw,
           -- COALESCE, nicht blosses MAX: der Ladevorgang-Zweig unten steuert
           -- NULL bei, damit er die Einstellung der Karte nicht ueberstimmt.
           -- Eine Karte, die es nur als Ladevorgang gibt, gilt als abrechenbar.
           COALESCE(MAX(c.billable), 1)  AS billable,
           MAX(c.known)                  AS known,
           MAX(c.kind)                   AS kind,
           MAX(c.vehicleId)              AS vehicleId,
           MAX(c.plate)                  AS vehiclePlate,
           MAX(c.employeeName)           AS employeeName,
           MAX(c.companyName)            AS companyName,
           COALESCE(SUM(c.isSession), 0) AS sessionCount,
           ROUND(COALESCE(SUM(c.kwh), 0), 3) AS energyKwh,
           MAX(c.startAt)                AS lastSeenAt,
           COALESCE(SUM(c.isOpen), 0)    AS openSessionCount
      FROM (
        SELECT m.rfid, m.rfid_raw AS rfidRaw, m.billable, 1 AS known, m.kind,
               v.id AS vehicleId, v.plate, v.employee_name AS employeeName,
               co.name AS companyName,
               0 AS isSession, 0 AS kwh, NULL AS startAt, 0 AS isOpen
          FROM rfid_mappings m
          LEFT JOIN vehicles  v  ON v.id = m.vehicle_id
          LEFT JOIN companies co ON co.id = v.company_id
        UNION ALL
        SELECT s.rfid, s.rfid_raw, NULL, 0, NULL,
               NULL, NULL, NULL, NULL,
               1, s.energy_kwh, s.start_at,
               CASE WHEN s.vehicle_id IS NULL THEN 1 ELSE 0 END
          FROM charging_sessions s
      ) c
     GROUP BY c.rfid
     ORDER BY (MAX(c.vehicleId) IS NOT NULL), c.rfid
  `).all().map((row) => ({
    ...row,
    billable: Boolean(row.billable),
    known: Boolean(row.known),
    kind: row.kind || null,
    isFreeCharging: isFreeCharging(row.rfid, row.kind || null),
    assigned: row.vehicleId !== null,
    vehiclePlate: row.vehiclePlate || '',
    employeeName: row.employeeName || '',
    companyName: row.companyName || '',
  }));
}

/**
 * Schaltet, ob eine Karte abgerechnet wird.
 *
 * Nicht abrechenbar heisst: der Ladevorgang bleibt sichtbar und zaehlt zur
 * Energie, taucht aber nicht in der Kostensumme auf - etwa ein Besuchsauto,
 * das der Arbeitgeber nicht erstattet.
 *
 * @param {string} rfid
 * @param {boolean} billable
 * @returns {boolean} true, wenn die Karte existierte
 */
function setCardBillable(rfid, billable) {
  const result = db().prepare(
    'UPDATE rfid_mappings SET billable = ?, updated_at = ? WHERE rfid = ?'
  ).run(billable ? 1 : 0, now(), rfid);

  if (result.changes === 0) {
    // Karte war bisher nur in Ladevorgaengen sichtbar.
    const ts = now();
    db().prepare(`
      INSERT INTO rfid_mappings (rfid, rfid_raw, name, plate, billable, vehicle_id, created_at, updated_at)
      VALUES (@rfid, @rfid, '', '', @billable, NULL, @ts, @ts)
    `).run({ rfid, billable: billable ? 1 : 0, ts });
  }
  return true;
}

// ------------------------------------------------------- Karten zuordnen

/**
 * Karten, die in Ladevorgaengen aufgetaucht sind, aber zu keinem Fahrzeug
 * gehoeren. Genau diese Liste verhindert, dass ein Ladevorgang unbemerkt als
 * "Unbekannt (a1b2c3)" in einer Rechnung landet.
 *
 * @returns {Array<{rfid:string, rfidRaw:string, sessionCount:number, energyKwh:number, lastSeenAt:string, known:boolean}>}
 */
function listUnassignedCards() {
  return db().prepare(`
    SELECT s.rfid,
           MAX(s.rfid_raw)                         AS rfidRaw,
           COUNT(*)                                AS sessionCount,
           ROUND(SUM(s.energy_kwh), 3)             AS energyKwh,
           MAX(s.start_at)                         AS lastSeenAt,
           MAX(CASE WHEN m.rfid IS NULL THEN 0 ELSE 1 END) AS known
      FROM charging_sessions s
      LEFT JOIN rfid_mappings m ON m.rfid = s.rfid
     WHERE s.vehicle_id IS NULL
     GROUP BY s.rfid
     ORDER BY lastSeenAt DESC
  `).all().map((row) => ({ ...row, known: Boolean(row.known) }));
}

/**
 * Ordnet eine Karte einem Fahrzeug zu.
 *
 * `backfill` traegt die bisher NICHT zugeordneten Ladevorgaenge dieser Karte
 * nachtraeglich ein. Bewusst eine ausdrueckliche Entscheidung des Benutzers
 * und keine Automatik: bereits zugeordnete Vorgaenge bleiben unangetastet,
 * sonst schriebe eine Umbuchung rueckwirkend fertige Rechnungen um.
 *
 * @param {string} rfid normalisierte Karten-ID
 * @param {number|null} vehicleId
 * @param {{backfill?:boolean}} [options]
 * @returns {{assigned:boolean, backfilled:number}}
 */
function assignCardToVehicle(rfid, vehicleId, { backfill = false } = {}) {
  const vehicle = vehicleId ? findVehicle(vehicleId) : null;
  if (vehicleId && !vehicle) return { assigned: false, backfilled: 0 };

  return transaction(() => {
    const ts = now();
    const updated = db().prepare(`
      UPDATE rfid_mappings SET vehicle_id = @vehicleId, updated_at = @ts WHERE rfid = @rfid
    `).run({ rfid, vehicleId: vehicleId || null, ts });

    // Eine Karte, die bisher nur in Ladevorgaengen auftauchte, gibt es als
    // Zuordnung noch gar nicht - dann hier anlegen.
    if (updated.changes === 0 && vehicleId) {
      db().prepare(`
        INSERT INTO rfid_mappings (rfid, rfid_raw, name, plate, billable, vehicle_id, created_at, updated_at)
        VALUES (@rfid, @rfid, '', '', 1, @vehicleId, @ts, @ts)
      `).run({ rfid, vehicleId, ts });
    }

    let backfilled = 0;
    if (backfill && vehicle) {
      backfilled = db().prepare(`
        UPDATE charging_sessions
           SET vehicle_id    = @vehicleId,
               company_id    = @companyId,
               vehicle_plate = @plate,
               company_name  = @companyName,
               employee_name = @employeeName
         WHERE rfid = @rfid AND vehicle_id IS NULL
      `).run({
        rfid,
        vehicleId: vehicle.id,
        companyId: vehicle.companyId,
        plate: vehicle.plate,
        companyName: vehicle.companyName,
        employeeName: vehicle.employeeName,
      }).changes;
    }

    logger.info(
      `Karte ${rfid} ${vehicleId ? `dem Fahrzeug ${vehicle.plate} zugeordnet` : 'geloest'}`
      + (backfilled ? ` - ${backfilled} bisher nicht zugeordnete Ladevorgang/Ladevorgaenge uebernommen.` : '.')
    );
    return { assigned: true, backfilled };
  });
}

/**
 * Loest die Zuordnung einer Karte zum Fahrzeug auf, das sie liefert.
 * Wird beim Eintreffen eines Ladevorgangs benutzt, um die Zuordnung
 * einzufrieren.
 *
 * @param {string} rfid
 * @returns {{vehicleId:number|null, companyId:number|null,
 *            vehiclePlate:string, companyName:string, employeeName:string}}
 */
function resolveAttribution(rfid) {
  const empty = {
    vehicleId: null, companyId: null,
    vehiclePlate: '', companyName: '', employeeName: '',
  };
  if (!rfid) return empty;

  const row = db().prepare(`
    SELECT v.id AS vehicleId, v.plate AS vehiclePlate,
           v.company_id AS companyId,
           COALESCE(c.name, '') AS companyName,
           COALESCE(v.employee_name, '') AS employeeName
      FROM rfid_mappings m
      JOIN vehicles v   ON v.id = m.vehicle_id
      LEFT JOIN companies c ON c.id = v.company_id
     WHERE m.rfid = ?
  `).get(rfid);

  return row || empty;
}

module.exports = {
  listCompanies, findCompany, createCompany, updateCompany,
  listVehicles, findVehicle, createVehicle, updateVehicle,
  cardsByVehicle, listCards, listUnassignedCards, assignCardToVehicle, resolveAttribution,
  setCardBillable, isFreeCharging, cardKind, setCardKind, FREE_CHARGING_TAGS,
};
