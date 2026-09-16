'use strict';

/**
 * Kern der Abrechnung: Ladevorgänge filtern, nach RFID gruppieren, Kosten berechnen.
 *
 * Bewusst frei von I/O (keine HTTP-Calls, keine Dateizugriffe) - dadurch vollständig
 * und schnell testbar, und wiederverwendbar für PDF, CSV und die REST-API.
 */

const { formatDate, formatTime, formatDuration, isoDateInZone, monthRange } = require('../utils/dates');
const { normalizeRfid } = require('../config/settings');

/** Rundung auf n Nachkommastellen ohne Float-Artefakte (0.1+0.2 Problem). */
function round(value, decimals = 3) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  // epsilon-Korrektur, damit 1.005 -> 1.01 statt 1.00 wird.
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Kosten eines Energiebetrags.
 * @param {number} kwh
 * @param {number} pricePerKwh
 * @returns {number} auf Cent gerundet
 */
function calculateCost(kwh, pricePerKwh) {
  const energy = Number.isFinite(kwh) ? kwh : 0;
  const price = Number.isFinite(pricePerKwh) ? pricePerKwh : 0;
  return round(energy * price, 2);
}

/**
 * Löst eine RFID-ID gegen die konfigurierten Mappings auf.
 * @param {string} rfid normalisierte RFID
 * @param {Map<string, object>} lookup
 * @returns {{name:string, plate:string, billable:boolean, known:boolean}}
 */
function resolveRfid(rfid, lookup) {
  const entry = lookup.get(normalizeRfid(rfid));
  if (!entry) {
    return { name: `Unbekannt (${rfid})`, plate: '', billable: true, known: false };
  }
  return {
    name: entry.name || `Unbekannt (${rfid})`,
    plate: entry.plate || '',
    // Nur ein explizites false schließt von der Abrechnung aus.
    billable: entry.billable !== false,
    known: true,
  };
}

/**
 * Baut den kompletten Abrechnungsreport für einen Monat.
 *
 * @param {object} params
 * @param {Array<object>} params.sessions normalisierte Ladevorgänge (siehe MennekesClient.normalizeSession)
 * @param {number} params.year
 * @param {number} params.month 1-12
 * @param {number} params.pricePerKwh
 * @param {Map<string, object>} [params.rfidLookup] RFID -> Mapping
 * @param {string} [params.currency='EUR']
 * @param {string} [params.locale='de-DE']
 * @param {string} [params.timezone='Europe/Berlin']
 * @param {object} [params.meta] freie Zusatzfelder für PDF-Kopf (companyName, employeeName, ...)
 * @returns {object} Report mit rows, groups, totals und Formatierungshilfen
 */
