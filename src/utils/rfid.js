'use strict';

/**
 * RFID-Normalisierung.
 *
 * Eigenes Modul, damit Abrechnung und API-Client es nutzen koennen, ohne die
 * Datenbankschicht zu laden - beide sollen frei von I/O bleiben.
 */

/**
 * Vereinheitlicht RFID-IDs: Kleinschreibung, ohne Trennzeichen.
 * "AA:BB:CC", "aa-bb-cc" und "AABBCC" ergeben denselben Schluessel.
 *
 * @param {string} rfid
 * @returns {string}
 */
function normalizeRfid(rfid) {
  return String(rfid || '').replace(/[\s:_-]/g, '').toLowerCase();
}

module.exports = { normalizeRfid };
