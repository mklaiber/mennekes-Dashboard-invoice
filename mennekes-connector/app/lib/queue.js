'use strict';

/**
 * Persistente Warteschlange für noch nicht zugestellte Ladevorgänge.
 *
 * Der wichtigste Teil des Connectors. Fällt das Internet aus, die Gegenstelle
 * oder der Strom, dürfen Ladevorgänge NICHT verloren gehen - sie sind die
 * Grundlage der Abrechnung und lassen sich später nicht rekonstruieren, wenn
 * die Wallbox ihre Historie irgendwann überschreibt.
 *
 * Liegt unter /data und überlebt damit Neustarts und Add-on-Updates.
 * Bewusst eine einfache JSON-Datei: ein paar hundert Einträge, atomar
 * geschrieben - dafür lohnt keine Datenbank auf einem Heimgerät.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class Queue {
  /**
   * @param {string} stateDir Verzeichnis, das Neustarts überlebt
   * @param {{maxEntries?:number}} [options]
   */
  constructor(stateDir, options = {}) {
    this.file = path.join(stateDir, 'pending-sessions.json');
    // Obergrenze gegen unbegrenztes Wachstum, falls die Gegenstelle monatelang
    // fehlt. Beim Überlauf fliegen die ÄLTESTEN zuerst - neuere Ladevorgänge
    // sind für die laufende Abrechnung wichtiger.
    this.maxEntries = options.maxEntries || 5000;

    /** @type {Map<string, object>} ID -> Rohdatensatz */
    this.pending = new Map();
    /** @type {Set<string>} bereits bestätigte IDs */
    this.delivered = new Set();

    this.#load();
  }

  #load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));

      for (const entry of stored.pending || []) {
        if (entry && entry.id) this.pending.set(String(entry.id), entry);
      }
      for (const id of stored.delivered || []) this.delivered.add(String(id));

      logger.info(`Warteschlange geladen: ${this.pending.size} offen, ${this.delivered.size} bereits zugestellt.`);
    } catch (error) {
      // Eine kaputte Datei darf den Start nicht verhindern. Im schlimmsten Fall
      // wird erneut gesendet - die Gegenstelle erkennt Dubletten an der ID.
      logger.error(`Warteschlange nicht lesbar (${error.message}) - beginne neu.`);
      this.pending.clear();
      this.delivered.clear();
    }
  }

  /** Schreibt atomar: erst in eine temporäre Datei, dann umbenennen. */
  #persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        pending: [...this.pending.values()],
        // Nur die jüngsten IDs behalten: die Liste dient allein dazu, bereits
        // Gesendetes nicht erneut zu schicken.
        delivered: [...this.delivered].slice(-this.maxEntries),
        savedAt: new Date().toISOString(),
      }), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      logger.error(`Warteschlange konnte nicht gespeichert werden: ${error.message}`);
    }
  }

  /**
   * Nimmt Datensätze auf, die noch nicht zugestellt wurden.
   * @param {Array<object>} entries Rohdatensätze der Wallbox
   * @param {(entry:object) => string|null} identify liefert die ID eines Datensatzes
   * @returns {number} Anzahl neu aufgenommener Einträge
   */
  enqueue(entries, identify) {
    let added = 0;

    for (const entry of entries || []) {
      const id = identify(entry);
      if (!id) continue;
      if (this.delivered.has(id) || this.pending.has(id)) continue;

      this.pending.set(id, entry);
      added += 1;
    }

    if (this.pending.size > this.maxEntries) {
      const overflow = this.pending.size - this.maxEntries;
      const ids = [...this.pending.keys()].slice(0, overflow);
      for (const id of ids) this.pending.delete(id);
      logger.warn(`Warteschlange übergelaufen - ${overflow} der ältesten Einträge verworfen.`);
    }

    if (added > 0) this.#persist();
    return added;
  }

  /**
   * Nächstes Paket zum Senden.
   * @param {number} [size=100]
   * @returns {Array<object>}
   */
  batch(size = 100) {
    return [...this.pending.values()].slice(0, size);
  }

  /**
   * Bestätigt zugestellte Einträge.
   * @param {Array<string>} ids
   */
  acknowledge(ids) {
    let changed = false;
    for (const id of ids || []) {
      if (this.pending.delete(String(id))) changed = true;
      this.delivered.add(String(id));
    }
    if (changed) this.#persist();
  }

  /**
   * Verwirft Einträge, die die Gegenstelle dauerhaft ablehnt.
   * Ohne das bliebe ein einzelner kaputter Datensatz für immer vorne stehen
   * und blockierte alle nachfolgenden.
   *
   * @param {Array<string>} ids
   */
  discard(ids) {
    let changed = false;
    for (const id of ids || []) {
      if (this.pending.delete(String(id))) {
        changed = true;
        // Als zugestellt merken, damit er nicht beim nächsten Abruf zurückkommt.
        this.delivered.add(String(id));
      }
    }
    if (changed) this.#persist();
  }

  /** @returns {number} Anzahl offener Einträge */
  get size() {
    return this.pending.size;
  }

  /** @returns {{pending:number, delivered:number, file:string}} */
  stats() {
    return { pending: this.pending.size, delivered: this.delivered.size, file: this.file };
  }
}

module.exports = Queue;
