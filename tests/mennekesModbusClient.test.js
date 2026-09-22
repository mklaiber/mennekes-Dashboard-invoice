'use strict';

const MennekesModbusClient = require('../src/services/mennekesModbusClient');
const chargingSessions = require('../src/repositories/chargingSessionRepository');
const { resetDatabase } = require('./helpers/testDb');

const REG = MennekesModbusClient.REG;
const MAX_UINT32 = 0xffffffff;

/** Kodiert einen Text als Registerwerte (2 Byte je Register, latin1, nullgepolstert). */
function stringToRegisters(text, registerCount) {
  const buffer = Buffer.alloc(registerCount * 2);
  buffer.write(text, 'latin1');
  const values = [];
  for (let i = 0; i < registerCount; i += 1) values.push(buffer.readUInt16BE(i * 2));
  return values;
}

/** Kodiert eine oder mehrere 32-Bit-Zahlen als Registerwerte (Big Endian, 2 Register je Zahl). */
function u32ToRegisters(...numbers) {
  const buffer = Buffer.alloc(numbers.length * 4);
  numbers.forEach((n, i) => buffer.writeUInt32BE(n >>> 0, i * 4));
  const values = [];
  for (let i = 0; i < numbers.length * 2; i += 1) values.push(buffer.readUInt16BE(i * 2));
  return values;
}

/**
 * Minimaler modbus-serial-Ersatz: liefert vorgegebene Registerwerte je Adresse.
 * @param {Record<number, number[]|Error>} registers
 */
function fakeModbus(registers) {
  const calls = [];
  return {
    isOpen: false,
    calls,
    async connectTCP(host, options) {
      calls.push({ type: 'connect', host, options });
      this.isOpen = true;
    },
    setID(id) { calls.push({ type: 'setID', id }); },
    setTimeout(ms) { calls.push({ type: 'setTimeout', ms }); },
    async readHoldingRegisters(address, length) {
      calls.push({ type: 'read', address, length });
      const entry = registers[address];
      if (entry === undefined) {
        const error = new Error(`kein Register ${address} definiert`);
        throw error;
      }
      if (entry instanceof Error) throw entry;
      const values = typeof entry === 'function' ? entry() : entry;
      const buffer = Buffer.alloc(values.length * 2);
      values.forEach((v, i) => buffer.writeUInt16BE(v, i * 2));
      return { data: values, buffer };
    },
    close(cb) { this.isOpen = false; if (cb) cb(); },
  };
}

/** Register-Basisbelegung für eine idle Wallbox (aktueller Registersatz, nicht legacy). */
function baseRegisters(overrides = {}) {
  return {
    [REG.CHARGE_POINT_MODEL]: stringToRegisters('AMTRON Professional', 10),
    [REG.CHARGE_POINT_STATE]: [1],
    [REG.ACTIVE_POWER]: u32ToRegisters(0),
    [REG.TOTAL_ENERGY]: u32ToRegisters(4211700),
    [REG.CHARGED_ENERGY]: u32ToRegisters(0),
    [REG.CHARGING_DURATION]: u32ToRegisters(0),
    [REG.USER_ID]: stringToRegisters('', 10),
    [REG.CURRENTS]: u32ToRegisters(0, 0, 0),
    [REG.VOLTAGES]: u32ToRegisters(230, 230, 230),
    ...overrides,
  };
}

beforeEach(() => {
  resetDatabase();
});

describe('getLiveStatus', () => {
  it('meldet "standby" bei Control-Pilot-Status A (1)', async () => {
    const client = new MennekesModbusClient({ host: 'x', modbusClient: fakeModbus(baseRegisters()) });

    const state = await client.getLiveStatus();

    expect(state.status).toBe('standby');
    expect(state.vehicleConnected).toBe(false);
    expect(state.powerKw).toBe(0);
  });

  it('meldet "connected" bei Status B (2) und "charging" bei C/D (3/4)', async () => {
    for (const [reg, expected] of [[2, 'connected'], [3, 'charging'], [4, 'charging']]) {
      const client = new MennekesModbusClient({
        host: 'x', modbusClient: fakeModbus(baseRegisters({ [REG.CHARGE_POINT_STATE]: [reg] })),
      });
      const state = await client.getLiveStatus();
      expect(state.status).toBe(expected);
    }
  });

  it('rechnet Leistung (W) und Zählerstand (Wh) korrekt in kW/kWh um', async () => {
    const client = new MennekesModbusClient({
      host: 'x',
      modbusClient: fakeModbus(baseRegisters({
        [REG.CHARGE_POINT_STATE]: [3],
        [REG.ACTIVE_POWER]: u32ToRegisters(11040),
        [REG.TOTAL_ENERGY]: u32ToRegisters(4211700),
        [REG.CHARGED_ENERGY]: u32ToRegisters(8420),
        [REG.USER_ID]: stringToRegisters('04A1B2C3', 10),
      })),
    });

    const state = await client.getLiveStatus();

    expect(state.powerKw).toBe(11.04);
    expect(state.meterKwh).toBe(4211.7);
    expect(state.energySessionKwh).toBe(8.42);
    expect(state.rfidRaw).toBe('04A1B2C3');
    expect(state.rfid).toBe('04a1b2c3');
  });

  it('behandelt den bekannten Firmware-Aussetzer (0xFFFFFFFF) als "nicht verfügbar", nicht als Messwert', async () => {
    const client = new MennekesModbusClient({
      host: 'x',
      modbusClient: fakeModbus(baseRegisters({
        [REG.ACTIVE_POWER]: u32ToRegisters(MAX_UINT32),
        [REG.TOTAL_ENERGY]: u32ToRegisters(MAX_UINT32),
      })),
    });

    const state = await client.getLiveStatus();

    expect(state.powerKw).toBe(0);
    expect(state.meterKwh).toBeNull();
  });

  it('fällt auf den Legacy-Registersatz zurück, wenn Register 142 nicht antwortet', async () => {
    const registers = baseRegisters();
    delete registers[REG.CHARGE_POINT_MODEL];
    registers[REG.LEGACY_PHASE_ENERGY] = u32ToRegisters(1000000, 1000000, 1000000);

    const client = new MennekesModbusClient({ host: 'x', modbusClient: fakeModbus(registers) });
    const state = await client.getLiveStatus();

    // Legacy: kein direktes Leistungsregister, Zählerstand als Summe der drei Phasen.
    expect(state.powerKw).toBe(0);
    expect(state.meterKwh).toBe(3000);
  });

  it('bleibt funktionsfähig, wenn die Sitzungsregister fehlen (z. B. 4You/4Business)', async () => {
    const registers = baseRegisters();
    delete registers[REG.CHARGED_ENERGY];

    const client = new MennekesModbusClient({ host: 'x', modbusClient: fakeModbus(registers) });
    const state = await client.getLiveStatus();

    expect(state.status).toBe('standby');
    expect(state.energySessionKwh).toBeNull();
  });
});

