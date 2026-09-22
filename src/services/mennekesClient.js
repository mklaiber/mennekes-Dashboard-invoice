'use strict';

/**
 * API-Client für die MENNEKES Wallbox (REST/JSON).
 *
 * ACHTUNG - bewusste Design-Entscheidung:
 * Die konkreten Endpunkt-Pfade und Feldnamen unterscheiden sich zwischen den
 * Firmware-Generationen (AMTRON Professional / Professional+ / ChargeControl ...).
 * Deshalb sind
 *   a) die Pfade per ENV konfigurierbar (MENNEKES_ENDPOINT_*) und
 *   b) das Parsing tolerant: `pick()` akzeptiert mehrere gängige Feldnamen.
 * So muss bei abweichender Firmware nur die .env angepasst werden, nicht der Code.
 */

const axios = require('axios');
const https = require('https');
const config = require('../config');
const logger = require('../utils/logger');
const { normalizeRfid } = require('../utils/rfid');

/** Status-Codes der Wallbox auf ein stabiles internes Vokabular abbilden. */
const STATUS_MAP = {
  a: 'standby',
  b: 'connected',
  c: 'charging',
  d: 'charging',
  e: 'error',
  f: 'error',
  available: 'standby',
  idle: 'standby',
  standby: 'standby',
  suspended: 'connected',
  suspendedev: 'connected',
  suspendedevse: 'connected',
  preparing: 'connected',
  connected: 'connected',
  plugged: 'connected',
  charging: 'charging',
  finishing: 'connected',
  reserved: 'connected',
  unavailable: 'offline',
  offline: 'offline',
  faulted: 'error',
  error: 'error',
  // MENNEKES AMTRON (MHCP/1.0, /ChargeData: ChgState) - reverse-engineert,
  // siehe https://github.com/orlopau/amtron. "Terminated" bildet eine
  // beendete, aber ggf. noch angesteckte Sitzung ab; mangels Gegenprobe an
  // einem echten Gerät konservativ auf "verbunden" statt "Standby" gelegt.
  paused: 'connected',
  standbyconnect: 'connected',
  standbyauthorize: 'connected',
  terminated: 'connected',
};

/** Menschlich lesbare Labels für das Dashboard. */
const STATUS_LABELS = {
  charging: 'Lädt',
  connected: 'Verbunden',
  standby: 'Standby',
  error: 'Störung',
  offline: 'Offline',
  unknown: 'Unbekannt',
};

/**
 * Erster definierter Treffer aus mehreren möglichen Feldpfaden.
 * @param {object} source
 * @param {string[]} paths Punktnotation, z. B. 'meter.power'
 * @returns {*} undefined, wenn kein Pfad existiert
 */
function pick(source, paths) {
  for (const path of paths) {
    let cursor = source;
    let ok = true;
    for (const segment of path.split('.')) {
      if (cursor && typeof cursor === 'object' && segment in cursor) {
        cursor = cursor[segment];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && cursor !== undefined && cursor !== null && cursor !== '') return cursor;
  }
  return undefined;
}

/**
 * Robuste Zahlenkonvertierung (akzeptiert "12,5", "12.5 kW", 12.5).
 * @param {*} value
 * @returns {number|undefined}
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[^\d,.-]/g, '').replace(',', '.');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Wandelt Zeitangaben in ein Date. Unterstützt ISO-Strings und Unix-Timestamps (s und ms).
 * @param {*} value
 * @returns {Date|null}
 */
function toDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    // Heuristik: < 10^11 => Sekunden, sonst Millisekunden.
    const ms = numeric < 1e11 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Wh -> kWh, falls die Wallbox in Wattstunden liefert. */
function energyToKwh(raw, unitHint) {
  const value = toNumber(raw);
  if (value === undefined) return undefined;
  const unit = String(unitHint || '').toLowerCase();
  if (unit === 'wh' || unit === 'w') return value / 1000;
  return value;
}

class MennekesApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?:number, url?:string, cause?:Error}} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'MennekesApiError';
    this.status = details.status;
    this.url = details.url;
    this.cause = details.cause;
  }
}

