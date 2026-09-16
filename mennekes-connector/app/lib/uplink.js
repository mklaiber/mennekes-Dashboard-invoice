'use strict';

/**
 * Ausgehende Verbindung zum Online-Tool.
 *
 * Die Richtung ist der Kern des Entwurfs: der Connector ruft nach außen, das
 * Online-Tool ruft nie herein. Deshalb braucht der Router keine
 * Portweiterleitung, und die Wallbox bleibt für das Internet unsichtbar.
 */

const https = require('https');
const axios = require('axios');
const logger = require('./logger');

class Uplink {
  /**
   * @param {object} options siehe lib/options.js (Zweig `target`)
   * @param {string} version Version des Connectors, geht als Header mit
   * @param {import('axios').AxiosInstance} [httpClient] für Tests injizierbar
   */
  constructor(options, version, httpClient) {
    this.options = options;

    this.http = httpClient || axios.create({
      baseURL: `${options.baseUrl}/api/ingest`,
      timeout: options.timeoutMs,
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        'X-Connector-Version': version,
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: options.verifyTls !== false }),
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  /**
   * Übersetzt einen Fehler in eine Aussage darüber, ob ein erneuter Versuch
   * sinnvoll ist.
   *
   * @param {Error} error
   * @returns {{retryable:boolean, status:number|undefined, message:string}}
   */
  static classify(error) {
    const status = error.response?.status;
    const detail = error.response?.data?.message || error.message;

    if (status === undefined) {
      // Kein HTTP-Status: Netzwerkproblem, DNS, Zeitüberschreitung - kommt wieder.
      return { retryable: true, status, message: `Netzwerkfehler: ${detail}` };
    }
    if (status === 401 || status === 403) {
      // Falsches Token. Ein Wiederholen ändert daran nichts.
      return { retryable: false, status, message: `Abgewiesen (${status}): ${detail}` };
    }
    if (status === 404) {
      return { retryable: false, status, message: `Endpunkt nicht gefunden (404). Läuft das Online-Tool mit DATA_SOURCE=connector?` };
    }
    if (status === 400 || status === 422) {
      // Inhaltlich fehlerhaft - erneutes Senden hilft nicht.
      return { retryable: false, status, message: `Sendung abgelehnt (${status}): ${detail}` };
    }
    if (status === 429) {
      return { retryable: true, status, message: 'Zu viele Anfragen - später erneut.' };
    }
    return { retryable: status >= 500, status, message: `HTTP ${status}: ${detail}` };
  }

  /**
   * Meldet den aktuellen Zustand.
   *
   * Live-Werte werden NICHT wiederholt: ein zehn Sekunden alter Messwert hat
   * keinen Wert mehr, der nächste steht ohnehin gleich an.
   *
   * @param {object} status Rohantwort der Wallbox
   * @returns {Promise<boolean>} true bei Erfolg
   */
  async sendStatus(status) {
    try {
      await this.http.post('/status', { status });
      return true;
    } catch (error) {
      const info = Uplink.classify(error);
      logger[info.retryable ? 'warn' : 'error'](`Zustand nicht übermittelt: ${info.message}`);
      return false;
    }
  }

  /**
   * Übermittelt abgeschlossene Ladevorgänge.
   *
   * @param {Array<object>} sessions Rohdatensätze
   * @returns {Promise<{ok:boolean, acknowledged:string[], rejected:string[], retryable:boolean}>}
   */
  async sendSessions(sessions) {
    if (!sessions || sessions.length === 0) {
      return { ok: true, acknowledged: [], rejected: [], retryable: false };
    }

    try {
      const { data } = await this.http.post('/sessions', { sessions });

      // Dauerhaft abgelehnte Datensätze meldet die Gegenstelle einzeln zurück.
      // Sie werden verworfen, sonst blockierten sie die Warteschlange für immer.
      const rejected = (data.rejected || []).map((entry) => String(entry.id));
      if (rejected.length > 0) {
        logger.warn(`${rejected.length} Vorgang/Vorgänge dauerhaft abgelehnt: `
          + (data.rejected || []).map((entry) => `${entry.id} (${entry.reason})`).join(', '));
      }

      const acknowledged = sessions
        .map((session) => String(session.__id))
        .filter((id) => id && !rejected.includes(id));

      logger.info(`${acknowledged.length} Vorgang/Vorgänge übermittelt `
        + `(${data.inserted ?? '?'} neu, ${data.updated ?? '?'} aktualisiert).`);

      return { ok: true, acknowledged, rejected, retryable: false };
    } catch (error) {
      const info = Uplink.classify(error);
      logger[info.retryable ? 'warn' : 'error'](`Ladevorgänge nicht übermittelt: ${info.message}`);
      return { ok: false, acknowledged: [], rejected: [], retryable: info.retryable };
    }
  }

  /**
   * Selbsttest: prüft Erreichbarkeit und Token, ohne Daten zu senden.
   * @returns {Promise<{ok:boolean, message:string, info?:object}>}
   */
  async check() {
    try {
      const { data } = await this.http.get('/health');
      return { ok: true, message: 'Verbindung und Token in Ordnung.', info: data };
    } catch (error) {
      return { ok: false, message: Uplink.classify(error).message };
    }
  }
}

module.exports = Uplink;
