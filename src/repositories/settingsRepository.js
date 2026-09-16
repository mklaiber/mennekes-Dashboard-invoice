'use strict';

/**
 * Einstellungen und RFID-Zuordnung in SQLite.
 *
 * Loest den frueheren JSON-Dateispeicher ab. Die oeffentliche Schnittstelle
 * (load/save/rfidLookup/normalizeRfid) bleibt bewusst gleich, damit Billing,
 * PDF, Mailer und Scheduler unveraendert weiterarbeiten.
 *
 * Aufteilung:
 *  - `settings`      Key/Value mit JSON je Zweig (billing, mail, wallbox, scheduler)
 *  - `rfid_mappings` eigene Tabelle, damit die normalisierte ID eindeutig sein kann
 */

const fs = require('fs');
const { db, now, transaction } = require('../db');
const config = require('../config');
const logger = require('../utils/logger');

/** Zweige, die als JSON in `settings` liegen. */
const BRANCHES = ['wallbox', 'billing', 'mail', 'scheduler'];

/**
 * Normalisiert RFID-IDs, damit "AA:BB:CC", "aabbcc" und "AA-BB-CC" identisch sind.
 * @param {string} rfid
 * @returns {string}
 */
function normalizeRfid(rfid) {
  return String(rfid || '').replace(/[\s:_-]/g, '').toLowerCase();
}

/** Werksseitige Defaults, mit ENV-Startwerten vorbelegt. */
function defaultSettings() {
  return {
    wallbox: {
      baseUrl: config.mennekes.baseUrl,
      displayName: 'MENNEKES Wallbox',
    },
    billing: {
      pricePerKwh: Number.isFinite(config.billing.pricePerKwh) ? config.billing.pricePerKwh : 0.3,
      currency: config.billing.currency,
      locale: config.billing.locale,
      timezone: config.billing.timezone,
      companyName: config.billing.companyName,
      employeeName: config.billing.employeeName,
      vehiclePlate: config.billing.vehiclePlate,
      logoUrl: config.billing.logoUrl || '',
      footerNote:
        'Erstellt gemäß der Regelung zur Abrechnung dienstlicher Ladevorgänge am privaten Hausanschluss.',
      // Druckränder des PDF in Millimetern (DIN-5008-nah, Lochrand links).
      margins: { top: 20, right: 20, bottom: 20, left: 25 },
    },
    mail: {
      from: config.mail.from,
      to: config.mail.to,
      cc: config.mail.cc,
      subjectPrefix: config.mail.subjectPrefix,
    },
    rfidMappings: [],
    scheduler: {
      enabled: config.scheduler.enabled,
      cronExpression: config.scheduler.cronExpression,
      runPolicy: config.scheduler.runPolicy,
    },
  };
}

