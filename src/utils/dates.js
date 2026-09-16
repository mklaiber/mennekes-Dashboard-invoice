'use strict';

/**
 * Zeitzonen-korrekte Datumshilfen - ohne externe Abhängigkeit (moment/luxon).
 *
 * Wichtig für die Abrechnung: Ein "Monat" ist der Zeitraum von lokal 01. 00:00:00
 * bis lokal 01. des Folgemonats 00:00:00. Bei Sommer-/Winterzeitwechsel sind das
 * nicht 24h-Vielfache - deshalb wird konsequent über Intl gerechnet und nicht
 * mit festen Millisekunden-Offsets.
 */

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/**
 * Offset einer Zeitzone zu UTC am gegebenen Zeitpunkt.
 * @param {Date} instant
 * @param {string} timeZone IANA-Name, z. B. 'Europe/Berlin'
 * @returns {number} Offset in Millisekunden (positiv östlich von UTC)
 */
function timeZoneOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  // hour12:false liefert in manchen ICU-Versionen "24" statt "00".
  const hour = Number(parts.hour) % 24;
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );

  // Millisekunden herausrechnen, da formatToParts sie nicht liefert.
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return asIfUtc - wholeSeconds;
}

/**
 * Wandelt eine lokale Wanduhrzeit in den entsprechenden UTC-Zeitpunkt.
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @param {number} [hour=0]
 * @param {number} [minute=0]
 * @param {number} [second=0]
 * @param {string} timeZone
 * @returns {Date}
 */
function zonedTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0);
  const firstOffset = timeZoneOffsetMs(new Date(guess), timeZone);
  let result = guess - firstOffset;

  // Zweiter Durchlauf fängt DST-Sprünge ab (Offset am Zielzeitpunkt kann abweichen).
  const secondOffset = timeZoneOffsetMs(new Date(result), timeZone);
  if (secondOffset !== firstOffset) result = guess - secondOffset;

  return new Date(result);
}

/**
 * Zerlegt einen Zeitpunkt in die lokalen Kalenderfelder der Zeitzone.
 * @param {Date|string|number} date
 * @param {string} timeZone
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number}}
 */
function partsInZone(date, timeZone) {
  const instant = date instanceof Date ? date : new Date(date);
  const offset = timeZoneOffsetMs(instant, timeZone);
  const shifted = new Date(Math.floor(instant.getTime() / 1000) * 1000 + offset);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/**
 * Halboffenes Monatsintervall [start, end).
 * @param {number} year
 * @param {number} month 1-12
 * @param {string} [timeZone='Europe/Berlin']
 * @returns {{year:number, month:number, start:Date, end:Date, label:string, key:string}}
 */
function monthRange(year, month, timeZone = 'Europe/Berlin') {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`Ungültiger Monat: ${month} (erwartet 1-12)`);
  }
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  return {
    year,
    month,
    start: zonedTimeToUtc(year, month, 1, 0, 0, 0, timeZone),
    end: zonedTimeToUtc(nextYear, nextMonth, 1, 0, 0, 0, timeZone),
    label: `${MONTH_NAMES_DE[month - 1]} ${year}`,
    key: `${year}-${String(month).padStart(2, '0')}`,
  };
}

/**
 * Der Monat vor dem Referenzzeitpunkt - das ist der abzurechnende Zeitraum.
 * @param {Date} [reference=new Date()]
 * @param {string} [timeZone='Europe/Berlin']
 * @returns {{year:number, month:number}}
 */
function previousMonth(reference = new Date(), timeZone = 'Europe/Berlin') {
  const { year, month } = partsInZone(reference, timeZone);
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/**
 * Ist der Zeitpunkt der letzte Tag seines Monats (lokal betrachtet)?
 * @param {Date} [reference=new Date()]
 * @param {string} [timeZone='Europe/Berlin']
 * @returns {boolean}
 */
function isLastDayOfMonth(reference = new Date(), timeZone = 'Europe/Berlin') {
  const { year, month, day } = partsInZone(reference, timeZone);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === daysInMonth;
}

/**
 * @param {Date|string|number} date
 * @param {string} [locale='de-DE']
 * @param {string} [timeZone='Europe/Berlin']
 * @returns {string} z. B. "05.03.2026"
 */
function formatDate(date, locale = 'de-DE', timeZone = 'Europe/Berlin') {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date instanceof Date ? date : new Date(date));
}

/**
 * @param {Date|string|number} date
 * @param {string} [locale='de-DE']
 * @param {string} [timeZone='Europe/Berlin']
 * @returns {string} z. B. "18:42"
 */
function formatTime(date, locale = 'de-DE', timeZone = 'Europe/Berlin') {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date instanceof Date ? date : new Date(date));
}

/**
 * Dauer als "H:MM h".
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, '0')} h`;
}

/**
 * ISO-Datum (YYYY-MM-DD) in lokaler Zeitzone - für CSV-Spalten.
 * @param {Date|string|number} date
 * @param {string} [timeZone='Europe/Berlin']
 * @returns {string}
 */
function isoDateInZone(date, timeZone = 'Europe/Berlin') {
  const { year, month, day } = partsInZone(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

module.exports = {
  MONTH_NAMES_DE,
  timeZoneOffsetMs,
  zonedTimeToUtc,
  partsInZone,
  monthRange,
  previousMonth,
  isLastDayOfMonth,
  formatDate,
  formatTime,
  formatDuration,
  isoDateInZone,
};
