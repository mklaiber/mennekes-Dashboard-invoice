'use strict';

const { buildMonthlyReport, calculateCost, resolveRfid, round, formatCurrency } = require('../src/services/billing');
const { rfidLookup } = require('../src/repositories/settingsRepository');
const { resetDatabase } = require('./helpers/testDb');
const MennekesClient = require('../src/services/mennekesClient');
const fixtures = require('./fixtures/wallbox');

beforeEach(() => {
  resetDatabase();
});

/** Baut aus den Fixtures normalisierte Sessions - so, wie der Client sie liefert. */
function fixtureSessions() {
  return fixtures.sessionsMarch2026.transactions
    .map((entry) => MennekesClient.normalizeSession(entry))
    .filter(Boolean);
}

const LOOKUP = rfidLookup(fixtures.rfidMappings);

describe('Kostenberechnung', () => {
  it.each([
    [10, 0.3, 3],
    [24.5, 0.3, 7.35],
    [0, 0.42, 0],
    [1, 0, 0],
    [33.333, 0.2987, 9.96],
  ])('%s kWh * %s = %s', (kwh, price, expected) => {
    expect(calculateCost(kwh, price)).toBe(expected);
  });

  it('rundet kaufmännisch auf Cent', () => {
    // 12.345 * 0.30 = 3.7035 -> 3.70
    expect(calculateCost(12.345, 0.3)).toBe(3.7);
    // 10.05 * 0.5 = 5.025 -> 5.03 (nicht 5.02 durch Float-Artefakt)
    expect(calculateCost(10.05, 0.5)).toBe(5.03);
  });

  it('behandelt ungültige Eingaben als 0', () => {
    expect(calculateCost(NaN, 0.3)).toBe(0);
    expect(calculateCost(10, undefined)).toBe(0);
    expect(calculateCost(null, null)).toBe(0);
  });

  it('round() vermeidet Float-Artefakte', () => {
    expect(round(0.1 + 0.2, 2)).toBe(0.3);
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(2.675, 2)).toBe(2.68);
  });
});

describe('resolveRfid', () => {
  it('löst eine bekannte Karte auf', () => {
    expect(resolveRfid('04a1b2c3', LOOKUP)).toEqual({
      name: 'Max Mustermann', plate: 'M-EV 1234', billable: true, known: true,
    });
  });

  it('ignoriert Trennzeichen und Gross-/Kleinschreibung', () => {
    expect(resolveRfid('04:A1:B2:C3', LOOKUP).name).toBe('Max Mustermann');
    expect(resolveRfid('04-a1-b2-c3', LOOKUP).name).toBe('Max Mustermann');
  });

  it('markiert unbekannte Karten, rechnet sie aber ab', () => {
    const identity = resolveRfid('deadbeef', LOOKUP);
    expect(identity.known).toBe(false);
    expect(identity.name).toContain('deadbeef');
    expect(identity.billable).toBe(true);
  });

  it('respektiert billable=false', () => {
    const lookup = rfidLookup([{ rfid: 'PRIVAT01', name: 'Privat', billable: false }]);
    expect(resolveRfid('privat01', lookup).billable).toBe(false);
  });
});

