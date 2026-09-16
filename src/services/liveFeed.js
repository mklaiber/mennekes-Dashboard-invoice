'use strict';

/**
 * Live-Datenversorgung des Dashboards über Server-Sent Events (SSE).
 *
 * Warum SSE und nicht socket.io?
 *  - Ein einziger, langlebiger HTTP-GET - die vorhandene Basic-Auth greift
 *    unverändert, es ist kein zweiter Auth-Pfad für den WebSocket-Handshake nötig.
 *  - Kein zusätzliches Client-Bundle, Reconnect macht der Browser selbst.
 *  - Die Datenrichtung ist ohnehin nur Server -> Client.
 *
 * Es läuft genau EIN Poll-Timer für alle verbundenen Clients (Fan-out),
 * damit die Wallbox nicht pro geöffnetem Tab abgefragt wird. Ohne Clients
 * pausiert der Timer vollständig.
 */

const { EventEmitter } = require('events');
const config = require('../config');
const logger = require('../utils/logger');
const settingsStore = require('../repositories/settingsRepository');
const MennekesClient = require('./mennekesClient');
const { resolveRfid } = require('./billing');

/**
 * Reichert den Rohzustand um den Klartextnamen der Ladekarte an.
 * Die Auflösung gehört nicht in den API-Client - der kennt die Settings nicht.
 *
 * @param {object} state Ergebnis von MennekesClient#getLiveStatus
 * @returns {object} derselbe Zustand plus rfidName/rfidPlate
 */
function enrichWithIdentity(state) {
  if (!state) return state;
  if (!state.rfid) return { ...state, rfidName: null, rfidPlate: null };

  const identity = resolveRfid(state.rfid, settingsStore.rfidLookup());
  return {
    ...state,
    rfidName: identity.known ? identity.name : null,
    rfidPlate: identity.plate || null,
  };
}

class LiveFeed extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {MennekesClient} [options.client]
   * @param {number} [options.pollIntervalMs]
   */
  constructor(options = {}) {
    super();
    this.client = options.client || new MennekesClient();
    this.pollIntervalMs = options.pollIntervalMs || config.live.pollIntervalMs;

    /** @type {Set<import('express').Response>} */
    this.subscribers = new Set();
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** Letzter erfolgreich gelesener Zustand - neue Clients bekommen ihn sofort. */
    this.lastState = null;
    this.lastError = null;
    this.polling = false;
  }

  /** @returns {number} Anzahl verbundener Dashboard-Clients */
  get subscriberCount() {
    return this.subscribers.size;
  }

  /**
   * Registriert eine SSE-Response und startet bei Bedarf den Poll-Timer.
   * @param {import('express').Response} res
   */
  addSubscriber(res) {
    this.subscribers.add(res);
    logger.debug(`SSE-Client verbunden (${this.subscribers.size} aktiv).`);

    // Sofortiger Zustand, damit das Dashboard nicht bis zum nächsten Poll leer bleibt.
    if (this.lastState) this.#writeTo(res, 'status', this.lastState);
    else this.poll().catch(() => { /* Fehler wird über das 'error'-Event verteilt. */ });

    this.start();
  }

  /**
   * Entfernt eine Response und stoppt den Timer, wenn niemand mehr zuhört.
   * @param {import('express').Response} res
   */
  removeSubscriber(res) {
    this.subscribers.delete(res);
    logger.debug(`SSE-Client getrennt (${this.subscribers.size} aktiv).`);
    if (this.subscribers.size === 0) this.stop();
  }

  /** Startet den Poll-Timer (idempotent). */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch(() => { /* bereits in poll() behandelt */ });
    }, this.pollIntervalMs);
    // Der Timer darf den Prozess nicht am Beenden hindern.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.debug(`Live-Polling gestartet (${this.pollIntervalMs}ms).`);
  }

  /** Stoppt den Poll-Timer. */
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.debug('Live-Polling gestoppt (keine Clients).');
  }

  /**
   * Fragt die Wallbox ab und verteilt das Ergebnis an alle Clients.
   * @returns {Promise<object|null>} der Zustand, oder null bei Fehler
   */
  async poll() {
    // Ueberlappende Polls vermeiden, wenn die Wallbox langsamer antwortet als das Intervall.
    if (this.polling) return this.lastState;
    this.polling = true;

    try {
      const state = enrichWithIdentity(await this.client.getLiveStatus());
      this.lastState = state;
      this.lastError = null;
      this.broadcast('status', state);
      this.emit('status', state);
      return state;
    } catch (error) {
      this.lastError = { message: error.message, at: new Date().toISOString() };
      logger.warn(`Live-Abfrage fehlgeschlagen: ${error.message}`);
      this.broadcast('error', this.lastError);
      this.emit('error', error);
      return null;
    } finally {
      this.polling = false;
    }
  }

  /**
   * Sendet ein Event an alle verbundenen Clients.
   * @param {string} event
   * @param {object} payload
   */
  broadcast(event, payload) {
    for (const res of this.subscribers) {
      this.#writeTo(res, event, payload);
    }
  }

  /**
   * SSE-Frame schreiben. Ein abgebrochener Client wird still entfernt.
   * @param {import('express').Response} res
   * @param {string} event
   * @param {object} payload
   */
  #writeTo(res, event, payload) {
    try {
      // Ein einziger write() pro Frame: Event- und Datenzeile landen so im
      // selben TCP-Segment und der Client sieht das Frame nicht zerteilt.
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // Schreiben auf eine abgebrochene Verbindung - Client still entfernen.
      this.subscribers.delete(res);
    }
  }

  /** Kommentar-Frame gegen Proxy-Timeouts. */
  heartbeat() {
    for (const res of this.subscribers) {
      try {
        res.write(': ping\n\n');
      } catch {
        this.subscribers.delete(res);
      }
    }
  }

  /** Alle Verbindungen schließen (Shutdown). */
  shutdown() {
    this.stop();
    for (const res of this.subscribers) {
      try {
        res.end();
      } catch { /* Verbindung bereits weg. */ }
    }
    this.subscribers.clear();
  }
}

module.exports = LiveFeed;
module.exports.enrichWithIdentity = enrichWithIdentity;
