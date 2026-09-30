'use strict';

/**
 * RFID-Normalisierung und -Abgleich.
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

const HEX = /^[0-9a-f]+$/;
const DECIMAL = /^[0-9]+$/;

function stripLeadingZeros(hex) {
  return hex.replace(/^0+/, '');
}

function reverseBytes(hex) {
  const even = hex.length % 2 === 1 ? `0${hex}` : hex;
  return even.match(/../g).reverse().join('');
}

/**
 * Andere Schreibweisen derselben Karten-UID.
 *
 * Dieselbe Karte erscheint je nach Quelle unterschiedlich: das Lesegerät der
 * Wallbox meldet die Bytes womöglich in umgekehrter Reihenfolge oder mit
 * Nullen aufgefüllt, auf der Karte selbst steht oft eine Dezimalzahl. Wer die
 * Nummer von dort abtippt, soll trotzdem einen Treffer bekommen.
 *
 * @param {string} rfid
 * @returns {string[]} Hex-Formen ohne führende Nullen
 */
function rfidVariants(rfid) {
  const key = normalizeRfid(rfid);
  const variants = new Set();

  const addHex = (hex) => {
    const core = stripLeadingZeros(hex);
    if (!core) return; // nur Nullen: keine Karte
    variants.add(core);
    variants.add(stripLeadingZeros(reverseBytes(core)));
  };

  if (HEX.test(key)) addHex(key);
  // 20 Dezimalstellen decken jede 8-Byte-UID ab; längere Ziffernfolgen sind keine Kartennummern.
  if (DECIMAL.test(key) && key.length <= 20) addHex(BigInt(key).toString(16));

  return [...variants];
}

/**
 * RFID -> Zuordnung. Bleibt eine Map (exakte, normalisierte Schlüssel), kennt
 * zusätzlich die anderen Schreibweisen jeder Karte.
 */
class RfidLookup extends Map {
  constructor(entries = []) {
    super();
    /** @type {Map<string, object|null>} Schreibweise -> Eintrag; null = mehrdeutig */
    this.variants = new Map();
    for (const entry of entries) this.add(entry);
  }

  /** @param {{rfid:string}} entry */
  add(entry) {
    const key = normalizeRfid(entry?.rfid);
    if (!key) return;
    this.set(key, entry);

    for (const variant of rfidVariants(key)) {
      const known = this.variants.get(variant);
      if (known === undefined) this.variants.set(variant, entry);
      // Passt eine Schreibweise auf zwei Karten, wird nicht geraten.
      else if (known !== entry) this.variants.set(variant, null);
    }
  }

  /**
   * Exakter Treffer, sonst eine eindeutige andere Schreibweise.
   * @param {string} rfid
   * @returns {object|undefined}
   */
  find(rfid) {
    const key = normalizeRfid(rfid);
    if (!key) return undefined;
    if (this.has(key)) return this.get(key);

    const matches = new Set();
    for (const variant of rfidVariants(key)) {
      if (this.variants.has(variant)) matches.add(this.variants.get(variant));
    }
    // Nur ein eindeutiger Treffer zählt - lieber "unbekannt" als die falsche Person abrechnen.
    if (matches.size !== 1 || matches.has(null)) return undefined;
    return [...matches][0];
  }
}

module.exports = { normalizeRfid, rfidVariants, RfidLookup };