class MennekesClient {
  /**
   * @param {object} [options] überschreibt einzelne Werte aus config.mennekes
   * @param {import('axios').AxiosInstance} [options.httpClient] für Tests injizierbar
   */
  constructor(options = {}) {
    const merged = { ...config.mennekes, ...options };

    this.baseUrl = String(merged.baseUrl || '').replace(/\/+$/, '');
    this.endpoints = { ...config.mennekes.endpoints, ...(options.endpoints || {}) };
    this.sessionQuery = { ...config.mennekes.sessionQuery, ...(options.sessionQuery || {}) };
    this.retries = Number.isInteger(merged.retries) ? merged.retries : 2;
    this.authMode = merged.authMode;
    // MENNEKES AMTRON (MHCP/1.0) verlangt den DevKey als QUERY-Parameter auf
    // jeder Anfrage, nicht als Header - ein vierter Auth-Modus neben
    // none/basic/bearer/apikey. Bleibt leer/wirkungslos, solange kein Token
    // gesetzt ist (siehe #authParams()).
    this.authQueryParam = merged.authQueryParam || null;
    this.authQueryToken = merged.token || null;
    // Firmware-abhängiges Protokoll für die Ladehistorie:
    //  'simple'          - ein GET mit from/to-Query, Antwort ist ein Array (Default).
    //  'amtron-stateful'  - Open/Read/Close-Zustandsautomat (siehe #fetchAmtronSessions()).
    this.sessionsProtocol = (merged.sessionsProtocol || 'simple').toLowerCase();

    this.http = options.httpClient || axios.create({
      baseURL: this.baseUrl,
      timeout: merged.timeoutMs,
      headers: this.#buildAuthHeaders(merged),
      auth: merged.authMode === 'basic' && merged.username
        ? { username: merged.username, password: merged.password || '' }
        : undefined,
      // Selbstsignierte Zertifikate der Wallbox nur zulassen, wenn explizit konfiguriert.
      httpsAgent: new https.Agent({ rejectUnauthorized: merged.rejectUnauthorized !== false }),
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  /** @returns {Record<string,string>} */
  #buildAuthHeaders(merged) {
    const headers = { Accept: 'application/json' };
    if (merged.authMode === 'bearer' && merged.token) {
      headers.Authorization = `Bearer ${merged.token}`;
    } else if (merged.authMode === 'apikey' && merged.token) {
      headers[merged.apiKeyHeader || 'X-API-Key'] = merged.token;
    }
    return headers;
  }

  /**
   * Auth-Parameter, die (nur im 'query'-Modus) an JEDE Anfrage angehängt
   * werden - MENNEKES AMTRON verlangt den DevKey auf jedem Aufruf, auch auf
   * den Read/Close-Schritten der Ladehistorie.
   * @returns {Record<string,string>}
   */
  #authParams() {
    if (this.authMode === 'query' && this.authQueryParam && this.authQueryToken) {
      return { [this.authQueryParam]: this.authQueryToken };
    }
    return {};
  }

  /**
   * GET mit Retry (nur bei Netzwerk-/5xx-Fehlern, nicht bei 4xx).
   * @param {string} path
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  async #get(path, params) {
    const mergedParams = { ...this.#authParams(), ...params };
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.http.get(path, { params: mergedParams });
        return response.data;
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        // Client-Fehler sind deterministisch - ein Retry bringt nichts.
        if (status && status < 500) break;
        if (attempt < this.retries) {
          const backoff = 2 ** attempt * 250;
          logger.warn(`Wallbox-Request ${path} fehlgeschlagen (Versuch ${attempt + 1}), erneut in ${backoff}ms`);
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    throw new MennekesApiError(
      `Wallbox-Abfrage fehlgeschlagen: ${lastError?.message || 'unbekannter Fehler'}`,
      { status: lastError?.response?.status, url: `${this.baseUrl}${path}`, cause: lastError }
    );
  }

  /**
   * Live-Daten für das Dashboard.
   * @returns {Promise<{status:string, statusLabel:string, powerKw:number, energySessionKwh:number|null,
   *   meterKwh:number|null, rfid:string|null, rfidRaw:string|null, currentA:number|null,
   *   voltageV:number|null, sessionStart:Date|null, vehicleConnected:boolean, timestamp:string}>}
   */
  async getLiveStatus() {
    const payload = await this.#get(this.endpoints.status);
    // Manche Firmwares kapseln alles in { data: {...} } oder liefern ein Array mit einem Connector.
    const root = pick(payload, ['data', 'result', 'payload']) || payload;
    const box = Array.isArray(root) ? root[0] || {} : root;

    let meterData = box;
    if (this.endpoints.meter) {
      try {
        const meterPayload = await this.#get(this.endpoints.meter);
        meterData = pick(meterPayload, ['data', 'result']) || meterPayload;
      } catch (error) {
        // Der optionale Meter-Endpoint darf das Dashboard nicht blockieren.
        logger.warn(`Meter-Endpoint nicht erreichbar: ${error.message}`);
      }
    }

    return MennekesClient.normalizeStatus(box, meterData);
  }

  /**
   * Normalisiert eine Status-Antwort. Statisch, damit in Tests ohne Instanz nutzbar.
   * @param {object} box Status-Payload
   * @param {object} [meter=box] optionaler separater Meter-Payload
   * @returns {object}
   */
  static normalizeStatus(box = {}, meter = box) {
    const rawStatus = pick(box, [
      // 'ChgState' ist das Feld der MENNEKES-AMTRON-Firmware (/ChargeData
      // und /DevInfo, MHCP/1.0): Idle, Charging, Paused, StandbyConnect,
      // StandbyAuthorize, Terminated - siehe STATUS_MAP oben.
      'status', 'state', 'ChgState', 'chargePointState', 'connectorStatus',
      'connectors.0.status', 'evseState', 'cpState', 'mode3State',
    ]);

    const statusKey = String(rawStatus ?? '').trim().toLowerCase();
    const status = STATUS_MAP[statusKey] || (statusKey ? 'unknown' : 'unknown');

    const powerRaw = pick(meter, [
      // 'ActPwr' (AMTRON /ChargeData) ist laut Community-Dokumentation in
      // Watt angegeben - ohne eigenes Einheitenfeld. Die Watt-Heuristik
      // unten (>100 => Watt) greift dafür bereits zuverlässig.
      'power', 'powerKw', 'ActPwr', 'activePower', 'chargingPower', 'meter.power',
      'powerActiveTotal', 'currentPower', 'p_total',
    ]);
    const powerUnit = pick(meter, ['powerUnit', 'meter.powerUnit', 'unit']);
    let powerKw = toNumber(powerRaw) ?? 0;
    // Werte > 100 sind mit an Sicherheit grenzender Wahrscheinlichkeit Watt, nicht kW
    // (Heim-Wallboxen laden mit max. 22 kW).
    if (String(powerUnit || '').toLowerCase() === 'w' || powerKw > 100) powerKw /= 1000;

    const meterKwh = energyToKwh(
      pick(meter, ['meterReading', 'energyTotal', 'totalEnergy', 'meter.energy', 'energyMeter', 'wh_total']),
      pick(meter, ['energyUnit', 'meter.energyUnit'])
    );

    let energySessionKwh = energyToKwh(
      pick(box, [
        'sessionEnergy', 'energySession', 'chargedEnergy', 'transaction.energy',
        'currentSession.energy', 'session.energyKwh',
      ]),
      pick(box, ['energyUnit', 'sessionEnergyUnit'])
    );
    // 'ChgNrg' (AMTRON /ChargeData) liefert die Sitzungsenergie ausschließlich
    // in Wh, ohne eigenes Einheitenfeld - deshalb explizit statt über die
    // generische (kWh-annehmende) Einheitenerkennung oben.
    if (energySessionKwh === undefined) {
      const chgNrg = toNumber(pick(box, ['ChgNrg']));
      if (chgNrg !== undefined) energySessionKwh = chgNrg / 1000;
    }

    const rfidRaw = pick(box, [
      // 'Uid' (AMTRON /ChargeData) ist die aktuell autorisierende RFID.
      'rfid', 'rfidTag', 'idTag', 'Uid', 'tokenId', 'authorizationId', 'userId',
      'transaction.idTag', 'currentSession.idTag', 'session.rfid',
    ]);

    const vehicleConnected = status === 'charging' || status === 'connected';

    return {
      status,
      statusLabel: STATUS_LABELS[status] || STATUS_LABELS.unknown,
      statusRaw: rawStatus ?? null,
      powerKw: Number.isFinite(powerKw) ? Math.max(0, Number(powerKw.toFixed(3))) : 0,
      energySessionKwh: energySessionKwh === undefined ? null : Number(energySessionKwh.toFixed(3)),
      meterKwh: meterKwh === undefined ? null : Number(meterKwh.toFixed(3)),
      currentA: toNumber(pick(meter, ['current', 'currentA', 'chargingCurrent', 'meter.current', 'i_total'])) ?? null,
      voltageV: toNumber(pick(meter, ['voltage', 'voltageV', 'meter.voltage', 'u_l1'])) ?? null,
      rfid: rfidRaw ? normalizeRfid(rfidRaw) : null,
      rfidRaw: rfidRaw ? String(rfidRaw) : null,
      sessionStart: toDate(pick(box, ['sessionStart', 'startTime', 'transaction.startTime', 'currentSession.start'])),
      vehicleConnected,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Abgeschlossene Ladevorgänge im Zeitraum [from, to).
   *
   * Die Wallbox filtert serverseitig (Query-Parameter), zusätzlich wird clientseitig
   * nachgefiltert - manche Firmwares ignorieren die Parameter stillschweigend.
   *
   * @param {Date} from inklusiv
   * @param {Date} to exklusiv
   * @returns {Promise<Array<object>>} normalisierte Ladevorgänge
   */
  async getChargingSessions(from, to) {
    const rawEntries = this.sessionsProtocol === 'amtron-stateful'
      ? await this.#fetchAmtronSessions(from, to)
      : await this.#fetchSimpleSessions(from, to);

    return rawEntries
      .map((entry) => MennekesClient.normalizeSession(entry))
      .filter((session) => session !== null)
      .filter((session) => session.start >= from && session.start < to)
      .sort((a, b) => a.start - b.start);
  }

  /**
   * Historie über ein einzelnes GET mit Zeitraum-Query - für Firmwares, die
   * die gesamte angefragte Liste in einer Antwort liefern.
   * @param {Date} from
   * @param {Date} to
   * @returns {Promise<Array<object>>} Rohdatensätze
   */
  async #fetchSimpleSessions(from, to) {
    const params = {};
    if (this.sessionQuery.fromParam) params[this.sessionQuery.fromParam] = from.toISOString();
    if (this.sessionQuery.toParam) params[this.sessionQuery.toParam] = to.toISOString();
    if (this.sessionQuery.limitParam) params[this.sessionQuery.limitParam] = this.sessionQuery.limit;

    const payload = await this.#get(this.endpoints.sessions, params);
    return MennekesClient.extractSessionArray(payload);
  }

  /**
   * Historie über das zustandsbehaftete MENNEKES-AMTRON-Protokoll
   * (/ChargeRecords, MHCP/1.0): eine Anfrage mit `State=Open` reserviert die
   * Sitzung und liefert die Gesamtzahl (`RemEntries`), danach liefert jede
   * `State=Read`-Anfrage bis zu 10 Datensätze und die verbleibende Anzahl.
   * `State=Close` gibt die Sitzung frei.
   *
   * Reverse-engineert (siehe https://github.com/orlopau/amtron), nicht von
   * MENNEKES offiziell dokumentiert - deshalb defensiv: harte Obergrenze der
   * Lese-Durchläufe und Abbruch, sobald eine Antwort keine neuen Datensätze
   * mehr liefert, auch wenn RemEntries etwas anderes behauptet.
   *
   * @param {Date} from
   * @param {Date} to
   * @returns {Promise<Array<object>>} Rohdatensätze
   */
  async #fetchAmtronSessions(from, to) {
    const startSec = Math.floor(from.getTime() / 1000);
    const endSec = Math.floor(to.getTime() / 1000);
    // Bewusst fest verdrahtet statt über this.sessionQuery konfigurierbar:
    // 'Start'/'End' sind Teil des AMTRON-Protokolls selbst, nicht einer
    // Firmware-Eigenheit wie beim einfachen Protokoll - eine falsch
    // konfigurierte MENNEKES_SESSIONS_FROM_PARAM dürfte diesen Aufruf nicht
    // stillschweigend brechen.
    const baseParams = { Start: startSec, End: endSec };

    const entries = [];
    // Obergrenze: 10 Datensätze je Lesevorgang, grosszügig für mehrere
    // hundert Ladevorgänge im Abrechnungszeitraum - verhindert eine
    // Endlosschleife, falls RemEntries bei abweichender Firmware nie 0 wird.
    const MAX_READS = 500;

    try {
      const openResponse = await this.#get(this.endpoints.sessions, { ...baseParams, State: 'Open' });
      let remaining = MennekesClient.#remainingEntries(openResponse);

      for (let read = 0; remaining > 0 && read < MAX_READS; read += 1) {
        const readResponse = await this.#get(this.endpoints.sessions, { ...baseParams, State: 'Read' });
        const batch = MennekesClient.extractSessionArray(readResponse);
        if (batch.length === 0) break;
        entries.push(...batch);
        remaining = MennekesClient.#remainingEntries(readResponse);
      }
    } finally {
      // Sitzung freigeben, auch wenn oben ein Fehler auftrat - sonst bleibt
      // sie auf der Wallbox belegt, bis sie von selbst abläuft. Best effort:
      // ein Fehlschlag hier darf bereits gelesene Daten nicht verwerfen.
      await this.#get(this.endpoints.sessions, { State: 'Close' }).catch(() => {});
    }

    return entries;
  }

  /**
   * Liest die verbleibende Anzahl aus einer Open/Read-Antwort des
   * AMTRON-Historienprotokolls.
   * @param {*} payload
   * @returns {number}
   */
  static #remainingEntries(payload) {
    const value = toNumber(pick(payload, ['RemEntries', 'remEntries', 'remaining']));
    return Number.isFinite(value) ? value : 0;
  }

