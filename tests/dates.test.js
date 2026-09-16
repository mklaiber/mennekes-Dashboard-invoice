'use strict';

const {
  monthRange, previousMonth, isLastDayOfMonth, partsInZone,
  formatDuration, formatDate, formatTime, isoDateInZone, zonedTimeToUtc,
} = require('../src/utils/dates');

describe('Datums-Hilfen (Zeitzonen)', () => {
  describe('monthRange', () => {
    it('setzt die Grenzen auf lokale Mitternacht (Winterzeit)', () => {
      const range = monthRange(2026, 1, 'Europe/Berlin');
      // 01.01.2026 00:00 CET == 31.12.2025 23:00 UTC
      expect(range.start.toISOString()).toBe('2025-12-31T23:00:00.000Z');
      expect(range.end.toISOString()).toBe('2026-01-31T23:00:00.000Z');
      expect(range.label).toBe('Januar 2026');
      expect(range.key).toBe('2026-01');
    });

    it('behandelt den Sommerzeitwechsel korrekt (März endet in CEST)', () => {
      const range = monthRange(2026, 3, 'Europe/Berlin');
      // Start noch CET (UTC+1), Ende bereits CEST (UTC+2).
      expect(range.start.toISOString()).toBe('2026-02-28T23:00:00.000Z');
      expect(range.end.toISOString()).toBe('2026-03-31T22:00:00.000Z');
    });

    it('rollt beim Dezember ins Folgejahr', () => {
      const range = monthRange(2026, 12, 'Europe/Berlin');
      expect(range.end.toISOString()).toBe('2026-12-31T23:00:00.000Z');
    });

    it('arbeitet auch in anderen Zeitzonen', () => {
      const range = monthRange(2026, 6, 'UTC');
      expect(range.start.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      expect(range.end.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    });

    it('weist ungültige Monate zurück', () => {
      expect(() => monthRange(2026, 0, 'Europe/Berlin')).toThrow(RangeError);
      expect(() => monthRange(2026, 13, 'Europe/Berlin')).toThrow(RangeError);
    });
  });

  describe('previousMonth', () => {
    it('liefert den Vormonat', () => {
      expect(previousMonth(new Date('2026-03-15T12:00:00Z'), 'Europe/Berlin')).toEqual({ year: 2026, month: 2 });
    });

    it('rollt im Januar ins Vorjahr', () => {
      expect(previousMonth(new Date('2026-01-10T12:00:00Z'), 'Europe/Berlin')).toEqual({ year: 2025, month: 12 });
    });

    it('nutzt die lokale Zeit, nicht UTC', () => {
      // 31.01. 23:30 UTC ist in Berlin bereits der 01.02. -> Vormonat = Januar.
      expect(previousMonth(new Date('2026-01-31T23:30:00Z'), 'Europe/Berlin')).toEqual({ year: 2026, month: 1 });
    });
  });

  describe('isLastDayOfMonth', () => {
    it.each([
      ['2026-03-31T20:00:00Z', true],
      ['2026-03-30T20:00:00Z', false],
      ['2026-02-28T20:00:00Z', true],   // 2026 ist kein Schaltjahr
      ['2024-02-28T20:00:00Z', false],  // 2024 schon
      ['2024-02-29T20:00:00Z', true],
    ])('%s -> %s', (iso, expected) => {
      expect(isLastDayOfMonth(new Date(iso), 'Europe/Berlin')).toBe(expected);
    });

    it('bewertet nach lokaler Zeit', () => {
      // 31.03. 23:00 UTC == 01.04. 01:00 CEST -> nicht mehr Monatsletzter.
      expect(isLastDayOfMonth(new Date('2026-03-31T23:00:00Z'), 'Europe/Berlin')).toBe(false);
    });
  });

  describe('partsInZone / zonedTimeToUtc', () => {
    it('sind zueinander invers', () => {
      const parts = partsInZone(new Date('2026-07-15T14:23:45Z'), 'Europe/Berlin');
      expect(parts).toEqual({ year: 2026, month: 7, day: 15, hour: 16, minute: 23, second: 45 });

      const back = zonedTimeToUtc(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, 'Europe/Berlin');
      expect(back.toISOString()).toBe('2026-07-15T14:23:45.000Z');
    });
  });

  describe('Formatierung', () => {
    it('formatiert Dauern als H:MM h', () => {
      expect(formatDuration(0)).toBe('0:00 h');
      expect(formatDuration(4980)).toBe('1:23 h');
      expect(formatDuration(36000)).toBe('10:00 h');
      expect(formatDuration(-5)).toBe('-');
      expect(formatDuration(NaN)).toBe('-');
    });

    it('formatiert Datum und Uhrzeit lokal', () => {
      expect(formatDate('2026-03-05T18:42:00Z', 'de-DE', 'Europe/Berlin')).toBe('05.03.2026');
      expect(formatTime('2026-03-05T18:42:00Z', 'de-DE', 'Europe/Berlin')).toBe('19:42');
      expect(isoDateInZone('2026-03-05T23:42:00Z', 'Europe/Berlin')).toBe('2026-03-06');
    });
  });
});
