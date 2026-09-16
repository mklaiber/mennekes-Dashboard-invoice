'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const settingsStore = require('../src/config/settings');

describe('assertProductionSecrets', () => {
  /** Baut eine minimale, gültige Konfiguration zum Abwandeln. */
  function validConfig(overrides = {}) {
    return {
      auth: { password: 'geheim' },
      mennekes: { baseUrl: 'http://wallbox.local', authMode: 'none' },
      ...overrides,
    };
  }

  it('akzeptiert eine vollständige Konfiguration', () => {
    expect(() => config.assertProductionSecrets(validConfig())).not.toThrow();
  });

  it('verlangt AUTH_PASSWORD', () => {
    expect(() => config.assertProductionSecrets(validConfig({ auth: { password: undefined } })))
      .toThrow(/AUTH_PASSWORD/);
  });

  it('verlangt MENNEKES_PASSWORD bei Basic-Auth', () => {
    expect(() => config.assertProductionSecrets(validConfig({
      mennekes: { baseUrl: 'http://wallbox.local', authMode: 'basic', password: undefined },
    }))).toThrow(/MENNEKES_PASSWORD/);
  });

  it('verlangt MENNEKES_TOKEN bei Bearer- und API-Key-Auth', () => {
    for (const authMode of ['bearer', 'apikey']) {
      expect(() => config.assertProductionSecrets(validConfig({
        mennekes: { baseUrl: 'http://wallbox.local', authMode, token: undefined },
      }))).toThrow(/MENNEKES_TOKEN/);
    }
  });

  it('nennt alle fehlenden Variablen auf einmal', () => {
    expect(() => config.assertProductionSecrets({
      auth: { password: undefined },
      mennekes: { baseUrl: '', authMode: 'bearer', token: undefined },
    })).toThrow(/AUTH_PASSWORD.*MENNEKES_BASE_URL.*MENNEKES_TOKEN/);
  });
});

describe('Einstellungs-Speicher', () => {
  beforeEach(() => {
    settingsStore.reset();
    if (fs.existsSync(config.server.settingsFile)) fs.unlinkSync(config.server.settingsFile);
  });

  it('liefert Defaults, wenn noch nichts gespeichert wurde', () => {
    const settings = settingsStore.load({ force: true });

    expect(settings.billing.pricePerKwh).toBe(0.3);
    expect(settings.billing.timezone).toBe('Europe/Berlin');
    expect(settings.rfidMappings).toEqual([]);
  });

  it('merged Teiländerungen, ohne andere Werte zu verlieren', () => {
    settingsStore.save({ billing: { pricePerKwh: 0.5 } });
    settingsStore.save({ billing: { companyName: 'ACME' } });

    const settings = settingsStore.load({ force: true });
    expect(settings.billing.pricePerKwh).toBe(0.5);
    expect(settings.billing.companyName).toBe('ACME');
    // Nicht angefasste Zweige bleiben erhalten.
    expect(settings.mail.from).toBeDefined();
  });

  it('ersetzt Arrays komplett statt sie zu mischen', () => {
    settingsStore.save({ rfidMappings: [{ rfid: 'A', name: 'Alt' }, { rfid: 'B', name: 'Alt2' }] });
    settingsStore.save({ rfidMappings: [{ rfid: 'C', name: 'Neu' }] });

    expect(settingsStore.load({ force: true }).rfidMappings).toEqual([{ rfid: 'C', name: 'Neu' }]);
  });

  it('schreibt die Datei atomar (kein tmp-Rest)', () => {
    settingsStore.save({ billing: { pricePerKwh: 0.33 } });

    const dir = path.dirname(config.server.settingsFile);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(config.server.settingsFile, 'utf8')).billing.pricePerKwh).toBe(0.33);
  });

  it('fällt bei defekter Datei auf Defaults zurück, statt zu crashen', () => {
    fs.mkdirSync(path.dirname(config.server.settingsFile), { recursive: true });
    fs.writeFileSync(config.server.settingsFile, '{ das ist kein JSON', 'utf8');

    const settings = settingsStore.load({ force: true });
    expect(settings.billing.pricePerKwh).toBe(0.3);
  });

  it('cacht Lesezugriffe, bis force übergeben wird', () => {
    const first = settingsStore.load();
    fs.writeFileSync(config.server.settingsFile, JSON.stringify({ billing: { pricePerKwh: 9.99 } }), 'utf8');

    expect(settingsStore.load()).toBe(first);                     // Cache
    expect(settingsStore.load({ force: true }).billing.pricePerKwh).toBe(9.99);
  });
});

describe('normalizeRfid', () => {
  it.each([
    ['04:A1:B2:C3', '04a1b2c3'],
    ['04-a1-b2-c3', '04a1b2c3'],
    ['04 A1 B2 C3', '04a1b2c3'],
    ['04_a1_b2_c3', '04a1b2c3'],
    ['04A1B2C3', '04a1b2c3'],
  ])('%s -> %s', (input, expected) => {
    expect(settingsStore.normalizeRfid(input)).toBe(expected);
  });

  it('ist robust gegen leere Werte', () => {
    expect(settingsStore.normalizeRfid(null)).toBe('');
    expect(settingsStore.normalizeRfid(undefined)).toBe('');
  });
});

describe('rfidLookup', () => {
  it('indiziert nach normalisierter RFID', () => {
    const lookup = settingsStore.rfidLookup([{ rfid: '04:A1:B2:C3', name: 'Max' }]);

    expect(lookup.get('04a1b2c3').name).toBe('Max');
    expect(lookup.size).toBe(1);
  });

  it('überspringt Einträge ohne RFID', () => {
    const lookup = settingsStore.rfidLookup([{ name: 'Ohne ID' }, null, { rfid: 'OK', name: 'Gut' }]);
    expect(lookup.size).toBe(1);
  });
});
