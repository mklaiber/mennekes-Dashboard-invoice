'use strict';

const { ReportScheduler, shouldRunNow, periodForRun } = require('../src/jobs/scheduler');
const settingsStore = require('../src/config/settings');

beforeEach(() => {
  settingsStore.reset();
  settingsStore.save({
    billing: { timezone: 'Europe/Berlin' },
    scheduler: { enabled: true, runPolicy: 'last-day-of-month' },
  });
});

describe('shouldRunNow', () => {
  it('läuft am Monatsletzten', () => {
    expect(shouldRunNow({ now: new Date('2026-03-31T21:30:00Z'), timezone: 'Europe/Berlin' })).toBe(true);
  });

  it('läuft an anderen Tagen nicht', () => {
    expect(shouldRunNow({ now: new Date('2026-03-15T21:30:00Z'), timezone: 'Europe/Berlin' })).toBe(false);
    expect(shouldRunNow({ now: new Date('2026-03-30T21:30:00Z'), timezone: 'Europe/Berlin' })).toBe(false);
  });

  it('kennt die unterschiedliche Monatslänge', () => {
    expect(shouldRunNow({ now: new Date('2026-02-28T21:30:00Z'), timezone: 'Europe/Berlin' })).toBe(true);
    expect(shouldRunNow({ now: new Date('2026-04-30T21:30:00Z'), timezone: 'Europe/Berlin' })).toBe(true);
    expect(shouldRunNow({ now: new Date('2026-04-29T21:30:00Z'), timezone: 'Europe/Berlin' })).toBe(false);
  });

  it('läuft mit Policy "always" immer', () => {
    expect(shouldRunNow({ now: new Date('2026-03-15T10:00:00Z'), runPolicy: 'always' })).toBe(true);
  });

  it('bewertet nach lokaler Zeit, nicht nach UTC', () => {
    // 31.03. 23:30 UTC == 01.04. 01:30 CEST -> lokal nicht mehr Monatsletzter.
    expect(shouldRunNow({ now: new Date('2026-03-31T23:30:00Z'), timezone: 'Europe/Berlin' })).toBe(false);
  });
});

describe('periodForRun', () => {
  it('rechnet den ABLAUFENDEN Monat ab, nicht den Vormonat', () => {
    // Läuft der Job am 31.03. um 23:30 Uhr, ist der März gemeint.
    expect(periodForRun(new Date('2026-03-31T21:30:00Z'), 'Europe/Berlin')).toEqual({ year: 2026, month: 3 });
  });

  it('nutzt die lokale Zeitzone', () => {
    // 31.12. 23:30 UTC == 01.01. 00:30 CET -> Januar des Folgejahres.
    expect(periodForRun(new Date('2026-12-31T23:30:00Z'), 'Europe/Berlin')).toEqual({ year: 2027, month: 1 });
  });
});

describe('ReportScheduler', () => {
  describe('start', () => {
    it('startet nicht, wenn die Automatisierung deaktiviert ist', () => {
      settingsStore.save({ scheduler: { enabled: false } });
      const scheduler = new ReportScheduler({ runner: jest.fn() });

      expect(scheduler.start()).toBeNull();
    });

    it('startet nicht bei ungültigem Cron-Ausdruck', () => {
      const scheduler = new ReportScheduler({ cronExpression: 'jeden zweiten Dienstag', runner: jest.fn() });
      expect(scheduler.start()).toBeNull();
    });

    it('registriert einen gültigen Cron-Ausdruck', () => {
      const scheduler = new ReportScheduler({ cronExpression: '30 23 * * *', runner: jest.fn() });
      const task = scheduler.start();

      expect(task).not.toBeNull();
      scheduler.stop();
      expect(scheduler.task).toBeNull();
    });
  });

  describe('tick', () => {
    it('überspringt Tage, die nicht der Monatsletzte sind', async () => {
      const runner = jest.fn();
      const scheduler = new ReportScheduler({ runner });

      const result = await scheduler.tick(new Date('2026-03-15T21:30:00Z'));

      expect(result).toBeNull();
      expect(runner).not.toHaveBeenCalled();
    });

    it('startet den Lauf am Monatsletzten mit Mailversand', async () => {
      const runner = jest.fn(async () => ({
        report: { totals: { energyKwh: 76.125 } },
        mail: { messageId: '<cron@wallbox>' },
      }));
      const scheduler = new ReportScheduler({ runner });

      await scheduler.tick(new Date('2026-03-31T21:30:00Z'));

      expect(runner).toHaveBeenCalledWith(expect.objectContaining({
        year: 2026, month: 3, sendMail: true,
      }));
      expect(scheduler.lastRun).toMatchObject({ ok: true, period: '2026-03', energyKwh: 76.125 });
    });

    it('läuft bei Policy "always" an jedem Tag', async () => {
      settingsStore.save({ scheduler: { runPolicy: 'always' } });
      const runner = jest.fn(async () => ({ report: { totals: { energyKwh: 1 } }, mail: null }));
      const scheduler = new ReportScheduler({ runner });

      await scheduler.tick(new Date('2026-03-15T21:30:00Z'));
      expect(runner).toHaveBeenCalledWith(expect.objectContaining({ year: 2026, month: 3 }));
    });

    it('fängt Fehler ab, damit der Prozess weiterläuft', async () => {
      const runner = jest.fn(async () => { throw new Error('SMTP nicht erreichbar'); });
      const scheduler = new ReportScheduler({ runner });

      await expect(scheduler.tick(new Date('2026-03-31T21:30:00Z'))).resolves.toBeNull();
      expect(scheduler.lastRun).toMatchObject({ ok: false, error: 'SMTP nicht erreichbar' });
      // Nach einem Fehlschlag darf der nächste Lauf nicht blockiert sein.
      expect(scheduler.running).toBe(false);
    });

    it('verhindert parallele Läufe', async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const runner = jest.fn(async () => { await gate; return { report: { totals: {} }, mail: null }; });
      const scheduler = new ReportScheduler({ runner });

      const first = scheduler.tick(new Date('2026-03-31T21:30:00Z'));
      const second = await scheduler.tick(new Date('2026-03-31T21:30:00Z'));

      expect(second).toBeNull();
      expect(runner).toHaveBeenCalledTimes(1);

      release();
      await first;
      expect(scheduler.running).toBe(false);
    });
  });
});
