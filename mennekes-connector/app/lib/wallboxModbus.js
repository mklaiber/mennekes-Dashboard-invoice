'use strict';

/**
 * Modbus-TCP-Zugriff auf die Wallbox im Heimnetz - für Geräte ohne
 * REST-Schnittstelle (MENNEKES AMTRON Professional/Professional+/
 * ChargeControl, AMEDIO Professional, Bender CC612/613, ...).
 *
 * Register-Adressen und Bedeutung aus dem quelloffenen evcc-Treiber
 * (github.com/evcc-io/evcc, charger/bender.go, Typ "bender") - dessen
 * Template "bender-cc" listet "AMTRON Professional" explizit als
 * unterstütztes Produkt.
 *
 * Voraussetzung an der Wallbox: "Modbus TCP Server für
 * Energiemanagement-Systeme" aktiviert, "Registersatz" auf
 * "Ebee"/"Bender"/"MENNEKES" (NICHT "Phoenix"/"TQ-DM100"), "UID Übertragung
 * erlauben" aktiviert.
 *
 * Bewusst KEINE Feld-Normalisierung hier (wie bei lib/wallbox.js): die
 * Register werden auf dieselbe AMTRON-Feldbenennung abgebildet, die das
 * Online-Tool bereits über die REST-Variante kennt (ChgState-Buchstabe als
 * `status`, `ActPwr`, `ChgNrg`, `Uid`, `Start`/`Stop`/`ChrNr`) - damit
 * versteht die vorhandene Normalisierung (MennekesClient#normalizeStatus/
 * #normalizeSession) Modbus-Daten, ohne dass sich dort etwas ändern muss.
 *
 * Es gibt auch über Modbus KEIN Verlaufsregister - nur den aktuellen
 * Zustand. Abgeschlossene Ladevorgänge werden deshalb selbst aus
 * aufeinanderfolgenden getStatus()-Aufrufen rekonstruiert und über
 * getSessions() ausgeliefert, genau wie es der bestehende
 * statusTick()/sessionsTick()-Takt in index.js schon erwartet.
 */

const ModbusRTU = require('modbus-serial');
const logger = require('./logger');

const REG = {
  CHARGE_POINT_MODEL: 142,
  CHARGE_POINT_STATE: 122,
  ACTIVE_POWER: 220,
  TOTAL_ENERGY: 218,
  CHARGED_ENERGY: 716,
  CHARGING_DURATION: 718,
  USER_ID: 720,
  LEGACY_PHASE_ENERGY: 200,
};

const MAX_UINT32 = 0xffffffff;
/** Control-Pilot-Register -> IEC-61851-Buchstabe, den das Online-Tool schon kennt. */
const CP_STATE_LETTER = { 1: 'A', 2: 'B', 3: 'C', 4: 'D' };

function asU32(result) {
  const value = result.buffer.readUInt32BE(0);
  return value === MAX_UINT32 ? null : value;
}

function asString(result) {
  return result.buffer.toString('latin1').replace(/\0/g, '').trim();
}

class WallboxModbus {
  /**
   * @param {object} options siehe lib/options.js (Zweig `wallbox`)
   * @param {object} [modbusClient] für Tests injizierbar (Ersatz für ModbusRTU-Instanz)
   */
  constructor(options, modbusClient) {
    this.host = options.modbusHost || hostFromUrl(options.baseUrl);
    this.port = options.modbusPort || 502;
    this.unitId = options.modbusUnitId || 255;
    this.timeoutMs = options.timeoutMs || 5000;
    this.modbus = modbusClient || new ModbusRTU();

    this.connecting = null;
    this.legacy = null;
    /** @type {{startedAt: Date, uid: string|null, lastEnergyWh: number|null, lastDurationS: number|null}|null} */
    this.session = null;
    /** Seit dem letzten getSessions()-Aufruf abgeschlossene Ladevorgänge. */
    this.completedSessions = [];
  }

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

