'use strict';

/**
 * E-Mail-Versand der Monatsabrechnung via nodemailer.
 *
 * Zugangsdaten kommen ausschließlich aus der ENV, Empfänger aus settings.json
 * (WebUI-pflegbar) mit ENV als Fallback.
 */

const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../utils/logger');
const { formatCurrency, formatNumber } = require('./billing');

/** @type {import('nodemailer').Transporter|null} */
let transporterSingleton = null;

/**
 * Baut den SMTP-Transport (gecacht).
 * @param {object} [smtpOptions] überschreibt die ENV-Konfiguration (Tests / alternative Transporte)
 * @returns {import('nodemailer').Transporter}
 */
function getTransporter(smtpOptions) {
  if (smtpOptions) return nodemailer.createTransport(smtpOptions);
  if (transporterSingleton) return transporterSingleton;

  transporterSingleton = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
    tls: { rejectUnauthorized: config.smtp.rejectUnauthorized !== false },
  });

  return transporterSingleton;
}

/**
 * Plaintext-Variante der Mail (wichtig für Spam-Score und Textclients).
 * @param {object} report
 * @param {object} settings
 * @returns {string}
 */
function buildTextBody(report, settings) {
  const locale = report.locale || 'de-DE';
  const currency = report.currency || 'EUR';

  const lines = [
    `Ladestrom-Abrechnung ${report.period.label}`,
    '='.repeat(40),
    '',
    `Zeitraum:        ${report.period.startLabel} - ${report.period.endLabel}`,
    `Ladevorgänge:   ${report.totals.sessionCount}`,
    `Energie gesamt:  ${formatNumber(report.totals.energyKwh, 2, locale)} kWh`,
    `Ladezeit:        ${report.totals.duration}`,
    `Arbeitspreis:    ${formatCurrency(report.pricePerKwh, currency, locale)} / kWh`,
    `Erstattung:      ${formatCurrency(report.totals.billableCost, currency, locale)}`,
    '',
    'Aufteilung je Ladekarte:',
  ];

  if (report.groups.length === 0) {
    lines.push('  (keine Ladevorgänge im Zeitraum)');
  } else {
    for (const group of report.groups) {
      lines.push(
        `  - ${group.name}: ${formatNumber(group.energyKwh, 2, locale)} kWh ` +
        `in ${group.sessionCount} Vorgang/Vorgängen = ${formatCurrency(group.cost, currency, locale)}`
      );
    }
  }

  if (report.totals.unknownRfidCount > 0) {
    lines.push('', `Hinweis: ${report.totals.unknownRfidCount} Ladekarte(n) sind keinem Nutzer zugeordnet.`);
  }

  lines.push(
    '',
    'Im Anhang: Abrechnungs-PDF und CSV-Rohdaten.',
    '',
    `-- ${settings?.wallbox?.displayName || 'Wallbox'} - automatisch erstellt --`
  );

  return lines.join('\n');
}

/**
 * HTML-Variante der Mail. Bewusst Inline-Styles und Tabellen -
 * Mailclients unterstützen kein externes CSS und kein modernes Flexbox.
 * @param {object} report
 * @param {object} settings
 * @returns {string}
 */