function buildMonthlyReport({
  sessions = [],
  year,
  month,
  pricePerKwh = 0,
  rfidLookup = new Map(),
  currency = 'EUR',
  locale = 'de-DE',
  timezone = 'Europe/Berlin',
  meta = {},
}) {
  const period = monthRange(year, month, timezone);

  // Defensiv: auch wenn der Client schon filtert, darf hier nichts Fremdes durchrutschen.
  const inPeriod = sessions
    .filter((session) => session && session.start instanceof Date)
    .filter((session) => session.start >= period.start && session.start < period.end)
    .sort((a, b) => a.start - b.start);

  const rows = inPeriod.map((session) => {
    const identity = resolveRfid(session.rfid, rfidLookup);
    const energyKwh = round(session.energyKwh, 3);
    return {
      id: session.id,
      start: session.start,
      end: session.end,
      date: formatDate(session.start, locale, timezone),
      isoDate: isoDateInZone(session.start, timezone),
      startTime: formatTime(session.start, locale, timezone),
      endTime: session.end ? formatTime(session.end, locale, timezone) : '-',
      durationSeconds: session.durationSeconds || 0,
      duration: formatDuration(session.durationSeconds || 0),
      energyKwh,
      cost: calculateCost(energyKwh, pricePerKwh),
      rfid: session.rfid,
      rfidRaw: session.rfidRaw,
      name: identity.name,
      plate: identity.plate,
      billable: identity.billable,
      knownRfid: identity.known,
      meterStartKwh: session.meterStartKwh ?? null,
      meterEndKwh: session.meterEndKwh ?? null,
    };
  });

  // Gruppierung nach RFID-Tag - das ist die Sicht, die der Arbeitgeber braucht.
  const groupMap = new Map();
  for (const row of rows) {
    if (!groupMap.has(row.rfid)) {
      groupMap.set(row.rfid, {
        rfid: row.rfid,
        rfidRaw: row.rfidRaw,
        name: row.name,
        plate: row.plate,
        billable: row.billable,
        knownRfid: row.knownRfid,
        sessionCount: 0,
        energyKwh: 0,
        durationSeconds: 0,
        cost: 0,
        firstSession: row.start,
        lastSession: row.start,
        rows: [],
      });
    }
    const group = groupMap.get(row.rfid);
    group.sessionCount += 1;
    group.energyKwh = round(group.energyKwh + row.energyKwh, 3);
    group.durationSeconds += row.durationSeconds;
    group.rows.push(row);
    if (row.start < group.firstSession) group.firstSession = row.start;
    if (row.start > group.lastSession) group.lastSession = row.start;
  }

  // Kosten erst auf der Gruppensumme berechnen - sonst summieren sich Rundungsfehler
  // der Einzelposten auf und die Gesamtsumme passt nicht zur Multiplikation.
  const groups = [...groupMap.values()]
    .map((group) => ({
      ...group,
      cost: calculateCost(group.energyKwh, pricePerKwh),
      duration: formatDuration(group.durationSeconds),
    }))
    .sort((a, b) => b.energyKwh - a.energyKwh);

  const totalEnergyKwh = round(rows.reduce((sum, row) => sum + row.energyKwh, 0), 3);
  const billableEnergyKwh = round(
    groups.filter((g) => g.billable).reduce((sum, g) => sum + g.energyKwh, 0),
    3
  );

  const totals = {
    sessionCount: rows.length,
    energyKwh: totalEnergyKwh,
    billableEnergyKwh,
    durationSeconds: rows.reduce((sum, row) => sum + row.durationSeconds, 0),
    cost: calculateCost(totalEnergyKwh, pricePerKwh),
    billableCost: calculateCost(billableEnergyKwh, pricePerKwh),
    rfidCount: groups.length,
    unknownRfidCount: groups.filter((group) => !group.knownRfid).length,
  };
  totals.duration = formatDuration(totals.durationSeconds);
  totals.averageKwhPerSession = totals.sessionCount > 0 ? round(totals.energyKwh / totals.sessionCount, 2) : 0;

  return {
    period: {
      year: period.year,
      month: period.month,
      label: period.label,
      key: period.key,
      start: period.start,
      end: period.end,
      // Anzeige: letzter Tag des Monats, nicht der exklusive Folgetag.
      startLabel: formatDate(period.start, locale, timezone),
      endLabel: formatDate(new Date(period.end.getTime() - 1), locale, timezone),
    },
    pricePerKwh: round(pricePerKwh, 4),
    currency,
    locale,
    timezone,
    meta,
    rows,
    groups,
    totals,
    generatedAt: new Date(),
  };
}

/**
 * Währungsformatierung für Templates.
 * @param {number} value
 * @param {string} [currency='EUR']
 * @param {string} [locale='de-DE']
 * @returns {string}
 */
function formatCurrency(value, currency = 'EUR', locale = 'de-DE') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number.isFinite(value) ? value : 0);
}

/**
 * Zahlenformatierung (kWh) für Templates.
 * @param {number} value
 * @param {number} [decimals=2]
 * @param {string} [locale='de-DE']
 * @returns {string}
 */
function formatNumber(value, decimals = 2, locale = 'de-DE') {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number.isFinite(value) ? value : 0);
}

module.exports = {
  buildMonthlyReport,
  calculateCost,
  resolveRfid,
  formatCurrency,
  formatNumber,
  round,
};
