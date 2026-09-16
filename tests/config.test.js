'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const settingsStore = require('../src/repositories/settingsRepository');
const { resetDatabase, createUser } = require('./helpers/testDb');
const database = require('../src/db');

// Jeder Test startet mit einer frischen, leeren Datenbank.
beforeEach(() => {
  resetDatabase();
});

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

describe('Einstellungs-Speicher (SQLite)', () => {
  it('liefert Defaults, wenn noch nichts gespeichert wurde', () => {
    const settings = settingsStore.load({ force: true });

    expect(settings.billing.pricePerKwh).toBe(0.3);
    expect(settings.billing.timezone).toBe('Europe/Berlin');
    expect(settings.billing.margins).toEqual({ top: 20, right: 20, bottom: 20, left: 25 });
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

  it('merged auch verschachtelte Zweige wie die Seitenränder', () => {
    settingsStore.save({ billing: { margins: { left: 30 } } });

    const margins = settingsStore.load({ force: true }).billing.margins;
    expect(margins.left).toBe(30);
    // Die übrigen Ränder behalten ihren Wert.
    expect(margins.top).toBe(20);
    expect(margins.right).toBe(20);
  });

  it('ersetzt die RFID-Liste komplett statt sie zu mischen', () => {
    settingsStore.save({ rfidMappings: [{ rfid: 'AAAA', name: 'Alt' }, { rfid: 'BBBB', name: 'Alt2' }] });
    settingsStore.save({ rfidMappings: [{ rfid: 'CCCC', name: 'Neu' }] });

    const mappings = settingsStore.load({ force: true }).rfidMappings;
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({ rfid: 'cccc', rfidRaw: 'CCCC', name: 'Neu', billable: true });
  });

  it('normalisiert die RFID beim Speichern und behält die Schreibweise', () => {
    settingsStore.save({ rfidMappings: [{ rfid: '04:A1:B2:C3', name: 'Max', plate: 'M-EV 1' }] });

    const entry = settingsStore.load({ force: true }).rfidMappings[0];
    expect(entry.rfid).toBe('04a1b2c3');
    expect(entry.rfidRaw).toBe('04:A1:B2:C3');
  });

  it('lässt doppelte Schreibweisen derselben Karte nicht durch', () => {
    // Ohne diese Abwehr würde das UNIQUE auf der normalisierten ID zuschlagen.
    settingsStore.save({
      rfidMappings: [
        { rfid: '04:A1:B2:C3', name: 'Erster' },
        { rfid: '04a1b2c3', name: 'Zweiter' },
      ],
    });

    const mappings = settingsStore.load({ force: true }).rfidMappings;
    expect(mappings).toHaveLength(1);
    expect(mappings[0].name).toBe('Erster');
  });

  it('verwirft Einträge ohne RFID', () => {
    settingsStore.save({ rfidMappings: [{ rfid: '  ', name: 'Leer' }, { rfid: 'OK01', name: 'Gut' }] });

    expect(settingsStore.load({ force: true }).rfidMappings).toHaveLength(1);
  });

  it('cacht Lesezugriffe, bis force übergeben wird', () => {
    const first = settingsStore.load();
    expect(settingsStore.load()).toBe(first);

    settingsStore.save({ billing: { pricePerKwh: 0.77 } });
    // save() verwirft den Cache selbst.
    expect(settingsStore.load().billing.pricePerKwh).toBe(0.77);
  });

  it('vermerkt, wer zuletzt gespeichert hat', async () => {
    const admin = await createUser({ username: 'pruefer' });
    settingsStore.save({ billing: { pricePerKwh: 0.31 } }, { userId: admin.id });

    const row = database.db().prepare('SELECT updated_by AS updatedBy FROM settings WHERE key = ?').get('billing');
    expect(row.updatedBy).toBe(admin.id);
  });

  it('übernimmt eine vorhandene settings.json einmalig', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-')), 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      billing: { pricePerKwh: 0.55, companyName: 'Aus Datei' },
      rfidMappings: [{ rfid: 'FILE01', name: 'Aus Datei' }],
    }), 'utf8');

    expect(settingsStore.migrateFromJsonFile(file)).toBe(true);

    const settings = settingsStore.load({ force: true });
    expect(settings.billing.pricePerKwh).toBe(0.55);
    expect(settings.billing.companyName).toBe('Aus Datei');
    expect(settings.rfidMappings[0].rfid).toBe('file01');

    // Die Datei wird umbenannt, damit die Migration nicht erneut läuft.
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.migrated`)).toBe(true);
  });

  it('migriert nicht, wenn bereits Einstellungen in der Datenbank stehen', () => {
    settingsStore.save({ billing: { pricePerKwh: 0.99 } });

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-')), 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ billing: { pricePerKwh: 0.11 } }), 'utf8');

    expect(settingsStore.migrateFromJsonFile(file)).toBe(false);
    expect(settingsStore.load({ force: true }).billing.pricePerKwh).toBe(0.99);
  });

  it('übersteht eine defekte settings.json ohne Absturz', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-')), 'settings.json');
    fs.writeFileSync(file, '{ das ist kein JSON', 'utf8');

    expect(settingsStore.migrateFromJsonFile(file)).toBe(false);
    expect(settingsStore.load({ force: true }).billing.pricePerKwh).toBe(0.3);
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

describe('Datenbankpfad', () => {
  it('lässt den SQLite-Sonderwert ":memory:" unangetastet', () => {
    // path.resolve(':memory:') ergäbe einen absoluten Pfad - SQLite legte dann
    // eine echte Datei namens ":memory:" im Arbeitsverzeichnis an.
    const original = process.env.DATABASE_FILE;
    process.env.DATABASE_FILE = ':memory:';
    try {
      jest.resetModules();
      const fresh = require('../src/config');
      expect(fresh.server.databaseFile).toBe(':memory:');
    } finally {
      process.env.DATABASE_FILE = original;
      jest.resetModules();
    }
  });

  it('löst einen normalen Pfad absolut auf', () => {
    const original = process.env.DATABASE_FILE;
    process.env.DATABASE_FILE = 'data/beispiel.sqlite';
    try {
      jest.resetModules();
      const fresh = require('../src/config');
      expect(path.isAbsolute(fresh.server.databaseFile)).toBe(true);
      expect(fresh.server.databaseFile).toMatch(/beispiel\.sqlite$/);
    } finally {
      process.env.DATABASE_FILE = original;
      jest.resetModules();
    }
  });
});
