'use strict';

/**
 * Modbus-TCP-Client für die MENNEKES AMTRON Professional (und verwandte
 * Bender-CC-Plattform-Geräte: Bender CC612/613, AMEDIO Professional,
 * AMTRON ChargeControl, ...).
 *
 * Anders als bei den Xtra/Premium-Modellen (REST/MHCP, siehe mennekesClient.js)
 * hat die Professional laut offizieller Anleitung KEINE REST-Schnittstelle -
 * nur Modbus TCP und OCPP. Die Register-Adressen und ihre Bedeutung stammen
 * aus dem quelloffenen, produktiv genutzten evcc-Treiber
 * (github.com/evcc-io/evcc, charger/bender.go, Typ "bender"), dessen Template
 * "bender-cc" die "AMTRON Professional" explizit als unterstütztes Produkt
 * listet.
 *
 * Voraussetzung an der Wallbox (Systemeinstellungen):
 *  - "Modbus TCP Server für Energiemanagement-Systeme" aktiviert
 *  - "Registersatz" NICHT auf "Phoenix"/"TQ-DM100"/"ISE/IGT Kassel", sondern
 *    die Auswahl "Ebee"/"Bender"/"MENNEKES" o. ä.
 *  - "UID Übertragung erlauben" aktiviert (für RFID-Auswertung)
 *
 * Es gibt auch über Modbus KEINE Ladehistorie - nur den aktuellen Zustand.
 * Abgeschlossene Ladevorgänge werden deshalb selbst aus aufeinanderfolgenden
 * getLiveStatus()-Aufrufen rekonstruiert (siehe #trackSession) und in
 * derselben Tabelle abgelegt, die im Connector-Betrieb befüllt wird - die
 * übrige Anwendung (Abrechnung, Dashboard) unterscheidet nicht, woher ein
 * Ladevorgang stammt.
 */

const ModbusRTU = require('modbus-serial');
const config = require('../config');
const logger = require('../utils/logger');
const { normalizeRfid } = require('../utils/rfid');
const chargingSessions = require('../repositories/chargingSessionRepository');
const { STATUS_MAP, STATUS_LABELS } = require('./mennekesClient');

/** Holding-Register-Adressen (Ebee/Bender/MENNEKES-Registersatz). */
const REG = {
  FIRMWARE: 100, // Firmware-Version, String (2 Register)
  CHARGE_POINT_MODEL: 142, // Modellbezeichnung, String (10 Register) - Sondierung Legacy vs. aktuell
  CHARGE_POINT_STATE: 122, // Control-Pilot-Status: 1=A (kein Fahrzeug) 2=B (verbunden) 3/4=C/D (lädt)
  ACTIVE_POWER: 220, // aktuelle Wirkleistung (W), uint32
  TOTAL_ENERGY: 218, // Gesamtzählerstand (Wh), uint32
  CURRENTS: 212, // Ströme L1-L3 (mA), 3x uint32
  VOLTAGES: 222, // Spannungen L1-L3 (V), 3x uint32
  CHARGED_ENERGY: 716, // Energie der laufenden Sitzung (Wh), uint32
  CHARGING_DURATION: 718, // Dauer der laufenden Sitzung (s), uint32
  USER_ID: 720, // RFID/OCPP-IdTag der laufenden Sitzung, String (10 Register)
  LEGACY_PHASE_ENERGY: 200, // Legacy-Registersatz: Energie je Phase (Wh), 3x uint32
};

const MAX_UINT32 = 0xffffffff;
/** Control-Pilot-Register -> dieselben Buchstaben wie STATUS_MAP (IEC 61851). */
const CP_STATE_LETTER = { 1: 'a', 2: 'b', 3: 'c', 4: 'd' };

class MennekesModbusError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MennekesModbusError';
    Object.assign(this, details);
  }
}

/**
 * Registerinhalt als vorzeichenlose 32-Bit-Zahl (Big Endian, 2 Register).
 * `null` beim bekannten Firmware-Aussetzer mancher 5.33.x-Stände, die
 * kurzzeitig 0xFFFFFFFF statt eines echten Werts liefern (siehe
 * github.com/evcc-io/evcc/discussions/27736) - der Aufrufer behandelt das wie
 * "vorübergehend nicht verfügbar", nicht wie einen Messwert von 4+ Milliarden.
 * @param {{buffer: Buffer}} result
 * @returns {number|null}
 */
function asU32(result) {
  const value = result.buffer.readUInt32BE(0);
  return value === MAX_UINT32 ? null : value;
}