  async #read(address, length) {
    await this.#ensureConnected();
    try {
      return await this.modbus.readHoldingRegisters(address, length);
    } catch (error) {
      if (this.modbus.isOpen) {
        try { this.modbus.close(() => {}); } catch { /* bereits zu */ }
      }
      throw new Error(`Modbus-Zugriff auf Register ${address} fehlgeschlagen: ${error.message}`);
    }
  }

  async #readU32(address) {
    return asU32(await this.#read(address, 2));
  }

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
   * Aktueller Zustand, in AMTRON-REST-Feldbenennung (siehe Datei-Kommentar).
   * @returns {Promise<object>}
   */
  async getStatus() {
    await this.#ensureRegisterSet();

    const stateResult = await this.#read(REG.CHARGE_POINT_STATE, 1);
    const stateValue = stateResult.data[0];
    const status = CP_STATE_LETTER[stateValue] || null;

    const activePowerW = this.legacy ? null : await this.#readU32(REG.ACTIVE_POWER);
    const totalEnergyWh = this.legacy
      ? await this.#legacyTotalEnergyWh()
      : await this.#readU32(REG.TOTAL_ENERGY);

    let chargedEnergyWh = null;
    let chargingDurationS = null;
    let uid = null;
    try {
      chargedEnergyWh = await this.#readU32(REG.CHARGED_ENERGY);
      chargingDurationS = await this.#readU32(REG.CHARGING_DURATION);
      uid = asString(await this.#read(REG.USER_ID, 10)) || null;
    } catch (error) {
      logger.debug(`Sitzungsregister nicht lesbar: ${error.message}`);
    }

    this.#trackSession(status, { chargedEnergyWh, chargingDurationS, uid });

    return {
      status,
      ActPwr: activePowerW,
      ChgNrg: chargedEnergyWh,
      totalEnergy: totalEnergyWh,
      energyUnit: 'Wh',
      Uid: uid,
    };
  }

  /**
   * Baut abgeschlossene Ladevorgänge aus aufeinanderfolgenden
   * Zustandswechseln zusammen - es gibt kein Verlaufsregister. Geschrieben
   * wird nur EINMAL, beim Übergang von "lädt" zu "lädt nicht mehr", mit dem
   * zuletzt bekannten guten Stand (nicht dem aktuellen, der nach
   * Sitzungsende bereits zurückgesetzt sein kann).
   */
  #trackSession(status, reading) {
    const charging = status === 'C' || status === 'D';

    if (charging && !this.session) {
      const startedAt = Number.isFinite(reading.chargingDurationS)
        ? new Date(Date.now() - reading.chargingDurationS * 1000)
        : new Date();
      this.session = {
        startedAt, uid: reading.uid, lastEnergyWh: reading.chargedEnergyWh, lastDurationS: reading.chargingDurationS,
      };
      return;
    }

    if (charging && this.session) {
      if (reading.chargedEnergyWh !== null) this.session.lastEnergyWh = reading.chargedEnergyWh;
      if (reading.chargingDurationS !== null) this.session.lastDurationS = reading.chargingDurationS;
      if (reading.uid) this.session.uid = reading.uid;
      return;
    }

    if (!charging && this.session) {
      this.#finishSession(this.session);
      this.session = null;
    }
  }

  #finishSession(session) {
    const energyWh = session.lastEnergyWh ?? 0;
    if (energyWh <= 0) return; // verbunden, aber nie geladen - kein abrechenbarer Vorgang

    const durationS = session.lastDurationS ?? Math.round((Date.now() - session.startedAt.getTime()) / 1000);
    const stopMs = session.startedAt.getTime() + durationS * 1000;

    this.completedSessions.push({
      Start: Math.floor(session.startedAt.getTime() / 1000),
      Stop: Math.floor(stopMs / 1000),
      ChrNr: energyWh,
      Uid: session.uid || 'anon',
    });
  }

  /**
   * Seit dem letzten Aufruf abgeschlossene Ladevorgänge. `since` bleibt Teil
   * der Signatur (Konsistenz mit lib/wallbox.js), wird hier aber nicht
   * gebraucht: es gibt kein Verlaufsregister, geliefert wird ausschließlich,
   * was #trackSession seit dem letzten Abruf selbst beobachtet hat.
   * @returns {Promise<Array<object>>}
   */
  async getSessions() {
    const sessions = this.completedSessions;
    this.completedSessions = [];
    return sessions;
  }

  /** @returns {Promise<{reachable:boolean, error?:string}>} */
  async ping() {
    try {
      await this.#read(REG.CHARGE_POINT_STATE, 1);
      return { reachable: true };
    } catch (error) {
      return { reachable: false, error: error.message };
    }
  }

  /** Verbindung schließen (Shutdown). */
  async close() {
    if (this.modbus.isOpen) {
      await new Promise((resolve) => this.modbus.close(resolve)).catch(() => {});
    }
  }
}

/** Extrahiert den Hostnamen aus wallbox_url, falls modbusHost nicht gesetzt ist. */
function hostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

module.exports = WallboxModbus;
