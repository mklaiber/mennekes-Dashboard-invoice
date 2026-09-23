'use strict';

const { reportFileName, periodPrefix, slug } = require('../src/utils/reportFiles');
const { pdfFileName } = require('../src/services/pdfService');
const { csvFileName } = require('../src/services/csvService');

/** Dieselbe Pruefung wie in der Download-Route. */
const DOWNLOADABLE = /^[\w.-]+\.(pdf|csv)$/i;

const period = { key: '2026-09' };
const overall = { period, scope: { kind: 'all', id: null }, meta: {} };
const company = (id, name) => ({ period, scope: { kind: 'company', id }, meta: { companyName: name } });

describe('Dateinamen der Berichte', () => {
  it('behält für den Gesamtbericht den bisherigen Namen', () => {
    expect(pdfFileName(overall)).toBe('ladestrom_2026-09_abrechnung.pdf');
    expect(csvFileName(overall, 'detail')).toBe('ladestrom_2026-09_detail.csv');
  });

  it('gibt jedem Firmenbericht eines Monats eine eigene Datei', () => {
    // Der eigentliche Fehler: alle Laeufe eines Monats schrieben in dieselbe
    // Datei, im Archiv blieb nur der zuletzt erzeugte Bericht uebrig.
    const names = [overall, company(2, 'Kapphan & Partner PartG'), company(3, 'Müller GmbH')]
      .map((report) => pdfFileName(report));

    expect(new Set(names).size).toBe(3);
    expect(names[1]).toBe('ladestrom_2026-09_firma-2-kapphan-partner-partg_abrechnung.pdf');
    expect(names[2]).toBe('ladestrom_2026-09_firma-3-mueller-gmbh_abrechnung.pdf');
  });

  it('unterscheidet ähnlich benannte Firmen über ihre ID', () => {
    expect(pdfFileName(company(4, 'Müller GmbH'))).not.toBe(pdfFileName(company(5, 'Mueller GmbH')));
  });

  it('erzeugt nur Namen, die die Download-Route auch ausliefert', () => {
    const reports = [
      overall,
      company(2, 'Kapphan & Partner PartG'),
      company(6, 'Crème & Brûlée Société / Zweigstelle Süd'),
      { period, scope: { kind: 'unassigned', id: null }, meta: { scopeLabel: 'Ohne Zuordnung' } },
      { period, scope: { kind: 'vehicle', id: 9 }, meta: { scopeLabel: 'TUT-MK 100' } },
    ];
    for (const report of reports) {
      expect(pdfFileName(report)).toMatch(DOWNLOADABLE);
      expect(csvFileName(report, 'summe')).toMatch(DOWNLOADABLE);
    }
  });

  it('beginnt jeden Namen eines Monats mit demselben Präfix, keinen anderen Monat', () => {
    const prefix = periodPrefix('2026-09');
    expect(pdfFileName(company(2, 'Kapphan'))).toMatch(new RegExp(`^${prefix}`));
    expect(reportFileName({ period: { key: '2026-10' }, scope: null }, 'abrechnung', 'pdf'))
      .not.toMatch(new RegExp(`^${prefix}`));
  });

  it('kürzt lange Firmennamen ohne Bindestrich am Ende', () => {
    const long = slug('Eine sehr lange Firmenbezeichnung mit vielen Wörtern GmbH & Co. KG');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).not.toMatch(/-$/);
  });
});
