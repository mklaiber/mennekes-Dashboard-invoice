'use strict';

/**
 * Prozess-Einstiegspunkt: Konfiguration prüfen, App starten, Cronjob registrieren,
 * Signale sauber behandeln.
 */

const fs = require('fs');
const config = require('./config');
const logger = require('./utils/logger');
const { createApp } = require('./app');
const { ReportScheduler } = require('./jobs/scheduler');
const { closeBrowser } = require('./services/pdfService');

function main() {
  // Fehlende Secrets sollen beim Start auffallen, nicht erst am Monatsende.
  config.assertProductionSecrets();

  // Ausgabe- und Settings-Verzeichnis vorbereiten (Docker-Volume ggf. leer).
  fs.mkdirSync(config.server.outputDir, { recursive: true });
  fs.mkdirSync(require('path').dirname(config.server.settingsFile), { recursive: true });

  const { app, liveFeed } = createApp();

  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info(`WebUI läuft auf http://${config.server.host}:${config.server.port} (${config.env})`);
    logger.info(`Wallbox: ${config.mennekes.baseUrl} | Ausgabeverzeichnis: ${config.server.outputDir}`);
  });

  // SSE-Verbindungen sind langlebig - der Default-Timeout (2 min) würde sie kappen.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;

  const scheduler = new ReportScheduler();
  scheduler.start();

  /** Geordnetes Herunterfahren: keine abgeschnittenen PDFs, keine Zombie-Chromiums. */
  async function shutdown(signal) {
    logger.info(`${signal} empfangen - fahre herunter ...`);
    scheduler.stop();
    liveFeed.shutdown();

    server.close(async () => {
      await closeBrowser();
      logger.info('Beendet.');
      process.exit(0);
    });

    // Notbremse, falls eine Verbindung nicht schließt.
    setTimeout(() => {
      logger.warn('Erzwungenes Beenden nach Timeout.');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unbehandelte Promise-Rejection:', reason instanceof Error ? reason.stack : reason);
  });

  return { server, scheduler, liveFeed };
}

// Nur starten, wenn direkt aufgerufen - beim Import (Tests) passiert nichts.
if (require.main === module) {
  try {
    main();
  } catch (error) {
    logger.error(`Start fehlgeschlagen: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { main };
