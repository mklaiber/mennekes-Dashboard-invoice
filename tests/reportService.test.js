'use strict';

// Puppeteer mocken - der Integrationstest der Orchestrierung braucht kein echtes Chromium.
const mockPage = {
  setContent: jest.fn(async () => undefined),
  evaluate: jest.fn(async () => undefined),
  pdf: jest.fn(async () => Buffer.from('%PDF-1.4 orchestrated')),
  close: jest.fn(async () => undefined),
};
jest.mock('puppeteer', () => ({
  launch: jest.fn(async () => ({
    newPage: jest.fn(async () => mockPage),
    close: jest.fn(async () => undefined),
    connected: true,
  })),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildReportForMonth, generateArtifacts, runMonthlyReport, listGeneratedFiles } = require('../src/services/reportService');
const settingsStore = require('../src/config/settings');
const pdfService = require('../src/services/pdfService');
const fixtures = require('./fixtures/wallbox');
const MennekesClient = require('../src/services/mennekesClient');

/** Wallbox-Client-Attrappe mit den Fixture-Daten. */
function fakeClient() {
  return {
    getChargingSessions: jest.fn(async (from, to) => fixtures.sessionsMarch2026.transactions
      .map((entry) => MennekesClient.normalizeSession(entry))
      .filter(Boolean)
      .filter((session) => session.start >= from && session.start < to)
      .sort((a, b) => a.start - b.start)),
    getLiveStatus: jest.fn(async () => MennekesClient.normalizeStatus(fixtures.statusCharging)),
  };
}

function fakeTransporter() {
  return { sendMail: jest.fn(async () => ({ messageId: '<run@wallbox>', accepted: ['buchhaltung@firma.de'], rejected: [] })) };
}

let outputDir;

beforeEach(() => {
  jest.clearAllMocks();
  pdfService._resetCaches();
  settingsStore.reset();

  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-run-'));

  // Frische Einstellungen je Test - settingsStore schreibt in die Temp-Datei aus tests/setup.js.
  settingsStore.save({
    billing: { pricePerKwh: 0.3, timezone: 'Europe/Berlin', currency: 'EUR', locale: 'de-DE' },
    mail: { from: 'wallbox@example.com', to: ['buchhaltung@firma.de'], cc: [] },
    rfidMappings: fixtures.rfidMappings,
  });
});

describe('buildReportForMonth', () => {
  it('fragt genau den Monatszeitraum bei der Wallbox ab', async () => {
    const client = fakeClient();
    await buildReportForMonth({ year: 2026, month: 3, client });

    const [from, to] = client.getChargingSessions.mock.calls[0];
    expect(from.toISOString()).toBe('2026-02-28T23:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-31T22:00:00.000Z');
  });

  it('wendet Preis und RFID-Mapping aus den Einstellungen an', async () => {
    const report = await buildReportForMonth({ year: 2026, month: 3, client: fakeClient() });

    expect(report.pricePerKwh).toBe(0.3);
    expect(report.totals.energyKwh).toBe(76.125);
    expect(report.groups.some((group) => group.name === 'Max Mustermann')).toBe(true);
  });

  it('reagiert auf geänderte Einstellungen', async () => {
    settingsStore.save({ billing: { pricePerKwh: 0.45 } });
    const report = await buildReportForMonth({ year: 2026, month: 3, client: fakeClient() });

    expect(report.pricePerKwh).toBe(0.45);
    expect(report.totals.cost).toBe(34.26); // 76.125 * 0.45
  });
});

describe('generateArtifacts', () => {
  it('erzeugt PDF, Detail-CSV und Summen-CSV', async () => {
    const report = await buildReportForMonth({ year: 2026, month: 3, client: fakeClient() });
    const files = await generateArtifacts(report, settingsStore.load(), { outputDir });

    expect(files.pdf.fileName).toBe('ladestrom_2026-03_abrechnung.pdf');
    expect(files.csvDetail.fileName).toBe('ladestrom_2026-03_detail.csv');
    expect(files.csvSummary.fileName).toBe('ladestrom_2026-03_summe.csv');

    for (const file of Object.values(files)) {
      expect(fs.existsSync(file.filePath)).toBe(true);
    }
  });

  it('legt das Ausgabeverzeichnis bei Bedarf an', async () => {
    const nested = path.join(outputDir, 'a', 'b', 'c');
    const report = await buildReportForMonth({ year: 2026, month: 3, client: fakeClient() });

    await generateArtifacts(report, settingsStore.load(), { outputDir: nested });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('schreibt CSV-Inhalte mit BOM auf Platte', async () => {
    const report = await buildReportForMonth({ year: 2026, month: 3, client: fakeClient() });
    const files = await generateArtifacts(report, settingsStore.load(), { outputDir });

    const content = fs.readFileSync(files.csvDetail.filePath, 'utf8');
    expect(content.charCodeAt(0)).toBe(0xfeff);
    expect(content).toContain('Max Mustermann');
  });
});

describe('runMonthlyReport', () => {
  it('durchläuft Abruf, Erzeugung und Versand', async () => {
    const client = fakeClient();
    const transporter = fakeTransporter();

    const result = await runMonthlyReport({ year: 2026, month: 3, client, transporter, outputDir });

    expect(client.getChargingSessions).toHaveBeenCalledTimes(1);
    expect(transporter.sendMail).toHaveBeenCalledTimes(1);
    expect(result.report.period.key).toBe('2026-03');
    expect(result.mail.messageId).toBe('<run@wallbox>');
  });

  it('hängt genau drei Dateien an die E-Mail', async () => {
    const transporter = fakeTransporter();
    await runMonthlyReport({ year: 2026, month: 3, client: fakeClient(), transporter, outputDir });

    const attachments = transporter.sendMail.mock.calls[0][0].attachments;
    expect(attachments).toHaveLength(3);
    expect(attachments[0].filename).toMatch(/\.pdf$/);
    expect(attachments[1].filename).toMatch(/_detail\.csv$/);
    expect(attachments[2].filename).toMatch(/_summe\.csv$/);
    expect(Buffer.isBuffer(attachments[0].content)).toBe(true);
  });

  it('erzeugt Dateien ohne Versand, wenn sendMail=false', async () => {
    const transporter = fakeTransporter();
    const result = await runMonthlyReport({
      year: 2026, month: 3, client: fakeClient(), transporter, outputDir, sendMail: false,
    });

    expect(transporter.sendMail).not.toHaveBeenCalled();
    expect(result.mail).toBeNull();
    expect(fs.existsSync(result.files.pdf.filePath)).toBe(true);
  });

  it('rechnet ohne Monatsangabe den Vormonat ab', async () => {
    const client = fakeClient();
    const now = new Date();
    const expected = now.getMonth() === 0 ? 12 : now.getMonth(); // getMonth() ist 0-basiert

    const result = await runMonthlyReport({
      client, transporter: fakeTransporter(), outputDir, sendMail: false,
    });

    expect(result.report.period.month).toBe(expected);
  });

  it('reicht Wallbox-Fehler nach oben durch (kein stiller Fehlschlag)', async () => {
    const client = fakeClient();
    client.getChargingSessions.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(runMonthlyReport({ year: 2026, month: 3, client, outputDir, sendMail: false }))
      .rejects.toThrow('ECONNREFUSED');
  });
});

describe('listGeneratedFiles', () => {
  it('listet erzeugte Dateien mit Größe und Datum', async () => {
    await runMonthlyReport({ year: 2026, month: 3, client: fakeClient(), outputDir, sendMail: false });
    const files = await listGeneratedFiles(outputDir);

    expect(files).toHaveLength(3);
    expect(files[0]).toHaveProperty('sizeBytes');
    expect(files[0]).toHaveProperty('modifiedAt');
  });

  it('ignoriert fremde Dateitypen', async () => {
    fs.writeFileSync(path.join(outputDir, 'notizen.txt'), 'nicht relevant');
    await runMonthlyReport({ year: 2026, month: 3, client: fakeClient(), outputDir, sendMail: false });

    const names = (await listGeneratedFiles(outputDir)).map((file) => file.fileName);
    expect(names).not.toContain('notizen.txt');
  });

  it('liefert ein leeres Array, wenn das Verzeichnis fehlt', async () => {
    expect(await listGeneratedFiles(path.join(outputDir, 'gibt-es-nicht'))).toEqual([]);
  });
});
