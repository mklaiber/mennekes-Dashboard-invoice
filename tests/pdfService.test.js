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
const { rfidLookup, defaultSettings } = require('../src/repositories/settingsRepository');
const { resetDatabase } = require('./helpers/testDb');
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
  resetDatabase();
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

    expect(html).toContain('<h2>Einzelnachweis');
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
    // Auf die gerenderte Überschrift prüfen: das Wort selbst steht auch in
    // einem CSS-Kommentar und wäre deshalb kein verlässliches Signal.
    expect(html).not.toContain('<h2>Einzelnachweis');
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

describe('resolveMargins (Druckränder)', () => {
  it('nutzt DIN-nahe Vorgaben mit breitem Heftrand links', () => {
    expect(pdfService.resolveMargins()).toEqual({ top: 20, right: 20, bottom: 20, left: 25 });
    expect(pdfService.resolveMargins({})).toEqual({ top: 20, right: 20, bottom: 20, left: 25 });
  });

  it('übernimmt konfigurierte Werte', () => {
    const margins = pdfService.resolveMargins({ billing: { margins: { top: 15, right: 12, bottom: 18, left: 30 } } });
    expect(margins).toEqual({ top: 15, right: 12, bottom: 18, left: 30 });
  });

  it('hebt zu kleine Ränder auf 5 mm an', () => {
    // Handelsübliche Drucker können die äußersten ~5 mm nicht bedrucken -
    // darunter würde die Tabelle am Rand abgeschnitten.
    const margins = pdfService.resolveMargins({ billing: { margins: { top: 0, right: -5, bottom: 1, left: 2 } } });
    expect(margins).toEqual({ top: 5, right: 5, bottom: 5, left: 5 });
  });

  it('begrenzt zu große Ränder auf 60 mm', () => {
    const margins = pdfService.resolveMargins({ billing: { margins: { top: 200, right: 99, bottom: 80, left: 70 } } });
    expect(margins).toEqual({ top: 60, right: 60, bottom: 60, left: 60 });
  });

  it('ignoriert unbrauchbare Werte und nimmt die Vorgabe', () => {
    const margins = pdfService.resolveMargins({ billing: { margins: { top: 'abc', right: null, bottom: undefined, left: NaN } } });
    expect(margins).toEqual({ top: 20, right: 20, bottom: 20, left: 25 });
  });

  it('ergänzt fehlende Seiten einzeln', () => {
    const margins = pdfService.resolveMargins({ billing: { margins: { left: 35 } } });
    expect(margins).toEqual({ top: 20, right: 20, bottom: 20, left: 35 });
  });
});

describe('Seitenränder im PDF', () => {
  it('reicht die konfigurierten Ränder unverändert an Puppeteer durch', async () => {
    await pdfService.generateInvoicePdf(
      makeReport(),
      makeSettings({ billing: { margins: { top: 18, right: 15, bottom: 22, left: 28 } } })
    );

    const options = mockPage.pdf.mock.calls[0][0];
    expect(options.margin).toEqual({
      top: '18mm', right: '15mm', bottom: '22mm', left: '28mm',
    });
  });

  it('richtet die Fußzeile seitlich an denselben Rändern aus', async () => {
    await pdfService.generateInvoicePdf(
      makeReport(),
      makeSettings({ billing: { margins: { top: 20, right: 15, bottom: 20, left: 28 } } })
    );

    const footer = mockPage.pdf.mock.calls[0][0].footerTemplate;
    // Ohne passende Einrückung stünde die Seitenzahl versetzt zum Text.
    expect(footer).toContain('15mm');
    expect(footer).toContain('28mm');
  });

  it('lässt Puppeteers Ränder Vorrang vor der CSS-Angabe', async () => {
    await pdfService.generateInvoicePdf(makeReport(), makeSettings());
    expect(mockPage.pdf.mock.calls[0][0].preferCSSPageSize).toBe(false);
  });

  it('schreibt die Ränder auch in die @page-Regel des HTML', async () => {
    const html = await pdfService.renderHtml(
      makeReport(),
      makeSettings({ billing: { margins: { top: 18, right: 15, bottom: 22, left: 28 } } })
    );

    // Damit derselbe Beleg beim Druck direkt aus dem Browser gleich aussieht.
    expect(html).toContain('margin: 18mm 15mm 22mm 28mm');
  });

  it('sorgt für Wiederholung der Tabellenköpfe auf Folgeseiten', async () => {
    const html = await pdfService.renderHtml(makeReport(), makeSettings());

    expect(html).toContain('thead { display: table-header-group; }');
    expect(html).toContain('page-break-inside: avoid');
    expect(html).toContain('orphans: 3');
  });
});

describe('buildFooterTemplate (Lage der Fußzeile)', () => {
  const report = { period: { label: 'März 2026' } };

  /** Liest den unteren Innenabstand aus der erzeugten Vorlage. */
  function liftOf(bottom) {
    const template = pdfService.buildFooterTemplate(report, pdfService.resolveMargins({ billing: { margins: { bottom } } }));
    return Number.parseFloat(/padding:0 \S+mm (\S+)mm \S+mm/.exec(template)[1]);
  }

  it('hebt die Fußzeile aus dem nicht bedruckbaren Randbereich', () => {
    // Chromium setzt Kopf- und Fußzeile rund 6 mm an die Blattkante; das liegt
    // bei üblichen Druckern im nicht bedruckbaren Bereich.
    expect(liftOf(20)).toBeGreaterThan(0);
  });

  it('hebt sie umso weiter, je größer der untere Rand ist', () => {
    expect(liftOf(10)).toBeLessThan(liftOf(15));
    expect(liftOf(15)).toBeLessThan(liftOf(20));
  });

  it('hebt bei sehr knappem Rand gar nicht an', () => {
    // Sonst wanderte die Fußzeile über den Satzspiegel und überlappte den Inhalt.
    expect(liftOf(5)).toBe(0);
  });

  it('begrenzt die Anhebung nach oben', () => {
    // Bei großzügigen Rändern soll die Fußzeile nicht in die Seitenmitte rutschen.
    expect(liftOf(40)).toBe(10);
    expect(liftOf(60)).toBe(10);
  });

  it('enthält Belegtitel und Seitenzählung', () => {
    const template = pdfService.buildFooterTemplate(report, pdfService.resolveMargins());

    expect(template).toContain('Ladestrom-Abrechnung März 2026');
    expect(template).toContain('class="pageNumber"');
    expect(template).toContain('class="totalPages"');
  });

  it('maskiert den Zeitraum gegen HTML-Einschleusung', () => {
    const template = pdfService.buildFooterTemplate({ period: { label: '<img onerror=x>' } }, pdfService.resolveMargins());

    expect(template).not.toContain('<img onerror=x>');
    expect(template).toContain('&lt;img onerror=x&gt;');
  });
});
