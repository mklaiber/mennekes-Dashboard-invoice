'use strict';

/**
 * Versionskennung für die statischen Dateien.
 *
 * Sie heissen unveraendert /static/css/material.css und /static/js/*.js, und
 * ausgeliefert werden sie mit einer Woche Cache. Ohne Kennung fragt ein
 * Browser, der die Seite schon einmal besucht hat, sieben Tage lang gar nicht
 * mehr nach - jedes Deployment bliebe fuer wiederkehrende Besucher unsichtbar,
 * obwohl die neue Datei laengst auf dem Server liegt.
 *
 * Die Kennung stammt aus dem INHALT der Dateien, nicht aus der Startzeit:
 * ein Neustart des Pods soll den Cache nicht entwerten, eine geaenderte Datei
 * schon.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/** Alle Dateien unterhalb von dir, alphabetisch - fuer eine stabile Reihenfolge. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

let cached = null;

/**
 * @returns {string} kurze, stabile Kennung des aktuellen Dateibestands
 */
function assetVersion() {
  if (cached) return cached;

  try {
    const hash = crypto.createHash('sha1');
    for (const file of walk(PUBLIC_DIR)) {
      hash.update(path.relative(PUBLIC_DIR, file));
      hash.update(fs.readFileSync(file));
    }
    cached = hash.digest('hex').slice(0, 10);
  } catch (error) {
    // Lieber ohne Kennung ausliefern als gar nicht starten. Dann gilt wieder
    // das alte Verhalten, aber nichts geht kaputt.
    logger.warn(`Versionskennung der statischen Dateien nicht berechenbar: ${error.message}`);
    cached = 'dev';
  }
  return cached;
}

/** Nur fuer Tests: Zwischenspeicher verwerfen. */
function _reset() {
  cached = null;
}

module.exports = { assetVersion, _reset };
