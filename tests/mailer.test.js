'use strict';

const { buildTextBody, buildHtmlBody, sendMonthlyReport } = require('../src/services/mailer');
const { buildMonthlyReport } = require('../src/services/billing');
const { rfidLookup, defaultSettings } = require('../src/repositories/settingsRepository');
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

function makeSettings(overrides = {}) {
  const base = defaultSettings();
  return {
    ...base,
    wallbox: { ...base.wallbox, displayName: 'AMTRON Professional' },
    mail: {
      from: 'wallbox@example.com',
      to: ['buchhaltung@firma.de'],
      cc: [],
      subjectPrefix: 'Ladestrom-Abrechnung',
      ...overrides.mail,
    },
  };
}

/** Transport-Attrappe, die den Versand protokolliert. */
function fakeTransporter(result = {}) {
  return {
    sendMail: jest.fn(async (message) => ({
      messageId: '<test@wallbox>',
      accepted: String(message.to).split(', '),
      rejected: [],
      ...result,
    })),
  };
}

describe('buildTextBody', () => {
  it('enthält die Kernzahlen', () => {
    const text = buildTextBody(makeReport(), makeSettings());

    expect(text).toContain('Ladestrom-Abrechnung März 2026');
    expect(text).toContain('01.03.2026 - 31.03.2026');
    expect(text).toContain('76,13 kWh');
    expect(text).toMatch(/Erstattung:\s+22,84/);
  });

  it('listet jede Ladekarte auf', () => {
    const text = buildTextBody(makeReport(), makeSettings());

    expect(text).toContain('Max Mustermann');
    expect(text).toContain('Erika Mustermann');
  });

  it('weist auf nicht zugeordnete Karten hin', () => {
    const text = buildTextBody(makeReport(), makeSettings());
    expect(text).toContain('1 Ladekarte(n) sind keinem Nutzer zugeordnet');
  });

  it('kommt mit einem leeren Monat klar', () => {
    const text = buildTextBody(makeReport({ sessions: [] }), makeSettings());
    expect(text).toContain('(keine Ladevorgänge im Zeitraum)');
  });
});

describe('buildHtmlBody', () => {
  it('erzeugt ein HTML-Dokument mit Inline-Styles', () => {
    const html = buildHtmlBody(makeReport(), makeSettings());

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('style="');
    // Externes CSS würde in Mailclients nicht funktionieren.
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it('zeigt Betrag und Kartenaufteilung', () => {
    const html = buildHtmlBody(makeReport(), makeSettings());

    expect(html.replace(/\s/g, ' ')).toContain('22,84 €');
    expect(html).toContain('Max Mustermann');
  });

  it('maskiert HTML in Namen (XSS-Schutz)', () => {
    const report = makeReport({ rfidLookup: rfidLookup([{ rfid: '04A1B2C3', name: '<img onerror=x>' }]) });
    const html = buildHtmlBody(report, makeSettings());

    expect(html).not.toContain('<img onerror=x>');
    expect(html).toContain('&lt;img onerror=x&gt;');
  });

  it('zeigt eine Leermeldung ohne Ladevorgänge', () => {
    const html = buildHtmlBody(makeReport({ sessions: [] }), makeSettings());
    expect(html).toContain('Keine Ladevorgänge im Zeitraum.');
  });
});

describe('sendMonthlyReport', () => {
  const attachments = [
    { filename: 'ladestrom_2026-03_abrechnung.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' },
    { filename: 'ladestrom_2026-03_detail.csv', content: 'a;b', contentType: 'text/csv; charset=utf-8' },
  ];

  it('versendet an die konfigurierten Empfänger', async () => {
    const transporter = fakeTransporter();
    const result = await sendMonthlyReport({
      report: makeReport(), settings: makeSettings(), attachments, transporter,
    });

    expect(transporter.sendMail).toHaveBeenCalledTimes(1);
    const message = transporter.sendMail.mock.calls[0][0];
    expect(message.to).toBe('buchhaltung@firma.de');
    expect(message.from).toBe('wallbox@example.com');
    expect(result.messageId).toBe('<test@wallbox>');
  });

  it('setzt einen sprechenden Betreff', async () => {
    const transporter = fakeTransporter();
    await sendMonthlyReport({ report: makeReport(), settings: makeSettings(), attachments, transporter });

    expect(transporter.sendMail.mock.calls[0][0].subject).toBe('Ladestrom-Abrechnung März 2026');
  });

  it('hängt PDF und CSV an', async () => {
    const transporter = fakeTransporter();
    await sendMonthlyReport({ report: makeReport(), settings: makeSettings(), attachments, transporter });

    const sent = transporter.sendMail.mock.calls[0][0].attachments;
    expect(sent).toHaveLength(2);
    expect(sent.map((file) => file.filename)).toEqual([
      'ladestrom_2026-03_abrechnung.pdf',
      'ladestrom_2026-03_detail.csv',
    ]);
    expect(sent[0].contentType).toBe('application/pdf');
  });

  it('versendet Text- UND HTML-Variante', async () => {
    const transporter = fakeTransporter();
    await sendMonthlyReport({ report: makeReport(), settings: makeSettings(), attachments, transporter });

    const message = transporter.sendMail.mock.calls[0][0];
    expect(message.text).toContain('Ladestrom-Abrechnung');
    expect(message.html).toContain('<!DOCTYPE html>');
  });

  it('berücksichtigt mehrere Empfänger und CC', async () => {
    const transporter = fakeTransporter();
    const settings = makeSettings({ mail: { to: ['a@firma.de', 'b@firma.de'], cc: ['chef@firma.de'] } });

    const result = await sendMonthlyReport({ report: makeReport(), settings, attachments, transporter });

    const message = transporter.sendMail.mock.calls[0][0];
    expect(message.to).toBe('a@firma.de, b@firma.de');
    expect(message.cc).toBe('chef@firma.de');
    expect(result.cc).toEqual(['chef@firma.de']);
  });

  it('lässt CC weg, wenn keiner konfiguriert ist', async () => {
    const transporter = fakeTransporter();
    await sendMonthlyReport({ report: makeReport(), settings: makeSettings(), attachments, transporter });

    expect(transporter.sendMail.mock.calls[0][0].cc).toBeUndefined();
  });

  it('erlaubt einen Empfänger-Override (Testversand)', async () => {
    const transporter = fakeTransporter();
    await sendMonthlyReport({
      report: makeReport(), settings: makeSettings(), attachments, transporter, to: ['test@firma.de'],
    });

    expect(transporter.sendMail.mock.calls[0][0].to).toBe('test@firma.de');
  });

  it('wirft, wenn kein Empfänger konfiguriert ist', async () => {
    const transporter = fakeTransporter();
    const settings = makeSettings({ mail: { to: [] } });

    await expect(sendMonthlyReport({ report: makeReport(), settings, attachments, transporter }))
      .rejects.toThrow('Keine Empfänger konfiguriert');
    expect(transporter.sendMail).not.toHaveBeenCalled();
  });

  it('reicht SMTP-Fehler nach oben durch', async () => {
    const transporter = { sendMail: jest.fn(async () => { throw new Error('535 Authentication failed'); }) };

    await expect(sendMonthlyReport({ report: makeReport(), settings: makeSettings(), attachments, transporter }))
      .rejects.toThrow('535 Authentication failed');
  });
});