/** Registerinhalt als Text, Nullbytes und Leerraum entfernt. */
function asString(result) {
  return result.buffer.toString('latin1').replace(/\0/g, '').trim();
}

class MennekesModbusClient {
  /**
   * @param {object} [options]
   * @param {string} [options.host]
   * @param {number} [options.port]
   * @param {number} [options.unitId]
   * @param {number} [options.timeoutMs]
   * @param {object} [options.modbusClient] injizierbar für Tests (Ersatz für ModbusRTU-Instanz)
   */
  constructor(options = {}) {
    const merged = { ...config.mennekes.modbus, ...options };
    this.host = merged.host;
    this.port = merged.port;
    this.unitId = merged.unitId;
    this.timeoutMs = merged.timeoutMs;
    this.modbus = options.modbusClient || new ModbusRTU();

    /** @type {Promise<void>|null} laufender Verbindungsaufbau, gegen parallele Aufrufe */
    this.connecting = null;
    /** @type {boolean|null} Registersatz-Sondierung: unbekannt bis zum ersten Zugriff */
    this.legacy = null;
    /** @type {{startedAt: Date, rfid: string|null, rfidRaw: string|null, lastEnergyWh: number|null, lastDurationS: number|null}|null} */
    this.session = null;
    /** @type {NodeJS.Timeout|null} von LiveFeed unabhängiger Takt für die Sitzungs-Erfassung */
    this.trackingTimer = null;
  }