describe('Sitzungs-Rekonstruktion', () => {
  it('legt beim Übergang von "lädt" zu "lädt nicht mehr" genau einen Ladevorgang an', async () => {
    const modbus = fakeModbus(baseRegisters({
      [REG.CHARGE_POINT_STATE]: [3],
      [REG.CHARGED_ENERGY]: u32ToRegisters(5000),
      [REG.CHARGING_DURATION]: u32ToRegisters(1800),
      [REG.USER_ID]: stringToRegisters('04A1B2C3', 10),
    }));
    const client = new MennekesModbusClient({ host: 'x', modbusClient: modbus });

    await client.getLiveStatus(); // Sitzung beginnt

    expect(chargingSessions.count()).toBe(0);

    // Sitzung endet: Status springt auf "kein Fahrzeug".
    modbus.readHoldingRegisters = async (address) => {
      const registers = baseRegisters({ [REG.CHARGE_POINT_STATE]: [1] });
      const values = registers[address];
      const buffer = Buffer.alloc(values.length * 2);
      values.forEach((v, i) => buffer.writeUInt16BE(v, i * 2));
      return { data: values, buffer };
    };
    await client.getLiveStatus();

    expect(chargingSessions.count()).toBe(1);
    const [session] = chargingSessions.findInRange(new Date(0), new Date(Date.now() + 86400000));
    expect(session.energyKwh).toBe(5);
    expect(session.durationSeconds).toBe(1800);
    expect(session.rfidRaw).toBe('04A1B2C3');
  });

  it('legt keinen Ladevorgang an, wenn verbunden, aber nie geladen wurde', async () => {
    const modbus = fakeModbus(baseRegisters({ [REG.CHARGE_POINT_STATE]: [2] }));
    const client = new MennekesModbusClient({ host: 'x', modbusClient: modbus });

    await client.getLiveStatus(); // nur "verbunden", nie "lädt"

    modbus.readHoldingRegisters = async (address) => {
      const registers = baseRegisters({ [REG.CHARGE_POINT_STATE]: [1] });
      const values = registers[address];
      const buffer = Buffer.alloc(values.length * 2);
      values.forEach((v, i) => buffer.writeUInt16BE(v, i * 2));
      return { data: values, buffer };
    };
    await client.getLiveStatus();

    expect(chargingSessions.count()).toBe(0);
  });

  it('getChargingSessions liefert rekonstruierte Vorgänge aus der Datenbank', async () => {
    chargingSessions.upsertMany([{
      id: 'modbus-test-1', start: new Date('2026-03-01T10:00:00Z'), end: new Date('2026-03-01T11:00:00Z'),
      durationSeconds: 3600, energyKwh: 7.5, rfid: 'abc', rfidRaw: 'ABC',
    }], { source: 'modbus' });

    const client = new MennekesModbusClient({ host: 'x', modbusClient: fakeModbus(baseRegisters()) });
    const sessions = await client.getChargingSessions(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'));

    expect(sessions).toHaveLength(1);
    expect(sessions[0].energyKwh).toBe(7.5);
  });
});

describe('ping', () => {
  it('meldet Erreichbarkeit', async () => {
    const client = new MennekesModbusClient({ host: 'x', modbusClient: fakeModbus(baseRegisters()) });
    await expect(client.ping()).resolves.toEqual({ reachable: true });
  });

  it('meldet Nichterreichbarkeit ohne zu werfen', async () => {
    const modbus = fakeModbus({});
    modbus.connectTCP = async () => { throw new Error('ECONNREFUSED'); };
    const client = new MennekesModbusClient({ host: 'x', modbusClient: modbus });

    const result = await client.ping();
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});