function buildHtmlBody(report, settings) {
  const locale = report.locale || 'de-DE';
  const currency = report.currency || 'EUR';

  const rows = report.groups.length === 0
    ? '<tr><td colspan="4" style="padding:10px;color:#6b7280;">Keine Ladevorgänge im Zeitraum.</td></tr>'
    : report.groups.map((group) => `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;">${escapeHtml(group.name)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:right;">${group.sessionCount}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:right;">${formatNumber(group.energyKwh, 2, locale)} kWh</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:600;">${formatCurrency(group.cost, currency, locale)}</td>
        </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="de"><body style="margin:0;padding:24px;background:#f9fafb;font-family:Arial,Helvetica,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
    <tr>
      <td style="background:#0f766e;color:#ffffff;padding:22px 26px;">
        <div style="font-size:12px;letter-spacing:.09em;text-transform:uppercase;opacity:.85;">${escapeHtml(settings?.wallbox?.displayName || 'Wallbox')}</div>
        <div style="font-size:22px;font-weight:700;margin-top:4px;">Ladestrom-Abrechnung</div>
        <div style="font-size:15px;margin-top:2px;opacity:.9;">${escapeHtml(report.period.label)}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:24px 26px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
          <tr>
            <td style="padding:6px 0;color:#4b5563;">Zeitraum</td>
            <td style="padding:6px 0;text-align:right;font-weight:600;">${escapeHtml(report.period.startLabel)} – ${escapeHtml(report.period.endLabel)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#4b5563;">Ladevorgänge</td>
            <td style="padding:6px 0;text-align:right;font-weight:600;">${report.totals.sessionCount}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#4b5563;">Energie gesamt</td>
            <td style="padding:6px 0;text-align:right;font-weight:600;">${formatNumber(report.totals.energyKwh, 2, locale)} kWh</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#4b5563;">Arbeitspreis</td>
            <td style="padding:6px 0;text-align:right;font-weight:600;">${formatCurrency(report.pricePerKwh, currency, locale)} / kWh</td>
          </tr>
        </table>

        <div style="margin-top:18px;padding:16px 18px;background:#ecfdf5;border-radius:8px;display:block;">
          <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#0f766e;">Erstattungsbetrag</div>
          <div style="font-size:26px;font-weight:700;color:#0f766e;margin-top:2px;">${formatCurrency(report.totals.billableCost, currency, locale)}</div>
        </div>

        <h3 style="font-size:14px;margin:24px 0 8px;">Aufteilung je Ladekarte</h3>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse;">
          <thead>
            <tr style="background:#f9fafb;">
              <th align="left"  style="padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;border-bottom:1px solid #e5e7eb;">Nutzer</th>
              <th align="right" style="padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;border-bottom:1px solid #e5e7eb;">Vorgänge</th>
              <th align="right" style="padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;border-bottom:1px solid #e5e7eb;">Energie</th>
              <th align="right" style="padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;border-bottom:1px solid #e5e7eb;">Betrag</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>

        <p style="font-size:13px;color:#4b5563;margin-top:22px;">
          Im Anhang finden Sie die vollständige Abrechnung als PDF sowie die Rohdaten als CSV
          zur Weiterverarbeitung.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:14px 26px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
        Automatisch erstellt – bitte nicht auf diese E-Mail antworten.
      </td>
    </tr>
  </table>
</body></html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Versendet die Abrechnung mit PDF- und CSV-Anhang.
 *
 * @param {object} params
 * @param {object} params.report
 * @param {object} params.settings
 * @param {Array<{filename:string, content:Buffer|string, contentType?:string}>} params.attachments
 * @param {import('nodemailer').Transporter} [params.transporter] injizierbar für Tests
 * @param {string[]} [params.to] überschreibt die Empfänger aus den Settings
 * @returns {Promise<{messageId:string, accepted:string[], to:string[]}>}
 */
async function sendMonthlyReport({ report, settings, attachments = [], transporter, to }) {
  const recipients = (to && to.length > 0 ? to : settings?.mail?.to) || [];
  if (recipients.length === 0) {
    throw new Error('Keine Empfänger konfiguriert (settings.mail.to bzw. MAIL_TO).');
  }

  const prefix = settings?.mail?.subjectPrefix || config.mail.subjectPrefix;
  const cc = settings?.mail?.cc || [];

  const message = {
    from: settings?.mail?.from || config.mail.from,
    to: recipients.join(', '),
    cc: cc.length > 0 ? cc.join(', ') : undefined,
    subject: `${prefix} ${report.period.label}`,
    text: buildTextBody(report, settings),
    html: buildHtmlBody(report, settings),
    attachments,
  };

  // Injizierter Transport hat Vorrang (Tests / alternative Backends),
  // sonst der gecachte SMTP-Transport aus der ENV-Konfiguration.
  const activeTransporter = transporter || getTransporter();
  const info = await activeTransporter.sendMail(message);

  logger.info(
    `Abrechnung ${report.period.label} versendet an ${recipients.join(', ')} ` +
    `(${attachments.length} Anhänge, messageId=${info.messageId})`
  );

  return {
    messageId: info.messageId,
    accepted: info.accepted || recipients,
    rejected: info.rejected || [],
    to: recipients,
    cc,
  };
}

/** Nur für Tests: den gecachten Transport verwerfen. */
function _resetTransporter() {
  transporterSingleton = null;
}

module.exports = { getTransporter, buildTextBody, buildHtmlBody, sendMonthlyReport, _resetTransporter };
