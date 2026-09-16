'use strict';

/**
 * Zugriff auf die Wallbox im Heimnetz.
 *
 * Bewusst KEINE Normalisierung hier: der Connector reicht die Rohdaten durch,
 * das Online-Tool wertet sie aus. So gibt es genau eine Stelle, an der
 * Feldnamen und Einheiten interpretiert werden - ein Connector, der auf einem
 * Heimgerät läuft, wird seltener aktualisiert als der Server.
 */

const https = require('https');
const axios = require('axios');
const logger = require('./logger');

class Wallbox {
  /**
   * @param {object} options siehe lib/options.js (Zweig `wallbox`)
   * @param {import('axios').AxiosInstance} [httpClient] für Tests injizierbar
   */
  constructor(options, httpClient) {
    this.options = options;
    this.endpoints = options.endpoints;

    const headers = { Accept: 'application/json' };
    if (options.authMode === 'bearer' && options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    } else if (options.authMode === 'apikey' && options.token) {
      headers['X-API-Key'] = options.token;
    }

    this.http = httpClient || axios.create({
      baseURL: options.baseUrl,
      timeout: options.timeoutMs,
      headers,
      auth: options.authMode === 'basic' && options.username
        ? { username: options.username, password: options.password || '' }
        : undefined,
      // Wallboxen im LAN tragen häufig ein selbstsigniertes Zertifikat.
      httpsAgent: new https.Agent({ rejectUnauthorized: options.verifyTls !== false }),
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  /**
   * Aktueller Zustand.
   * @returns {Promise<object>} Rohantwort der Wallbox
   */
  async getStatus() {
    const { data } = await this.http.get(this.endpoints.status);

    // Optionaler zweiter Endpunkt für Zähler-/Leistungswerte. Fällt er aus,
    // wird trotzdem gesendet - ein unvollständiger Zustand ist besser als keiner.
    if (this.endpoints.meter) {
      try {
        const meter = await this.http.get(this.endpoints.meter);
        return { ...data, meter: meter.data };
      } catch (error) {
        logger.warn(`Meter-Endpunkt nicht erreichbar: ${error.message}`);
      }
    }

    return data;
  }

  /**
   * Ladehistorie ab einem Zeitpunkt.
   * @param {Date} since
   * @returns {Promise<Array<object>>} Rohdatensätze
   */
  async getSessions(since) {
    const { data } = await this.http.get(this.endpoints.sessions, {
      params: { from: since.toISOString(), to: new Date().toISOString(), limit: 1000 },
    });

    return Wallbox.extractArray(data);
  }

  /**
   * Findet die Liste der Ladevorgänge in den gängigen Antwort-Hüllen.
   *
   * Nur die Struktur wird hier erkannt, nicht der Inhalt - was ein Datensatz
   * bedeutet, entscheidet das Online-Tool.
   *
   * @param {*} payload
   * @returns {Array<object>}
   */
  static extractArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];

    for (const key of ['sessions', 'transactions', 'items', 'results', 'entries']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    for (const container of ['data', 'result']) {
      const inner = payload[container];
      if (Array.isArray(inner)) return inner;
      if (inner && typeof inner === 'object') {
        const nested = Wallbox.extractArray(inner);
        if (nested.length > 0) return nested;
      }
    }
    return [];
  }

  /**
   * Erreichbarkeitsprüfung für den Start.
   * @returns {Promise<{reachable:boolean, error?:string}>}
   */
  async ping() {
    try {
      await this.http.get(this.endpoints.status);
      return { reachable: true };
    } catch (error) {
      return { reachable: false, error: error.message };
    }
  }
}

module.exports = Wallbox;
