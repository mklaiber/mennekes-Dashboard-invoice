'use strict';

/**
 * CSV-Export der monatlichen Rohdaten.
 *
 * Zielgruppe: Excel / Buchhaltung. Deshalb standardmäßig
 *  - Semikolon als Trennzeichen (deutsches Excel),
 *  - Komma als Dezimaltrenner,
 *  - UTF-8 BOM, damit Excel Umlaute korrekt anzeigt.
 */

const { reportFileName } = require('../utils/reportFiles');
const { Parser } = require('@json2csv/plainjs');
const { round } = require('./billing');

/** BOM verhindert, dass Excel UTF-8 als Latin-1 interpretiert. */
const UTF8_BOM = '﻿';

/** Spaltendefinition der Detail-CSV. */
const DETAIL_FIELDS = [
  { label: 'Datum', value: 'isoDate' },
  { label: 'Startzeit', value: 'startTime' },
  { label: 'Endzeit', value: 'endTime' },
  { label: 'Start (ISO 8601)', value: 'startIso' },
  { label: 'Ende (ISO 8601)', value: 'endIso' },
  { label: 'Dauer (hh:mm)', value: 'durationHhMm' },
  { label: 'Dauer (Minuten)', value: 'durationMinutes' },
  { label: 'RFID', value: 'rfid' },
  { label: 'Name', value: 'name' },
  { label: 'Kennzeichen', value: 'plate' },
  { label: 'Energie (kWh)', value: 'energyKwh' },
  { label: 'Preis pro kWh', value: 'pricePerKwh' },
  { label: 'Betrag', value: 'cost' },
  { label: 'Währung', value: 'currency' },
  { label: 'Zähler Start (kWh)', value: 'meterStartKwh' },
  { label: 'Zähler Ende (kWh)', value: 'meterEndKwh' },
  { label: 'Abrechenbar', value: 'billable' },
  { label: 'Vorgang-ID', value: 'id' },
];

/** Spaltendefinition der Summen-CSV (je RFID). */
const SUMMARY_FIELDS = [
  { label: 'RFID', value: 'rfid' },
  { label: 'Name', value: 'name' },
  { label: 'Kennzeichen', value: 'plate' },
  { label: 'Ladevorgänge', value: 'sessionCount' },
  { label: 'Energie (kWh)', value: 'energyKwh' },
  { label: 'Dauer (hh:mm)', value: 'durationHhMm' },
  { label: 'Betrag', value: 'cost' },
  { label: 'Währung', value: 'currency' },
  { label: 'Abrechenbar', value: 'billable' },
];

/**
 * Dezimalzahl mit deutschem Komma - Excel erkennt sie dann als Zahl, nicht als Text.
 * @param {number|null} value
 * @param {number} [decimals=3]
 * @param {boolean} [useComma=true]
 * @returns {string}
 */
function decimal(value, decimals = 3, useComma = true) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  const fixed = round(value, decimals).toFixed(decimals);
  return useComma ? fixed.replace('.', ',') : fixed;
}

/** Sekunden als "hh:mm" (ohne Einheit, damit Excel es als Dauer parsen kann). */
function hhmm(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}`;
}

/**
 * Detail-CSV: eine Zeile pro Ladevorgang.
 *
 * @param {object} report Ergebnis von buildMonthlyReport()
 * @param {object} [options]
 * @param {string} [options.delimiter=';']
 * @param {boolean} [options.decimalComma=true]
 * @param {boolean} [options.withBom=true]
 * @returns {string} CSV-Inhalt
 */
function buildDetailCsv(report, options = {}) {
  const { delimiter = ';', decimalComma = true, withBom = true } = options;

  const records = report.rows.map((row) => ({
    isoDate: row.isoDate,
    startTime: row.startTime,
    endTime: row.endTime,
    startIso: row.start instanceof Date ? row.start.toISOString() : '',
    endIso: row.end instanceof Date ? row.end.toISOString() : '',
    durationHhMm: hhmm(row.durationSeconds),
    durationMinutes: Math.round((row.durationSeconds || 0) / 60),
    rfid: row.rfidRaw || row.rfid,
    name: row.name,
    plate: row.plate || '',
    energyKwh: decimal(row.energyKwh, 3, decimalComma),
    pricePerKwh: decimal(report.pricePerKwh, 4, decimalComma),
    cost: decimal(row.cost, 2, decimalComma),
    currency: report.currency,
    meterStartKwh: decimal(row.meterStartKwh, 3, decimalComma),
    meterEndKwh: decimal(row.meterEndKwh, 3, decimalComma),
    billable: row.billable ? 'ja' : 'nein',
    id: row.id,
  }));

  const parser = new Parser({ fields: DETAIL_FIELDS, delimiter, withBOM: false, eol: '\r\n' });
  // json2csv wirft bei [] - Kopfzeile trotzdem ausgeben, damit die Datei nie leer ist.
  const csv = records.length > 0
    ? parser.parse(records)
    : DETAIL_FIELDS.map((field) => field.label).join(delimiter);

  return (withBom ? UTF8_BOM : '') + csv + '\r\n';
}

/**
 * Summen-CSV: eine Zeile pro RFID-Karte plus Gesamtzeile.
 *
 * @param {object} report Ergebnis von buildMonthlyReport()
 * @param {object} [options] wie buildDetailCsv
 * @returns {string}
 */
function buildSummaryCsv(report, options = {}) {
  const { delimiter = ';', decimalComma = true, withBom = true } = options;

  const records = report.groups.map((group) => ({
    rfid: group.rfidRaw || group.rfid,
    name: group.name,
    plate: group.plate || '',
    sessionCount: group.sessionCount,
    energyKwh: decimal(group.energyKwh, 3, decimalComma),
    durationHhMm: hhmm(group.durationSeconds),
    cost: decimal(group.cost, 2, decimalComma),
    currency: report.currency,
    billable: group.billable ? 'ja' : 'nein',
  }));

  records.push({
    rfid: '',
    name: 'GESAMT',
    plate: '',
    sessionCount: report.totals.sessionCount,
    energyKwh: decimal(report.totals.energyKwh, 3, decimalComma),
    durationHhMm: hhmm(report.totals.durationSeconds),
    cost: decimal(report.totals.cost, 2, decimalComma),
    currency: report.currency,
    billable: '',
  });

  const parser = new Parser({ fields: SUMMARY_FIELDS, delimiter, withBOM: false, eol: '\r\n' });
  return (withBom ? UTF8_BOM : '') + parser.parse(records) + '\r\n';
}

/**
 * Dateiname nach Schema `ladestrom_2026-03_detail.csv`.
 * @param {object} report
 * @param {string} [kind='detail']
 * @returns {string}
 */
function csvFileName(report, kind = 'detail') {
  return reportFileName(report, kind, 'csv');
}

module.exports = { buildDetailCsv, buildSummaryCsv, csvFileName, decimal, hhmm, DETAIL_FIELDS, SUMMARY_FIELDS, UTF8_BOM };
