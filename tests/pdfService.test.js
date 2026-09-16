'use strict';

// Puppeteer wird gemockt: Chromium zu starten ist im Unit-Test zu langsam und
// braucht Systemabhängigkeiten. Getestet wird die Logik davor und danach.
const mockPage = {
  setContent: jest.fn(async () => undefined),
  evaluate: jest.fn(async () => undefined),
  pdf: jest.fn(async () => Buffer.from('%PDF-1.4 fake')),
  close: jest.fn(async () => undefined),
};
const mockBrowser = {
  newPage: jest.fn(async () => mockPage),
  close: jest.fn(async () => undefined),
  connected: true,
};
jest.mock('puppeteer', () => ({ launch: jest.fn(async () => mockBrowser) }), { virtual: false });

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const pdfService = require('../src/services/pdfService');
const { buildMonthlyReport } = require('../src/services/billing');
const { rfidLookup, defaultSettings } = require('../src/config/settings');
const MennekesClient = require('../src/services/mennekesClient');
const fixtures = require('./fixtures/wallbox');

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

function makeSettings(overrides = {}) {
  const base = defaultSettings();
  return {
    ...base,
    wallbox: { ...base.wallbox, displayName: 'AMTRON Professional' },
    billing: {
      ...base.billing,
      employeeName: 'Max Mustermann',
      companyName: 'ACME GmbH',
      vehiclePlate: 'M-EV 1234',
      ...overrides.billing,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  pdfService._resetCaches();
  mockBrowser.connected = true;
});

describe('renderHtml', () => {
  it('rendert ein vollständiges HTML-Dokument', async () => {
    const html = await pdfService.renderHtml(makeReport(), makeSettings());

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('@page');
  });

  it('zeigt Zeitraum und Stammdaten im Kopf', async () => {
    const html = await pdfService.renderHtml(makeReport(), makeSettings());

    expect(html).toContain('März 2026');
    expect(html).toContain('01.03.2026');
    expect(html).toContain('31.03.2026');
    expect(html).toContain('Max Mustermann');
    expect(html).toContain('ACME GmbH');
    expect(html).toContain('M-EV 1234');
  });

  it('enthält eine Tabellenzeile je Ladekarte', async () => {
    const report = makeReport();
    const html = await pdfService.renderHtml(report, makeSettings());

    for (const group of report.groups) {
      expect(html).toContain(group.name);
    }
  });

  it('enthält den Einzelnachweis aller Ladevorgänge', async () => {
    const html = await pdfService.renderHtml(makeReport(), makeSettings());

    expect(html).toContain('Einzelnachweis');
    expect(html).toContain('02.03.2026');
    expect(html).toContain('11.03.2026');
  });

  it('weist Summen in deutscher Formatierung aus', async () => {
    const html = await pdfService.renderHtml(makeReport(), makeSettings());

    expect(html).toContain('76,13'); // 76.125 kWh, 2 Nachkommastellen
    expect(html.replace(/\s/g, ' ')).toContain('22,84 €');
  });

  it('nutzt den Logo-Platzhalter, wenn keine URL konfiguriert ist', async () => {
    const html = await pdfService.renderHtml(makeReport(), makeSettings({ billing: { logoUrl: '' } }));

    expect(html).toContain('logo-fallback');
    expect(html).not.toContain('<img class="logo"');
  });

  it('bindet ein konfiguriertes Logo ein', async () => {
    const settings = makeSettings({ billing: { logoUrl: 'https://example.com/logo.png' } });
    const html = await pdfService.renderHtml(makeReport(), settings);

    expect(html).toContain('<img class="logo" src="https://example.com/logo.png"');
  });

  it('weist auf nicht zugeordnete Karten hin', async () => {
    const html = await pdfService.renderHtml(makeReport(), makeSettings());

    expect(html).toContain('nicht zugeordnet');
    expect(html).toContain('RFID-Mapping');
  });

  it('zeigt einen Leer-Hinweis statt einer leeren Tabelle', async () => {
    const html = await pdfService.renderHtml(makeReport({ sessions: [] }), makeSettings());

    expect(html).toContain('keine Ladevorgänge aufgezeichnet');
    expect(html).not.toContain('Einzelnachweis');
  });

  it('maskiert HTML in Benutzereingaben (XSS-Schutz)', async () => {
    const report = makeReport({
      rfidLookup: rfidLookup([{ rfid: '04A1B2C3', name: '<script>alert(1)</script>' }]),
    });
    const html = await pdfService.renderHtml(report, makeSettings());

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('documentNumber', () => {
  it('folgt dem Schema WB-JAHR-MONAT-LAUFEND', () => {
    expect(pdfService.documentNumber(makeReport())).toBe('WB-2026-03-0004');
    expect(pdfService.documentNumber(makeReport({ sessions: [] }))).toBe('WB-2026-03-0000');
  });
});

describe('pdfFileName', () => {
  it('folgt dem Namensschema', () => {
    expect(pdfService.pdfFileName(makeReport())).toBe('ladestrom_2026-03_abrechnung.pdf');
  });
});

describe('generateInvoicePdf', () => {
  it('startet Chromium, rendert und gibt einen Buffer zurück', async () => {
    const result = await pdfService.generateInvoicePdf(makeReport(), makeSettings());

    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
    expect(mockPage.setContent).toHaveBeenCalledWith(expect.stringContaining('<!DOCTYPE html>'), { waitUntil: 'domcontentloaded' });
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.toString()).toContain('%PDF');
  });

  it('erzeugt A4 mit Hintergrund und Seitenzahlen', async () => {
    await pdfService.generateInvoicePdf(makeReport(), makeSettings());

    const options = mockPage.pdf.mock.calls[0][0];
    expect(options.format).toBe('A4');
    expect(options.printBackground).toBe(true);
    expect(options.displayHeaderFooter).toBe(true);
    expect(options.footerTemplate).toContain('pageNumber');
    expect(options.footerTemplate).toContain('März 2026');
  });

  it('schreibt die Datei, wenn ein Pfad angegeben ist', async () => {
    const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-')), 'sub', 'test.pdf');

    const result = await pdfService.generateInvoicePdf(makeReport(), makeSettings(), { outputPath });

    expect(result.filePath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath).toString()).toContain('%PDF');
  });

  it('wartet auf das Logo, wenn eines konfiguriert ist', async () => {
    await pdfService.generateInvoicePdf(makeReport(), makeSettings({ billing: { logoUrl: 'https://example.com/l.png' } }));
    expect(mockPage.evaluate).toHaveBeenCalled();
  });

  it('wartet nicht auf Bilder ohne Logo', async () => {
    await pdfService.generateInvoicePdf(makeReport(), makeSettings({ billing: { logoUrl: '' } }));
    expect(mockPage.evaluate).not.toHaveBeenCalled();
  });

  it('schließt die Seite auch im Fehlerfall', async () => {
    mockPage.pdf.mockRejectedValueOnce(new Error('Render fehlgeschlagen'));

    await expect(pdfService.generateInvoicePdf(makeReport(), makeSettings()))
      .rejects.toThrow('Render fehlgeschlagen');
    expect(mockPage.close).toHaveBeenCalled();
  });

  it('verwendet den Browser für mehrere PDFs wieder', async () => {
    await pdfService.generateInvoicePdf(makeReport(), makeSettings());
    await pdfService.generateInvoicePdf(makeReport(), makeSettings());

    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
    expect(mockBrowser.newPage).toHaveBeenCalledTimes(2);
  });
});

describe('closeBrowser', () => {
  it('beendet eine laufende Instanz', async () => {
    await pdfService.generateInvoicePdf(makeReport(), makeSettings());
    await pdfService.closeBrowser();

    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it('ist ohne laufende Instanz ein No-Op', async () => {
    await expect(pdfService.closeBrowser()).resolves.toBeUndefined();
    expect(mockBrowser.close).not.toHaveBeenCalled();
  });
});
