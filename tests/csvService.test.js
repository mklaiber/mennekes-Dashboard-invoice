'use strict';

const { buildDetailCsv, buildSummaryCsv, csvFileName, decimal, hhmm, UTF8_BOM } = require('../src/services/csvService');
const { buildMonthlyReport } = require('../src/services/billing');
const { rfidLookup } = require('../src/repositories/settingsRepository');
const { resetDatabase } = require('./helpers/testDb');
const MennekesClient = require('../src/services/mennekesClient');
const fixtures = require('./fixtures/wallbox');

beforeEach(() => {
  resetDatabase();
});

function makeReport(overrides = {}) {
  const sessions = fixtures.sessionsMarch2026.transactions
    .map((entry) => MennekesClient.normalizeSession(entry))
    .filter(Boolean);

  return buildMonthlyReport({
    sessions,
    year: 2026,
    month: 3,
    pricePerKwh: 0.3,
    rfidLookup: rfidLookup(fixtures.rfidMappings),
    timezone: 'Europe/Berlin',
    ...overrides,
  });
}

describe('CSV-Hilfsfunktionen', () => {
  it('decimal() nutzt das deutsche Komma', () => {
    expect(decimal(24.5, 3)).toBe('24,500');
    expect(decimal(0.3, 2)).toBe('0,30');
    expect(decimal(24.5, 3, false)).toBe('24.500');
    expect(decimal(null)).toBe('');
    expect(decimal(undefined)).toBe('');
  });

  it('hhmm() formatiert Sekunden', () => {
    expect(hhmm(3600)).toBe('01:00');
    expect(hhmm(11700)).toBe('03:15');
    expect(hhmm(0)).toBe('00:00');
    expect(hhmm(-1)).toBe('');
  });

  it('csvFileName() folgt dem Namensschema', () => {
    const report = makeReport();
    expect(csvFileName(report, 'detail')).toBe('ladestrom_2026-03_detail.csv');
    expect(csvFileName(report, 'summe')).toBe('ladestrom_2026-03_summe.csv');
  });
});

describe('buildDetailCsv', () => {
  it('beginnt mit BOM und Kopfzeile', () => {
    const csv = buildDetailCsv(makeReport());

    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    const header = csv.slice(1).split('\r\n')[0];
    expect(header).toContain('"Datum"');
    expect(header).toContain('"Energie (kWh)"');
    expect(header).toContain('"RFID"');
    expect(header.split(';').length).toBe(18);
  });

  it('enthält eine Zeile pro Ladevorgang', () => {
    const csv = buildDetailCsv(makeReport());
    const lines = csv.trim().split('\r\n');

    expect(lines.length).toBe(1 + 4); // Kopfzeile + 4 Vorgänge
  });

  it('schreibt Werte in deutscher Zahlenschreibweise', () => {
    const csv = buildDetailCsv(makeReport());

    expect(csv).toContain('"24,500"');  // Energie
    expect(csv).toContain('"7,35"');    // Betrag 24.5 * 0.30
    expect(csv).toContain('"0,3000"');  // Arbeitspreis
  });

  it('nutzt Semikolon als Trenner (deutsches Excel)', () => {
    const csv = buildDetailCsv(makeReport());
    const dataLine = csv.trim().split('\r\n')[1];

    expect(dataLine.split(';').length).toBe(18);
  });

  it('erlaubt Komma-Trenner und Punkt-Dezimale für internationale Tools', () => {
    const csv = buildDetailCsv(makeReport(), { delimiter: ',', decimalComma: false, withBom: false });

    expect(csv.startsWith(UTF8_BOM)).toBe(false);
    expect(csv).toContain('"24.500"');
  });

  it('gibt bei leerem Monat trotzdem die Kopfzeile aus', () => {
    const csv = buildDetailCsv(makeReport({ sessions: [] }));
    const lines = csv.trim().split('\r\n');

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('Datum');
  });

  it('markiert nicht abrechenbare Vorgänge', () => {
    const report = makeReport({
      rfidLookup: rfidLookup([{ rfid: '04A1B2C3', name: 'Privat', billable: false }]),
    });
    const csv = buildDetailCsv(report);

    expect(csv).toContain('"nein"');
    expect(csv).toContain('"ja"'); // die übrigen bleiben abrechenbar
  });

  it('enthält ISO-Zeitstempel für die maschinelle Weiterverarbeitung', () => {
    const csv = buildDetailCsv(makeReport());
    expect(csv).toContain('2026-03-02T06:30:00.000Z');
  });

  it('maskiert Feldtrenner in Namen korrekt', () => {
    const report = makeReport({
      rfidLookup: rfidLookup([{ rfid: '04A1B2C3', name: 'Muster; Max', plate: 'M-EV 1234' }]),
    });
    const csv = buildDetailCsv(report);

    // Der Name steht in Anführungszeichen, der Datensatz behält seine Spaltenzahl.
    expect(csv).toContain('"Muster; Max"');
    const dataLine = csv.trim().split('\r\n')[1];
    expect(dataLine.match(/"/g).length % 2).toBe(0);
  });
});

describe('buildSummaryCsv', () => {
  it('enthält eine Zeile je Ladekarte plus Gesamtzeile', () => {
    const csv = buildSummaryCsv(makeReport());
    const lines = csv.trim().split('\r\n');

    expect(lines.length).toBe(1 + 3 + 1); // Kopf + 3 Karten + GESAMT
    expect(lines[lines.length - 1]).toContain('GESAMT');
  });

  it('weist die richtigen Summen aus', () => {
    const csv = buildSummaryCsv(makeReport());
    const total = csv.trim().split('\r\n').pop();

    expect(total).toContain('"76,125"'); // Gesamtenergie
    expect(total).toContain('"22,84"');  // Gesamtbetrag
  });

  it('funktioniert auch bei leerem Monat', () => {
    const csv = buildSummaryCsv(makeReport({ sessions: [] }));
    const lines = csv.trim().split('\r\n');

    expect(lines.length).toBe(2); // Kopf + GESAMT
    expect(lines[1]).toContain('"0,000"');
  });
});
