'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const WallboxModbus = require('../lib/wallboxModbus');

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

function stringToRegisters(text, registerCount) {
  const buffer = Buffer.alloc(registerCount * 2);
  buffer.write(text, 'latin1');
  const values = [];
  for (let i = 0; i < registerCount; i += 1) values.push(buffer.readUInt16BE(i * 2));
  return values;
}

function u32ToRegisters(...numbers) {
  const buffer = Buffer.alloc(numbers.length * 4);
  numbers.forEach((n, i) => buffer.writeUInt32BE(n >>> 0, i * 4));
  const values = [];
  for (let i = 0; i < numbers.length * 2; i += 1) values.push(buffer.readUInt16BE(i * 2));
  return values;
}

/** Minimaler modbus-serial-Ersatz: liefert vorgegebene Registerwerte je Adresse. */
function fakeModbus(registers) {
  return {
    isOpen: false,
    async connectTCP() { this.isOpen = true; },
    setID() {},
    setTimeout() {},
    async readHoldingRegisters(address) {
      const entry = registers[address];
      if (entry === undefined) throw new Error(`kein Register ${address} definiert`);
      const values = typeof entry === 'function' ? entry() : entry;
      const buffer = Buffer.alloc(values.length * 2);
      values.forEach((v, i) => buffer.writeUInt16BE(v, i * 2));
      return { data: values, buffer };
    },
    close(cb) { this.isOpen = false; if (cb) cb(); },
  };
}

function baseRegisters(overrides = {}) {
  return {
    [REG.CHARGE_POINT_MODEL]: stringToRegisters('AMTRON Professional', 10),
    [REG.CHARGE_POINT_STATE]: [1],
    [REG.ACTIVE_POWER]: u32ToRegisters(0),
    [REG.TOTAL_ENERGY]: u32ToRegisters(0),
    [REG.CHARGED_ENERGY]: u32ToRegisters(0),
    [REG.CHARGING_DURATION]: u32ToRegisters(0),
    [REG.USER_ID]: stringToRegisters('', 10),
    ...overrides,
  };
}

describe('WallboxModbus.getStatus', () => {
  test('liefert die AMTRON-Feldbenennung, die das Online-Tool schon kennt', async () => {
    const wallbox = new WallboxModbus(
      { baseUrl: 'http://192.168.1.50' },
      fakeModbus(baseRegisters({
        [REG.CHARGE_POINT_STATE]: [3],
        [REG.ACTIVE_POWER]: u32ToRegisters(11040),
        [REG.TOTAL_ENERGY]: u32ToRegisters(4211700),
        [REG.CHARGED_ENERGY]: u32ToRegisters(8420),
        [REG.USER_ID]: stringToRegisters('04A1B2C3', 10),
      }))
    );

    const status = await wallbox.getStatus();

    assert.strictEqual(status.status, 'C');
    assert.strictEqual(status.ActPwr, 11040);
    assert.strictEqual(status.ChgNrg, 8420);
    assert.strictEqual(status.totalEnergy, 4211700);
    assert.strictEqual(status.energyUnit, 'Wh');
    assert.strictEqual(status.Uid, '04A1B2C3');
  });

  test('leitet den Modbus-Host aus wallbox_url ab, wenn kein eigener Host gesetzt ist', async () => {
    const modbus = fakeModbus(baseRegisters());
    const wallbox = new WallboxModbus({ baseUrl: 'http://192.168.178.47' }, modbus);

    await wallbox.getStatus();

    assert.strictEqual(wallbox.host, '192.168.178.47');
  });

  test('behandelt 0xFFFFFFFF als "nicht verfügbar"', async () => {
    const wallbox = new WallboxModbus(
      { baseUrl: 'http://x' },
      fakeModbus(baseRegisters({ [REG.ACTIVE_POWER]: u32ToRegisters(0xffffffff) }))
    );

    const status = await wallbox.getStatus();
    assert.strictEqual(status.ActPwr, null);
  });
});

describe('WallboxModbus Sitzungs-Rekonstruktion', () => {
  test('sammelt beim Übergang "lädt" -> "lädt nicht mehr" genau einen Vorgang für getSessions()', async () => {
    const modbus = fakeModbus(baseRegisters({
      [REG.CHARGE_POINT_STATE]: [3],
      [REG.CHARGED_ENERGY]: u32ToRegisters(5000),
      [REG.CHARGING_DURATION]: u32ToRegisters(1800),
      [REG.USER_ID]: stringToRegisters('04A1B2C3', 10),
    }));
    const wallbox = new WallboxModbus({ baseUrl: 'http://x' }, modbus);

    await wallbox.getStatus(); // Sitzung beginnt
    assert.deepStrictEqual(await wallbox.getSessions(new Date(0)), []);

    modbus.readHoldingRegisters = async (address) => {
      const registers = baseRegisters({ [REG.CHARGE_POINT_STATE]: [1] });
      const values = registers[address];
      const buffer = Buffer.alloc(values.length * 2);
      values.forEach((v, i) => buffer.writeUInt16BE(v, i * 2));
      return { data: values, buffer };
    };
    await wallbox.getStatus(); // Sitzung endet

    const sessions = await wallbox.getSessions(new Date(0));
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].ChrNr, 5000);
    assert.strictEqual(sessions[0].Uid, '04A1B2C3');
    assert.strictEqual(sessions[0].Stop - sessions[0].Start, 1800);

    // Einmal ausgeliefert, nicht nochmal.
    assert.deepStrictEqual(await wallbox.getSessions(new Date(0)), []);
  });

  test('meldet keinen Vorgang, wenn verbunden, aber nie geladen wurde', async () => {
    const modbus = fakeModbus(baseRegisters({ [REG.CHARGE_POINT_STATE]: [2] }));
    const wallbox = new WallboxModbus({ baseUrl: 'http://x' }, modbus);

    await wallbox.getStatus();

    modbus.readHoldingRegisters = async (address) => {
      const registers = baseRegisters({ [REG.CHARGE_POINT_STATE]: [1] });
      const values = registers[address];
      const buffer = Buffer.alloc(values.length * 2);
      values.forEach((v, i) => buffer.writeUInt16BE(v, i * 2));
      return { data: values, buffer };
    };
    await wallbox.getStatus();

    assert.deepStrictEqual(await wallbox.getSessions(new Date(0)), []);
  });
});

describe('WallboxModbus.ping', () => {
  test('meldet Erreichbarkeit', async () => {
    const wallbox = new WallboxModbus({ baseUrl: 'http://x' }, fakeModbus(baseRegisters()));
    assert.deepStrictEqual(await wallbox.ping(), { reachable: true });
  });

  test('meldet Nichterreichbarkeit ohne zu werfen', async () => {
    const modbus = fakeModbus({});
    modbus.connectTCP = async () => { throw new Error('ECONNREFUSED'); };
    const wallbox = new WallboxModbus({ baseUrl: 'http://x' }, modbus);

    const result = await wallbox.ping();
    assert.strictEqual(result.reachable, false);
    assert.match(result.error, /ECONNREFUSED/);
  });
});
