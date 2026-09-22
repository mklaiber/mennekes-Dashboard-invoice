'use strict';

/**
 * Prozess-Einstiegspunkt: Datenbank öffnen, Konfiguration prüfen, App starten,
 * Cronjob registrieren, Signale sauber behandeln.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const database = require('./db');
const users = require('./repositories/userRepository');
const sessions = require('./repositories/sessionRepository');
const audit = require('./repositories/auditRepository');
const settingsStore = require('./repositories/settingsRepository');
const { createApp } = require('./app');
const { ReportScheduler } = require('./jobs/scheduler');
const { closeBrowser } = require('./services/pdfService');

/** Stunden-Intervall für Aufräumarbeiten. */
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Bereitet Verzeichnisse, Datenbank und Startdaten vor.
 * @returns {Promise<void>}
 */
async function bootstrap() {
  fs.mkdirSync(config.server.outputDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.server.databaseFile), { recursive: true });

  // Öffnen führt ausstehende Migrationen aus.
  database.open();
  logger.info(`Datenbank: ${config.server.databaseFile}`);

  // Einmalige Übernahme einer settings.json aus der Dateiversion.
  settingsStore.migrateFromJsonFile();

  // Start-Administrator nur anlegen, solange noch kein Konto existiert.
  const created = await users.ensureBootstrapAdmin();
  if (created) {
    logger.warn(
      `Start-Administrator "${created.username}" wurde angelegt. ` +
      'Bitte nach der ersten Anmeldung das Passwort ändern.'
    );
  }

  sessions.purgeExpired();
}

async function main() {
  // Fehlende Secrets sollen beim Start auffallen, nicht erst am Monatsende.
  config.assertProductionSecrets();

  await bootstrap();

  const { app, liveFeed, mennekesClient } = createApp();

  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info(`WebUI läuft auf http://${config.server.host}:${config.server.port} (${config.env})`);
    logger.info(`Wallbox: ${config.mennekes.baseUrl} | Ausgabeverzeichnis: ${config.server.outputDir}`);
  });

  // Modbus (AMTRON Professional & Co.): eigener, von LiveFeed unabhängiger
  // Takt für die Sitzungs-Erfassung - die läuft auch ohne offenes Dashboard
  // weiter (siehe mennekesModbusClient.js#startTracking). Im Connector-Betrieb
  // ist die Wallbox von hier aus ohnehin nicht erreichbar.
  const modbusTrackingActive = config.mennekes.protocol === 'modbus'
    && config.connector.mode !== 'connector'
    && typeof mennekesClient.startTracking === 'function';
  if (modbusTrackingActive) mennekesClient.startTracking();

  // SSE-Verbindungen sind langlebig - der Default-Timeout (2 min) würde sie kappen.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;

  const scheduler = new ReportScheduler();
  scheduler.start();

  // Abgelaufene Sitzungen und altes Protokoll regelmäßig entfernen, damit die
  // Datenbank auf einer jahrelang laufenden Appliance nicht unbegrenzt wächst.
  const housekeeping = setInterval(() => {
    try {
      sessions.purgeExpired();
      audit.prune();
    } catch (error) {
      logger.error(`Aufräumlauf fehlgeschlagen: ${error.message}`);
    }
  }, HOUSEKEEPING_INTERVAL_MS);
  housekeeping.unref();

  /** Geordnetes Herunterfahren: keine abgeschnittenen PDFs, keine Zombie-Chromiums. */
  async function shutdown(signal) {
    logger.info(`${signal} empfangen - fahre herunter ...`);
    clearInterval(housekeeping);
    scheduler.stop();
    liveFeed.shutdown();
    if (modbusTrackingActive) await mennekesClient.stopTracking();

    server.close(async () => {
      await closeBrowser();
      database.close();
      logger.info('Beendet.');
      process.exit(0);
    });

    // Notbremse, falls eine Verbindung nicht schliesst.
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
  main().catch((error) => {
    logger.error(`Start fehlgeschlagen: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, bootstrap };