/** Rekursives Merge: gespeicherte Werte gewinnen, fehlende kommen aus den Defaults. */
function mergeDeep(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = mergeDeep(base[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/** In-Memory-Cache: Einstellungen werden pro Request mehrfach gelesen. */
let cache = null;

/** Cache verwerfen. */
function reset() {
  cache = null;
}

/**
 * Laedt die Einstellungen.
 * @param {{force?:boolean}} [options]
 * @returns {object}
 */
function load({ force = false } = {}) {
  if (cache && !force) return cache;

  const stored = {};
  for (const row of db().prepare('SELECT key, value FROM settings').all()) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // Ein defekter Zweig darf nicht die gesamte Anwendung lahmlegen.
      logger.error(`Einstellungszweig "${row.key}" ist kein gültiges JSON - wird ignoriert.`);
    }
  }

  const merged = mergeDeep(defaultSettings(), stored);
  merged.rfidMappings = listRfidMappings();
  cache = merged;
  return cache;
}

/**
 * Speichert eine Teiländerung.
 * @param {object} patch
 * @param {{userId?:number}} [options]
 * @returns {object} neuer Gesamtstand
 */
function save(patch, options = {}) {
  const current = load();

  transaction(() => {
    for (const branch of BRANCHES) {
      if (patch[branch] === undefined) continue;
      const merged = mergeDeep(current[branch] || {}, patch[branch]);
      db().prepare(`
        INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                       updated_at = excluded.updated_at,
                                       updated_by = excluded.updated_by
      `).run(branch, JSON.stringify(merged), now(), options.userId ?? null);
    }

    if (Array.isArray(patch.rfidMappings)) replaceRfidMappings(patch.rfidMappings);
  });

  reset();
  logger.info('Einstellungen gespeichert.');
  return load();
}

// ---------------------------------------------------------------- RFID-Karten

/** @returns {Array<{rfid:string, rfidRaw:string, name:string, plate:string, billable:boolean}>} */
function listRfidMappings() {
  return db().prepare(`
    SELECT rfid, rfid_raw AS rfidRaw, name, plate, billable
      FROM rfid_mappings ORDER BY name COLLATE NOCASE, rfid
  `).all().map((row) => ({ ...row, billable: Boolean(row.billable) }));
}

/**
 * Ersetzt die Zuordnung vollstaendig durch die uebergebene Liste.
 * Ein reines UPSERT wuerde entfernte Karten stehen lassen.
 * @param {Array<object>} mappings
 */
function replaceRfidMappings(mappings) {
  const rows = [];
  const seen = new Set();

  for (const entry of mappings) {
    if (!entry || !entry.rfid) continue;
    const raw = String(entry.rfid).trim();
    if (!raw) continue;

    const normalized = normalizeRfid(raw);
    // Zwei Schreibweisen derselben Karte in einem Formular: die erste gewinnt,
    // sonst schlaegt das UNIQUE beim Einfuegen fehl.
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    rows.push({
      rfid: normalized,
      rfidRaw: raw.slice(0, 64),
      name: String(entry.name || '').trim().slice(0, 120),
      plate: String(entry.plate || '').trim().slice(0, 32),
      billable: entry.billable === false ? 0 : 1,
    });
  }

  db().prepare('DELETE FROM rfid_mappings').run();
  const insert = db().prepare(`
    INSERT INTO rfid_mappings (rfid, rfid_raw, name, plate, billable, created_at, updated_at)
    VALUES (@rfid, @rfidRaw, @name, @plate, @billable, @ts, @ts)
  `);
  const ts = now();
  for (const row of rows) insert.run({ ...row, ts });
}

/**
 * Lookup-Map fuer die Abrechnung.
 * @param {Array<object>} [mappings]
 * @returns {Map<string, object>}
 */
function rfidLookup(mappings) {
  const source = mappings || listRfidMappings();
  const map = new Map();
  for (const entry of source) {
    if (!entry || !entry.rfid) continue;
    map.set(normalizeRfid(entry.rfid), entry);
  }
  return map;
}

// ------------------------------------------------------------------ Migration

/**
 * Uebernimmt eine vorhandene settings.json einmalig in die Datenbank.
 * Laeuft nur, solange in der Datenbank noch nichts gespeichert wurde.
 *
 * @param {string} [file]
 * @returns {boolean} true, wenn migriert wurde
 */
function migrateFromJsonFile(file = config.server.settingsFile) {
  const alreadyStored = db().prepare('SELECT COUNT(*) AS n FROM settings').get().n > 0;
  if (alreadyStored || !fs.existsSync(file)) return false;

  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    logger.error(`settings.json konnte nicht gelesen werden (${error.message}) - Migration übersprungen.`);
    return false;
  }

  save({
    wallbox: stored.wallbox,
    billing: stored.billing,
    mail: stored.mail,
    scheduler: stored.scheduler,
    rfidMappings: Array.isArray(stored.rfidMappings) ? stored.rfidMappings : [],
  });

  // Die Datei bleibt als .migrated liegen: ein automatisches Loeschen waere
  // bei einem Rollback auf die Dateiversion nicht mehr rueckgaengig zu machen.
  try {
    fs.renameSync(file, `${file}.migrated`);
  } catch (error) {
    logger.warn(`settings.json konnte nicht umbenannt werden: ${error.message}`);
  }

  logger.info(`Einstellungen aus ${file} in die Datenbank übernommen.`);
  return true;
}

module.exports = {
  load, save, reset, defaultSettings, mergeDeep,
  rfidLookup, normalizeRfid, listRfidMappings, replaceRfidMappings,
  migrateFromJsonFile, BRANCHES,
};
