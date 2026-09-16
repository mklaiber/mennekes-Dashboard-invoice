'use strict';

/**
 * Persistente, NICHT sensible Laufzeit-Einstellungen.
 *
 * Wird als JSON auf Platte gehalten (Docker-Volume) und über die WebUI gepflegt.
 * Secrets (SMTP-Passwort, API-Token) landen hier bewusst NIE - die kommen ausschließlich aus der ENV.
 */

const fs = require('fs');
const path = require('path');
const config = require('./index');
const logger = require('../utils/logger');

/**
 * @typedef {object} RfidMapping
 * @property {string} rfid   RFID-/Token-ID wie von der Wallbox geliefert
 * @property {string} name   Klartextname (z. B. "Max Mustermann")
 * @property {string} [plate] Kennzeichen
 * @property {boolean} [billable] false => taucht im PDF auf, wird aber nicht dem Arbeitgeber berechnet
 */

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
    },
    mail: {
      from: config.mail.from,
      to: config.mail.to,
      cc: config.mail.cc,
      subjectPrefix: config.mail.subjectPrefix,
    },
    /** @type {RfidMapping[]} */
    rfidMappings: [],
    scheduler: {
      enabled: config.scheduler.enabled,
      cronExpression: config.scheduler.cronExpression,
      runPolicy: config.scheduler.runPolicy,
    },
  };
}

/** Rekursives Merge: gespeicherte Werte gewinnen, fehlende Keys kommen aus den Defaults. */
function mergeDeep(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = mergeDeep(base[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/** In-Memory-Cache, damit nicht bei jedem Request die Platte gelesen wird. */
let cache = null;

/**
 * Lädt die Einstellungen (mit Cache).
 * @param {{force?: boolean}} [opts]
 * @returns {object}
 */
function load({ force = false } = {}) {
  if (cache && !force) return cache;

  const file = config.server.settingsFile;
  let stored = {};
  try {
    if (fs.existsSync(file)) {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (error) {
    // Kaputte Datei darf den Start nicht verhindern - wir fallen auf Defaults zurück.
    logger.error(`settings.json konnte nicht gelesen werden (${error.message}) - nutze Defaults.`);
    stored = {};
  }

  cache = mergeDeep(defaultSettings(), stored);
  return cache;
}

/**
 * Schreibt Einstellungen atomar (tmp + rename), damit ein Crash keine halbe Datei hinterlässt.
 * @param {object} patch Teilobjekt, wird über den aktuellen Stand gemerged.
 * @returns {object} der neue Gesamtstand
 */
function save(patch) {
  const next = mergeDeep(load(), patch);
  const file = config.server.settingsFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  cache = next;
  logger.info('Einstellungen gespeichert.');
  return cache;
}

/** Cache verwerfen (Tests / externe Aenderung der Datei). */
function reset() {
  cache = null;
}

/**
 * Baut aus den RFID-Mappings eine Lookup-Map.
 * @param {RfidMapping[]} [mappings]
 * @returns {Map<string, RfidMapping>} Key = RFID in Kleinbuchstaben ohne Trennzeichen
 */
function rfidLookup(mappings = load().rfidMappings) {
  const map = new Map();
  for (const entry of mappings || []) {
    if (!entry || !entry.rfid) continue;
    map.set(normalizeRfid(entry.rfid), entry);
  }
  return map;
}

/**
 * Normalisiert RFID-IDs, damit "AA:BB:CC", "aabbcc" und "AA-BB-CC" identisch behandelt werden.
 * @param {string} rfid
 * @returns {string}
 */
function normalizeRfid(rfid) {
  return String(rfid || '')
    .replace(/[\s:_-]/g, '')
    .toLowerCase();
}

module.exports = { load, save, reset, defaultSettings, mergeDeep, rfidLookup, normalizeRfid };
