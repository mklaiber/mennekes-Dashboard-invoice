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
    // MENNEKES AMTRON (MHCP/1.0) verlangt den Token als QUERY-Parameter
    // ("DevKey") auf jeder Anfrage statt als Header - ein vierter Auth-Modus
    // neben none/basic/bearer/apikey. Bleibt wirkungslos ohne Token.
    this.authQueryParam = options.authQueryParam || null;
    this.authQueryToken = options.token || null;
    // 'simple' (ein GET) oder 'amtron-stateful' (Open/Read/Close, siehe
    // #fetchAmtronSessions) - AMTRONs /ChargeRecords braucht Letzteres.
    this.sessionsProtocol = (options.sessionsProtocol || 'simple').toLowerCase();

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
   * Auth-Parameter, die (nur im 'query'-Modus) an JEDE Anfrage angehängt
   * werden.
   * @returns {Record<string,string>}
   */
  #authParams() {
    if (this.options.authMode === 'query' && this.authQueryParam && this.authQueryToken) {
      return { [this.authQueryParam]: this.authQueryToken };
    }
    return {};
  }

  /**
   * GET mit automatisch eingemischten Auth-Query-Parametern.
   * @param {string} path
   * @param {object} [params]
   * @returns {Promise<any>} response.data
   */
  async #get(path, params) {
    const { data } = await this.http.get(path, { params: { ...this.#authParams(), ...params } });
    return data;
  }

  /**
   * Aktueller Zustand.
   * @returns {Promise<object>} Rohantwort der Wallbox
   */
  async getStatus() {
    const data = await this.#get(this.endpoints.status);

    // Optionaler zweiter Endpunkt für Zähler-/Leistungswerte. Fällt er aus,
    // wird trotzdem gesendet - ein unvollständiger Zustand ist besser als keiner.
    if (this.endpoints.meter) {
      try {
        const meter = await this.#get(this.endpoints.meter);
        return { ...data, meter };
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
    if (this.sessionsProtocol === 'amtron-stateful') {
      return this.#fetchAmtronSessions(since, new Date());
    }

    const data = await this.#get(this.endpoints.sessions, {
      from: since.toISOString(), to: new Date().toISOString(), limit: 1000,
    });
    return Wallbox.extractArray(data);
  }

  /**
   * Ladehistorie über das zustandsbehaftete MENNEKES-AMTRON-Protokoll
   * (/ChargeRecords, MHCP/1.0): `State=Open` reserviert die Sitzung und
   * liefert die Gesamtzahl (`RemEntries`), danach liefert jedes
   * `State=Read` bis zu 10 Datensätze, `State=Close` gibt frei.
   *
   * Reverse-engineert (siehe README/DOCS.md), nicht offiziell dokumentiert -
   * deshalb defensiv: harte Obergrenze der Lese-Durchläufe und Abbruch,
   * sobald eine Antwort keine neuen Datensätze mehr liefert.
   *
   * @param {Date} from
   * @param {Date} to
   * @returns {Promise<Array<object>>} Rohdatensätze
   */
  async #fetchAmtronSessions(from, to) {
    const baseParams = {
      Start: Math.floor(from.getTime() / 1000),
      End: Math.floor(to.getTime() / 1000),
    };
    const entries = [];
    const MAX_READS = 500;

    try {
      const openResponse = await this.#get(this.endpoints.sessions, { ...baseParams, State: 'Open' });
      let remaining = Wallbox.#remainingEntries(openResponse);

      for (let read = 0; remaining > 0 && read < MAX_READS; read += 1) {
        const readResponse = await this.#get(this.endpoints.sessions, { ...baseParams, State: 'Read' });
        const batch = Wallbox.extractArray(readResponse);
        if (batch.length === 0) break;
        entries.push(...batch);
        remaining = Wallbox.#remainingEntries(readResponse);
      }
    } finally {
      // Best effort: die Sitzung freigeben, auch wenn oben ein Fehler auftrat -
      // sonst bleibt sie auf dem Gerät belegt, bis sie von selbst abläuft.
      await this.#get(this.endpoints.sessions, { State: 'Close' }).catch(() => {});
    }

    return entries;
  }

  /** @param {*} payload @returns {number} */
  static #remainingEntries(payload) {
    const value = Number.parseFloat(payload?.RemEntries ?? payload?.remEntries ?? payload?.remaining);
    return Number.isFinite(value) ? value : 0;
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

    for (const key of [
      'sessions', 'transactions', 'items', 'results', 'entries',
      // 'Records'/'Entries' (Großschreibung): möglicher Batch-Schlüssel der
      // MENNEKES-AMTRON-Ladehistorie (/ChargeRecords) - die reverse-
      // engineerte Doku lässt den exakten Namen offen.
      'Records', 'Entries',
    ]) {
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

    // AMTRON-Fallback: das Batch-Ergebnis von /ChargeRecords könnte statt
    // eines Arrays benannte Objekte auf oberster Ebene liefern. Deshalb:
    // jede Eigenschaft neben 'RemEntries' sammeln, die wie ein Ladevorgang
    // aussieht (Start/Stop/ChrNr vorhanden) - nur als letzter Versuch.
    const flattened = Object.entries(payload)
      .filter(([key]) => key !== 'RemEntries')
      .map(([, value]) => value)
      .filter((value) => value && typeof value === 'object'
        && ('Start' in value || 'ChrNr' in value || 'Stop' in value));
    if (flattened.length > 0) return flattened;

    return [];
  }

  /**
   * Erreichbarkeitsprüfung für den Start.
   * @returns {Promise<{reachable:boolean, error?:string}>}
   */
  async ping() {
    try {
      await this.#get(this.endpoints.status);
      return { reachable: true };
    } catch (error) {
      return { reachable: false, error: error.message };
    }
  }
}

module.exports = Wallbox;
