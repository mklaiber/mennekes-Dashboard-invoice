'use strict';

/**
 * Dateinamen erzeugter Berichte.
 *
 * Der Monatslauf erzeugt je Firma einen Bericht und dazu die
 * Gesamtuebersicht - alle fuer denselben Monat. Truege der Name nur den
 * Monat, ueberschriebe jeder Bericht die Datei des vorigen: die Mails waeren
 * zwar richtig (sie haengen den Puffer im Speicher an), im Archiv laege am
 * Ende aber nur die Gesamtuebersicht, und der Download eines Firmenlaufs
 * lieferte das falsche Dokument.
 *
 * Der Gesamtbericht behaelt den bisherigen Namen, damit vorhandene Dateien
 * und Verweise gueltig bleiben.
 */

const KIND_PREFIX = { company: 'firma', vehicle: 'fahrzeug', unassigned: 'ohne-zuordnung' };

/** ASCII-Kurzform: die Download-Route laesst nur [A-Za-z0-9_.-] durch. */
function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Namensteil fuer den Geltungsbereich, leer beim Gesamtbericht.
 * Die ID macht den Namen eindeutig, auch wenn zwei Firmen aehnlich heissen;
 * der Name dahinter macht ihn fuer Menschen lesbar.
 *
 * @param {object} report
 * @returns {string} z. B. "_firma-2-kapphan-partner-partg"
 */
function scopeSuffix(report) {
  const scope = report && report.scope;
  if (!scope || !scope.kind || scope.kind === 'all') return '';

  const prefix = KIND_PREFIX[scope.kind] || slug(scope.kind);
  const name = slug(report.meta && (report.meta.companyName || report.meta.scopeLabel));
  return `_${prefix}${scope.id ? `-${scope.id}` : ''}${name ? `-${name}` : ''}`;
}

/**
 * @param {object} report
 * @param {string} kind z. B. "abrechnung", "detail", "summe"
 * @param {string} extension ohne Punkt
 */
function reportFileName(report, kind, extension) {
  return `ladestrom_${report.period.key}${scopeSuffix(report)}_${kind}.${extension}`;
}

/** Alle Dateinamen eines Monats beginnen hiermit - fuer das Aufraeumen. */
function periodPrefix(periodKey) {
  return `ladestrom_${periodKey}_`;
}

module.exports = { reportFileName, scopeSuffix, periodPrefix, slug };