  /**
   * Findet das Array der Ladevorgänge in verschiedenen Antwort-Hüllen.
   * @param {*} payload
   * @returns {Array<object>}
   */
  static extractSessionArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];

    // Wichtig: NICHT über pick() suchen. pick() liefert den ersten definierten
    // Treffer - bei { data: { sessions: [...] } } wäre das der Container `data`,
    // und der spezifischere Pfad `data.sessions` käme nie zum Zug.
    // Deshalb hier: jeden Kandidaten prüfen und nur Arrays akzeptieren.
    const candidatePaths = [
      'sessions', 'transactions', 'items', 'results', 'entries',
      // 'Records'/'Entries' (Großschreibung): möglicher Batch-Schlüssel der
      // MENNEKES-AMTRON-Ladehistorie (/ChargeRecords) - die reverse-
      // engineerte Doku lässt den exakten Namen offen (siehe Fallback unten).
      'Records', 'Entries',
      'data.sessions', 'data.transactions', 'data.items',
      'result.sessions', 'result.transactions',
      'data', 'result', 'payload',
    ];

    for (const path of candidatePaths) {
      const candidate = pick(payload, [path]);
      if (Array.isArray(candidate)) return candidate;
    }

    // Letzter Versuch: ein einzelnes Session-Objekt statt einer Liste.
    const single = pick(payload, ['data', 'result', 'transaction', 'session']);
    if (single && typeof single === 'object' && !Array.isArray(single)) {
      const nested = MennekesClient.extractSessionArray(single);
      if (nested.length > 0) return nested;
      // Nur als Session werten, wenn ein Startfeld erkennbar ist.
      if (pick(single, ['start', 'startTime', 'startedAt', 'sessionStart', 'Start'])) return [single];
    }
    if (pick(payload, ['start', 'startTime', 'startedAt', 'sessionStart', 'Start'])) return [payload];

    // AMTRON-Fallback: das Batch-Ergebnis von /ChargeRecords könnte statt
    // eines Arrays numerisch- oder namentlich indizierte Objekte auf oberster
    // Ebene liefern (die Community-Dokumentation zeigt dafür keine
    // eindeutige, valide JSON-Struktur). Deshalb: jede Eigenschaft neben
    // 'RemEntries' sammeln, die wie ein Ladevorgang aussieht (Start/Stop/
    // ChrNr vorhanden) - und NUR dann, wenn oben nichts gefunden wurde.
    const flattened = Object.entries(payload)
      .filter(([key]) => key !== 'RemEntries')
      .map(([, value]) => value)
      .filter((value) => value && typeof value === 'object'
        && ('Start' in value || 'ChrNr' in value || 'Stop' in value));
    if (flattened.length > 0) return flattened;

    return [];
  }

  /**
   * Normalisiert einen einzelnen Ladevorgang.
   * @param {object} entry Rohdatensatz der Wallbox
   * @returns {{id:string, start:Date, end:Date|null, durationSeconds:number, energyKwh:number,
   *   rfid:string, rfidRaw:string|null, meterStartKwh:number|null, meterEndKwh:number|null}|null}
   *   null, wenn der Datensatz unbrauchbar ist (kein Start oder keine Energie).
   */
  static normalizeSession(entry) {
    if (!entry || typeof entry !== 'object') return null;

    const start = toDate(pick(entry, [
      // 'Start' (MENNEKES AMTRON /ChargeRecords) ist Unix-Sekunden -
      // toDate() erkennt das bereits an der Größenordnung.
      'start', 'startTime', 'startedAt', 'sessionStart', 'timestampStart', 'begin', 'dateStart', 'Start',
    ]));
    if (!start) return null;

    const end = toDate(pick(entry, [
      'end', 'endTime', 'stoppedAt', 'endedAt', 'sessionEnd', 'timestampStop', 'stop', 'dateEnd', 'Stop',
    ]));

    const meterStartKwh = energyToKwh(
      pick(entry, ['meterStart', 'meterStartKwh', 'startMeter', 'meterValueStart']),
      pick(entry, ['energyUnit', 'meterUnit'])
    );
    const meterEndKwh = energyToKwh(
      pick(entry, ['meterStop', 'meterEnd', 'meterEndKwh', 'stopMeter', 'meterValueStop']),
      pick(entry, ['energyUnit', 'meterUnit'])
    );

    let energyKwh = energyToKwh(
      pick(entry, ['energy', 'energyKwh', 'chargedEnergy', 'consumption', 'kwh', 'totalEnergy', 'energyDelivered']),
      pick(entry, ['energyUnit', 'unit', 'meterUnit'])
    );

    // 'ChrNr' (MENNEKES AMTRON /ChargeRecords) liefert die Ladeenergie
    // ausschließlich in Wh, ohne eigenes Einheitenfeld - deshalb explizit
    // statt über die generische, kWh-annehmende Erkennung oben.
    if (energyKwh === undefined) {
      const chrNr = toNumber(pick(entry, ['ChrNr']));
      if (chrNr !== undefined) energyKwh = chrNr / 1000;
    }

    // Fallback: aus Zählerständen berechnen, wenn kein Energiefeld geliefert wird.
    if (energyKwh === undefined && meterStartKwh !== undefined && meterEndKwh !== undefined) {
      energyKwh = meterEndKwh - meterStartKwh;
    }
    if (energyKwh === undefined || !Number.isFinite(energyKwh) || energyKwh < 0) return null;

    let durationSeconds = toNumber(pick(entry, ['duration', 'durationSeconds', 'chargingTime', 'seconds']));
    if (durationSeconds === undefined && end) {
      durationSeconds = Math.max(0, (end.getTime() - start.getTime()) / 1000);
    }

    const rfidRaw = pick(entry, [
      // 'Uid' (MENNEKES AMTRON /ChargeRecords) ist die RFID der Sitzung.
      'rfid', 'rfidTag', 'idTag', 'Uid', 'tokenId', 'authorizationId', 'userId', 'tag', 'cardId',
    ]);

    return {
      id: String(pick(entry, ['id', 'sessionId', 'transactionId', 'uuid']) ?? `${start.toISOString()}-${rfidRaw ?? 'anon'}`),
      start,
      end,
      durationSeconds: Number.isFinite(durationSeconds) ? Math.round(durationSeconds) : 0,
      energyKwh: Number(energyKwh.toFixed(3)),
      rfid: rfidRaw ? normalizeRfid(rfidRaw) : 'unbekannt',
      rfidRaw: rfidRaw ? String(rfidRaw) : null,
      meterStartKwh: meterStartKwh === undefined ? null : Number(meterStartKwh.toFixed(3)),
      meterEndKwh: meterEndKwh === undefined ? null : Number(meterEndKwh.toFixed(3)),
    };
  }

  /**
   * Erreichbarkeitsprüfung für den Health-Endpoint.
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

module.exports = MennekesClient;
module.exports.MennekesApiError = MennekesApiError;
module.exports.STATUS_MAP = STATUS_MAP;
module.exports.STATUS_LABELS = STATUS_LABELS;
module.exports.pick = pick;
module.exports.toNumber = toNumber;
module.exports.toDate = toDate;