describe('buildMonthlyReport', () => {
  const baseParams = {
    year: 2026,
    month: 3,
    pricePerKwh: 0.3,
    rfidLookup: LOOKUP,
    timezone: 'Europe/Berlin',
  };

  it('erzeugt den Zeitraum korrekt', () => {
    const report = buildMonthlyReport({ ...baseParams, sessions: [] });

    expect(report.period.label).toBe('März 2026');
    expect(report.period.key).toBe('2026-03');
    expect(report.period.startLabel).toBe('01.03.2026');
    expect(report.period.endLabel).toBe('31.03.2026');
  });

  it('filtert Ladevorgänge ausserhalb des Monats heraus', () => {
    const report = buildMonthlyReport({ ...baseParams, sessions: fixtureSessions() });

    expect(report.totals.sessionCount).toBe(4);
    expect(report.rows.map((row) => row.id)).not.toContain('tx-0999');
  });

  it('gruppiert nach RFID und fasst mehrere Schreibweisen zusammen', () => {
    const report = buildMonthlyReport({ ...baseParams, sessions: fixtureSessions() });

    // '04:A1:B2:C3' und '04A1B2C3' sind dieselbe Karte.
    const max = report.groups.find((group) => group.name === 'Max Mustermann');
    expect(max.sessionCount).toBe(2);
    expect(max.energyKwh).toBe(56.75); // 24.5 + 32.25
  });

  it('summiert Energie, Dauer und Kosten je Gruppe', () => {
    const report = buildMonthlyReport({ ...baseParams, sessions: fixtureSessions() });

    const erika = report.groups.find((group) => group.name === 'Erika Mustermann');
    expect(erika.sessionCount).toBe(1);
    expect(erika.energyKwh).toBe(12.25);
    expect(erika.cost).toBe(3.68); // 12.25 * 0.30 = 3.675 -> 3.68
    expect(erika.duration).toBe('1:30 h');
  });

  it('sortiert Gruppen absteigend nach Energie', () => {
    const report = buildMonthlyReport({ ...baseParams, sessions: fixtureSessions() });
    const energies = report.groups.map((group) => group.energyKwh);

    expect(energies).toEqual([...energies].sort((a, b) => b - a));
  });

  it('markiert nicht zugeordnete Karten', () => {
    const report = buildMonthlyReport({ ...baseParams, sessions: fixtureSessions() });

    expect(report.totals.unknownRfidCount).toBe(1);
    const unknown = report.groups.find((group) => !group.knownRfid);
    expect(unknown.rfid).toBe('ffee0011');
  });

  it('rechnet die Gesamtsummen korrekt', () => {
    const report = buildMonthlyReport({ ...baseParams, sessions: fixtureSessions() });

    // 24.5 + 32.25 + 12.25 + 7.125
    expect(report.totals.energyKwh).toBe(76.125);
    expect(report.totals.cost).toBe(22.84); // 76.125 * 0.30 = 22.8375 -> 22.84
    expect(report.totals.rfidCount).toBe(3);
    expect(report.totals.averageKwhPerSession).toBe(19.03);
  });

  it('berechnet die Gesamtsumme aus der Energiesumme, nicht aus den Einzelbeträgen', () => {
    // Drei Vorgänge, die einzeln je auf 0.02 aufrunden (0.055 -> 0.06 wäre 0.18),
    // in Summe aber 0.165 kWh * 1.00 = 0.17 ergeben.
    const sessions = [0.055, 0.055, 0.055].map((energyKwh, index) => ({
      id: `s${index}`,
      start: new Date(`2026-03-0${index + 1}T10:00:00Z`),
      end: new Date(`2026-03-0${index + 1}T11:00:00Z`),
      durationSeconds: 3600,
      energyKwh,
      rfid: 'aabbccdd',
      rfidRaw: 'AABBCCDD',
    }));

    const report = buildMonthlyReport({ ...baseParams, sessions, pricePerKwh: 1 });

    expect(report.totals.energyKwh).toBe(0.165);
    expect(report.totals.cost).toBe(0.17);
    // Die Einzelposten runden jeweils auf 0.06 -> Summe wäre 0.18. Bewusst anders.
    expect(report.rows.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(0.18, 5);
  });

  it('schließt nicht-abrechenbare Karten aus dem Erstattungsbetrag aus', () => {
    const lookup = rfidLookup([
      { rfid: '04A1B2C3', name: 'Dienstwagen', billable: true },
      { rfid: 'AABBCCDD', name: 'Privatwagen', billable: false },
    ]);
    const report = buildMonthlyReport({ ...baseParams, sessions: fixtureSessions(), rfidLookup: lookup });

    expect(report.totals.energyKwh).toBe(76.125);
    // 76.125 - 12.25 (Privatwagen) = 63.875
    expect(report.totals.billableEnergyKwh).toBe(63.875);
    expect(report.totals.billableCost).toBe(19.16);
    expect(report.totals.cost).toBe(22.84);
  });

  it('liefert einen gültigen, leeren Report ohne Ladevorgänge', () => {
    const report = buildMonthlyReport({ ...baseParams, sessions: [] });

    expect(report.rows).toEqual([]);
    expect(report.groups).toEqual([]);
    expect(report.totals).toMatchObject({
      sessionCount: 0, energyKwh: 0, cost: 0, rfidCount: 0, averageKwhPerSession: 0,
    });
  });

  it('formatiert die Zeilen für die Ausgabe', () => {
    const report = buildMonthlyReport({ ...baseParams, sessions: fixtureSessions() });
    const first = report.rows[0];

    expect(first.date).toBe('02.03.2026');
    expect(first.startTime).toBe('07:30');   // 06:30 UTC -> 07:30 CET
    expect(first.duration).toBe('3:15 h');
    expect(first.name).toBe('Max Mustermann');
    expect(first.plate).toBe('M-EV 1234');
  });

  it('übernimmt Meta-Angaben für den PDF-Kopf', () => {
    const report = buildMonthlyReport({
      ...baseParams,
      sessions: [],
      meta: { employeeName: 'Max Mustermann', companyName: 'ACME GmbH' },
    });

    expect(report.meta.companyName).toBe('ACME GmbH');
  });
});

describe('formatCurrency', () => {
  it('formatiert in deutscher Schreibweise', () => {
    // Intl nutzt ein schmales, nicht umbrechendes Leerzeichen vor dem Symbol.
    expect(formatCurrency(1234.5, 'EUR', 'de-DE').replace(/\s/g, ' ')).toBe('1.234,50 €');
  });
});
