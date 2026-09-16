#!/usr/bin/env node
'use strict';

/**
 * CLI zum manuellen Auslösen einer Abrechnung - nützlich für Nachläufe
 * und zum Testen des Deployments.
 *
 * Beispiele:
 *   node scripts/run-report.js                      # Vormonat, mit Mailversand
 *   node scripts/run-report.js --month 3 --year 2026
 *   node scripts/run-report.js --no-mail            # nur Dateien erzeugen
 *   node scripts/run-report.js --to test@firma.de   # Testversand
 *
 * Im Container:
 *   docker compose exec wallbox-billing node scripts/run-report.js --no-mail
 */

const { runMonthlyReport } = require('../src/services/reportService');
const { closeBrowser } = require('../src/services/pdfService');
const config = require('../src/config');

/** Sehr einfacher Argument-Parser - keine Abhängigkeit für vier Flags. */
function parseArgs(argv) {
  const args = { sendMail: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--year': args.year = Number.parseInt(value, 10); index += 1; break;
      case '--month': args.month = Number.parseInt(value, 10); index += 1; break;
      case '--to': args.to = value.split(',').map((entry) => entry.trim()); index += 1; break;
      case '--no-mail': args.sendMail = false; break;
      case '--help':
      case '-h': args.help = true; break;
      default: break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`
Ladestrom-Abrechnung manuell erzeugen

  --year  <JJJJ>        Abrechnungsjahr   (Default: Vormonat)
  --month <1-12>        Abrechnungsmonat  (Default: Vormonat)
  --to    <mail[,mail]> Empfänger-Override
  --no-mail             nur PDF/CSV erzeugen, nicht versenden
  -h, --help            diese Hilfe
`);
    return;
  }

  config.assertProductionSecrets();

  const result = await runMonthlyReport({
    year: args.year,
    month: args.month,
    to: args.to,
    sendMail: args.sendMail,
  });

  process.stdout.write(
    `\nAbrechnung ${result.report.period.label}\n` +
    `  Ladevorgänge : ${result.report.totals.sessionCount}\n` +
    `  Energie       : ${result.report.totals.energyKwh} kWh\n` +
    `  Betrag        : ${result.report.totals.billableCost} ${result.report.currency}\n` +
    `  PDF           : ${result.files.pdf.filePath}\n` +
    `  CSV (Detail)  : ${result.files.csvDetail.filePath}\n` +
    `  CSV (Summe)   : ${result.files.csvSummary.filePath}\n` +
    `  E-Mail        : ${result.mail ? result.mail.to.join(', ') : 'nicht versendet'}\n\n`
  );
}

main()
  .then(() => closeBrowser())
  .then(() => process.exit(0))
  .catch(async (error) => {
    process.stderr.write(`\nFehlgeschlagen: ${error.message}\n\n`);
    await closeBrowser().catch(() => { /* egal, wir beenden ohnehin */ });
    process.exit(1);
  });