  /** Baut bei Bedarf die TCP-Verbindung auf (einmalig, danach wiederverwendet). */
  async #ensureConnected() {
    if (this.modbus.isOpen) return;
    if (!this.connecting) {
      this.connecting = this.modbus
        .connectTCP(this.host, { port: this.port, timeout: this.timeoutMs })
        .then(() => {
          this.modbus.setID(this.unitId);
          this.modbus.setTimeout(this.timeoutMs);
        })
        .finally(() => { this.connecting = null; });
    }
    await this.connecting;
  }

  /**
   * Liest ein oder mehrere Holding-Register (Function Code 3).
   * @param {number} address
   * @param {number} length Anzahl 16-Bit-Register
   * @returns {Promise<{data: number[], buffer: Buffer}>}
   */
  async #read(address, length) {
    await this.#ensureConnected();
    try {
      return await this.modbus.readHoldingRegisters(address, length);
    } catch (error) {
      // Eine tote Verbindung meldet sich oft erst beim nächsten Zugriff -
      // danach neu verbinden statt denselben Fehler dauerhaft zu werfen.
      if (this.modbus.isOpen) {
        try { this.modbus.close(() => {}); } catch { /* bereits zu */ }
      }
      throw new MennekesModbusError(
        `Modbus-Zugriff auf Register ${address} fehlgeschlagen: ${error.message}`,
        { address, cause: error }
      );
    }
  }

  /** @param {number} address @returns {Promise<number|null>} siehe {@link asU32} */
  async #readU32(address) {
    return asU32(await this.#read(address, 2));
  }

  /**
   * Ermittelt einmalig, ob die Wallbox den aktuellen oder den Legacy-
   * Registersatz spricht: manche ältere Firmwares kennen Register 142
   * (Modellbezeichnung) nicht, dann laufen Zählerstand/Leistung über den
   * Legacy-Phasen-Energie-Bereich statt über die dedizierten Register.
   */
  async #ensureRegisterSet() {
    if (this.legacy !== null) return;
    try {
      await this.#read(REG.CHARGE_POINT_MODEL, 10);
      this.legacy = false;
    } catch {
      this.legacy = true;
      logger.warn('Wallbox antwortet nicht auf Register 142 - verwende den älteren (Legacy-)Registersatz.');
    }
  }

  /** Legacy-Registersatz: Gesamtenergie als Summe der drei Phasen-Register. */
  async #legacyTotalEnergyWh() {
    const result = await this.#read(REG.LEGACY_PHASE_ENERGY, 6);
    let total = 0;
    for (let phase = 0; phase < 3; phase += 1) {
      const value = result.buffer.readUInt32BE(phase * 4);
      if (value !== MAX_UINT32) total += value;
    }
    return total;
  }

  /**
   * Drei aufeinanderfolgende 32-Bit-Werte (Ströme oder Spannungen je Phase).
   * Ein Sentinel-Wert je Phase wird als 0 gewertet (Phase nicht angeschlossen),
   * nicht als "gesamter Messwert unbrauchbar" wie bei den Einzelregistern.
   * @param {number} address
   * @param {number} divider
   * @returns {Promise<[number, number, number]>}
   */
  async #readPhaseValues(address, divider) {
    const result = await this.#read(address, 6);
    const values = [0, 1, 2].map((phase) => {
      const raw = result.buffer.readUInt32BE(phase * 4);
      return raw === MAX_UINT32 ? 0 : raw / divider;
    });
    return values;
  }

  /**
   * Aktueller Zustand. Dieselbe Rückgabeform wie MennekesClient#getLiveStatus,
   * damit LiveFeed/Scheduler/Dashboard nicht wissen müssen, über welches
   * Protokoll die Wallbox angesprochen wird.
   * @returns {Promise<object>}
   */
  async getLiveStatus() {
    await this.#ensureRegisterSet();

    const stateResult = await this.#read(REG.CHARGE_POINT_STATE, 1);
    const stateValue = stateResult.data[0];
    const statusKey = CP_STATE_LETTER[stateValue];
    const status = STATUS_MAP[statusKey] || 'unknown';

    const activePowerW = this.legacy ? null : await this.#readU32(REG.ACTIVE_POWER);
    const totalEnergyWh = this.legacy
      ? await this.#legacyTotalEnergyWh()
      : await this.#readU32(REG.TOTAL_ENERGY);

    // Sitzungsregister (716/718/720) fehlen auf manchen Firmwaregenerationen
    // (4You/4Business, siehe evcc charger/bender.go) - Live-Status bleibt
    // trotzdem verfügbar, nur ohne Sitzungsdetails.
    let chargedEnergyWh = null;
    let chargingDurationS = null;
    let rfidRaw = null;
    try {
      chargedEnergyWh = await this.#readU32(REG.CHARGED_ENERGY);
      chargingDurationS = await this.#readU32(REG.CHARGING_DURATION);
      const userId = asString(await this.#read(REG.USER_ID, 10));
      rfidRaw = userId || null;
    } catch (error) {
      logger.debug(`Sitzungsregister nicht lesbar: ${error.message}`);
    }

    let currentA = null;
    let voltageV = null;
    try {
      const [currentsL1, currentsL2, currentsL3] = await this.#readPhaseValues(REG.CURRENTS, 1000);
      currentA = Number(((currentsL1 + currentsL2 + currentsL3) / 3).toFixed(2));
      const [voltagesL1] = await this.#readPhaseValues(REG.VOLTAGES, 1);
      voltageV = voltagesL1 || null;
    } catch (error) {
      logger.debug(`Strom-/Spannungsregister nicht lesbar: ${error.message}`);
    }

    const vehicleConnected = status === 'charging' || status === 'connected';

    const state = {
      status,
      statusLabel: STATUS_LABELS[status] || STATUS_LABELS.unknown,
      statusRaw: Number.isFinite(stateValue) ? String(stateValue) : null,
      powerKw: activePowerW === null ? 0 : Number((activePowerW / 1000).toFixed(3)),
      energySessionKwh: chargedEnergyWh === null ? null : Number((chargedEnergyWh / 1000).toFixed(3)),
      meterKwh: totalEnergyWh === null ? null : Number((totalEnergyWh / 1000).toFixed(3)),
      currentA,
      voltageV,
      rfid: rfidRaw ? normalizeRfid(rfidRaw) : null,
      rfidRaw,
      sessionStart: this.session ? this.session.startedAt : null,
      vehicleConnected,
      timestamp: new Date().toISOString(),
    };

    this.#trackSession(status, { chargedEnergyWh, chargingDurationS, rfid: state.rfid, rfidRaw });

    return state;
  }

  /**
   * Baut abgeschlossene Ladevorgänge aus aufeinanderfolgenden Zustandswechseln
   * zusammen - es gibt kein Verlaufsregister. Geschrieben wird nur EINMAL, beim
   * Übergang von "lädt" zu "lädt nicht mehr", mit dem zuletzt bekannten guten
   * Stand von Energie/Dauer (nicht dem aktuellen, der nach Sitzungsende
   * bereits zurückgesetzt sein kann).
   *
   * @param {string} status normalisierter Zustand ('charging', 'connected', ...)
   * @param {{chargedEnergyWh: number|null, chargingDurationS: number|null, rfid: string|null, rfidRaw: string|null}} reading
   */
  #trackSession(status, reading) {
    const charging = status === 'charging';

    if (charging && !this.session) {
      // Startzeitpunkt aus der geräteeigenen Dauer zurückrechnen, statt den
      // Zeitpunkt der ersten Erkennung zu nehmen - genauer, und unabhängig
      // davon, ob der Prozess mitten in einer laufenden Sitzung neu startet.
      const startedAt = Number.isFinite(reading.chargingDurationS)
        ? new Date(Date.now() - reading.chargingDurationS * 1000)
        : new Date();

      this.session = {
        startedAt,
        rfid: reading.rfid,
        rfidRaw: reading.rfidRaw,
        lastEnergyWh: reading.chargedEnergyWh,
        lastDurationS: reading.chargingDurationS,
      };
      return;
    }

    if (charging && this.session) {
      if (reading.chargedEnergyWh !== null) this.session.lastEnergyWh = reading.chargedEnergyWh;
      if (reading.chargingDurationS !== null) this.session.lastDurationS = reading.chargingDurationS;
      // RFID kann während der Sitzung kurz leer ausgelesen werden - letzten guten Wert behalten.
      if (reading.rfidRaw) { this.session.rfid = reading.rfid; this.session.rfidRaw = reading.rfidRaw; }
      return;
    }

    if (!charging && this.session) {
      this.#persistSession(this.session);
      this.session = null;
    }
  }

  /**
   * Schreibt einen abgeschlossenen Ladevorgang in dieselbe Tabelle, die im
   * Connector-Betrieb befüllt wird - Abrechnung/Dashboard unterscheiden nicht
   * nach Quelle.
   * @param {object} session
   */
  #persistSession(session) {
    const energyKwh = (session.lastEnergyWh ?? 0) / 1000;
    const durationSeconds = session.lastDurationS
      ?? Math.round((Date.now() - session.startedAt.getTime()) / 1000);

    if (energyKwh <= 0) {
      // Verbunden, aber nie geladen (z. B. Fahrzeug sofort wieder getrennt) -
      // kein abrechenbarer Vorgang.
      return;
    }

    const end = new Date(session.startedAt.getTime() + durationSeconds * 1000);
    const record = {
      id: `modbus-${session.startedAt.getTime()}`,
      start: session.startedAt,
      end,
      durationSeconds,
      energyKwh,
      rfid: session.rfid || 'unbekannt',
      rfidRaw: session.rfidRaw || '',
    };

    const result = chargingSessions.upsertMany([record], { source: 'modbus' });
    if (result.rejected.length > 0) {
      logger.warn(`Rekonstruierter Ladevorgang abgewiesen: ${result.rejected[0].reason}`);
    } else {
      logger.info(`Ladevorgang erfasst: ${energyKwh.toFixed(2)} kWh, ${Math.round(durationSeconds / 60)} min.`);
    }
  }

  /**
   * Ladevorgänge im Zeitraum [from, to). Es gibt kein Verlaufsregister -
   * geliefert wird, was #trackSession bereits in der Datenbank abgelegt hat.
   * @param {Date} from
   * @param {Date} to
   * @returns {Promise<Array<object>>}
   */
  async getChargingSessions(from, to) {
    return chargingSessions.findInRange(from, to);
  }

  /** @returns {Promise<{reachable: boolean, error?: string}>} */
  async ping() {
    try {
      await this.#read(REG.CHARGE_POINT_STATE, 1);
      return { reachable: true };
    } catch (error) {
      return { reachable: false, error: error.message };
    }
  }

  /**
   * Startet eine eigene, von LiveFeed UNABHÄNGIGE Abfrage für die Sitzungs-
   * Erfassung: LiveFeeds Timer pausiert ohne verbundene Dashboard-Clients
   * (siehe liveFeed.js) - Ladevorgänge müssen aber auch dann erfasst werden,
   * wenn gerade niemand zuschaut.
   * @param {number} [intervalMs]
   */
  startTracking(intervalMs = config.live.pollIntervalMs) {
    if (this.trackingTimer) return;
    this.trackingTimer = setInterval(() => {
      this.getLiveStatus().catch((error) => {
        logger.warn(`Sitzungs-Erfassung (Modbus) fehlgeschlagen: ${error.message}`);
      });
    }, intervalMs);
    if (typeof this.trackingTimer.unref === 'function') this.trackingTimer.unref();
    logger.info(`Sitzungs-Erfassung (Modbus) gestartet (${intervalMs}ms).`);
  }

  /** Stoppt die Sitzungs-Erfassung und schließt die Verbindung (Shutdown). */
  async stopTracking() {
    if (this.trackingTimer) {
      clearInterval(this.trackingTimer);
      this.trackingTimer = null;
    }
    if (this.modbus.isOpen) {
      await new Promise((resolve) => this.modbus.close(resolve)).catch(() => {});
    }
  }
}

module.exports = MennekesModbusClient;
module.exports.MennekesModbusError = MennekesModbusError;
module.exports.REG = REG;
module.exports.asU32 = asU32;
module.exports.asString = asString;
