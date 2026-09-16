'use strict';

/**
 * Mennekes Wallbox Connector - Home-Assistant-Add-on.
 *
 * Reiner Datenvermittler zwischen der Wallbox im Heimnetz und der
 * Online-Abrechnung:
 *
 *     Wallbox (LAN)  <--lesen--  Connector  --senden-->  Online-Tool (Internet)
 *
 * Alle Verbindungen gehen von hier aus. Die Wallbox braucht keine
 * Portweiterleitung und ist aus dem Internet nicht erreichbar.
 *
 * Zwei Takte:
 *  - Live-Zustand häufig (Sekunden), nicht gepuffert - ein alter Messwert
 *    nützt niemandem.
 *  - Ladehistorie selten (Minuten), dafür mit persistenter Warteschlange -
 *    ein verlorener Ladevorgang fehlt in der Abrechnung.
 */

const options = require('./lib/options');
const logger = require('./lib/logger');
const Wallbox = require('./lib/wallbox');
const Uplink = require('./lib/uplink');
const Queue = require('./lib/queue');

/** Paketgröße beim Senden - wird beim Selbsttest an die Gegenstelle angepasst. */
let batchSize = 100;

/**
 * Ermittelt die ID eines Rohdatensatzes.
 *
 * Die Wallbox liefert je nach Firmware unterschiedliche Feldnamen. Fehlt eine
 * ID ganz, wird eine stabile aus Startzeit und Karte gebildet - sie muss bei
 * jedem Abruf gleich herauskommen, sonst entstünden Dubletten.
 *
 * @param {object} entry
 * @returns {string|null}
 */
function identify(entry) {
  if (!entry || typeof entry !== 'object') return null;

  for (const key of ['id', 'sessionId', 'transactionId', 'uuid']) {
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') {
      return String(entry[key]);
    }
  }

  const start = entry.start || entry.startTime || entry.startedAt || entry.sessionStart;
  if (!start) return null;

  const tag = entry.idTag || entry.rfid || entry.rfidTag || entry.tokenId || 'anon';
  return `${start}-${tag}`;
}

/** Wartet, ohne den Prozess am Beenden zu hindern. */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

async function main() {
  let config;
  try {
    config = options.load();
  } catch (error) {
    logger.error(error.message);
    logger.error('Bitte die Add-on-Konfiguration korrigieren und neu starten.');
    // Exit 1 lässt Home Assistant das Add-on als fehlgeschlagen anzeigen,
    // statt es endlos neu zu starten.
    process.exit(1);
  }

  const wallbox = new Wallbox(config.wallbox);
  const uplink = new Uplink(config.target, config.version);
  const queue = new Queue(config.stateDir);

  logger.info(`Connector ${config.version} gestartet.`);
  logger.info(`Offene Ladevorgänge in der Warteschlange: ${queue.size}`);

  // --- Selbsttest beim Start. Nicht abbrechen, wenn etwas fehlt: eine Wallbox
  // --- kann kurz nach einem Stromausfall noch booten, das Internet kann kurz
  // --- weg sein. Der Betrieb läuft an und die Takte versuchen es erneut.
  const wallboxCheck = await wallbox.ping();
  logger.info(wallboxCheck.reachable
    ? 'Wallbox erreichbar.'
    : `Wallbox derzeit NICHT erreichbar: ${wallboxCheck.error}`);

  const uplinkCheck = await uplink.check();
  if (uplinkCheck.ok) {
    logger.info(`Online-Tool erreichbar: ${uplinkCheck.info.storedSessions} Vorgänge dort gespeichert.`);
    if (uplinkCheck.info.maxSessionsPerRequest) {
      batchSize = Math.min(batchSize, uplinkCheck.info.maxSessionsPerRequest);
    }
  } else {
    logger.warn(`Online-Tool derzeit NICHT erreichbar: ${uplinkCheck.message}`);
  }

  // ----------------------------------------------------------- Live-Zustand
  let statusFailures = 0;

  async function statusTick() {
    try {
      const status = await wallbox.getStatus();
      await uplink.sendStatus(status);

      if (statusFailures > 0) {
        logger.info(`Wallbox wieder erreichbar (nach ${statusFailures} Fehlversuchen).`);
        statusFailures = 0;
      }
    } catch (error) {
      statusFailures += 1;
      // Nicht bei jedem Versuch schreien: bei einer über Nacht abgeschalteten
      // Wallbox liefe das Protokoll sonst voll.
      if (statusFailures === 1 || statusFailures % 30 === 0) {
        logger.warn(`Wallbox nicht erreichbar (Versuch ${statusFailures}): ${error.message}`);
      }
    }
  }

  // ------------------------------------------------------------- Historie
  async function sessionsTick() {
    const since = new Date(Date.now() - config.historyDays * 24 * 60 * 60 * 1000);

    try {
      const entries = await wallbox.getSessions(since);
      const added = queue.enqueue(entries, identify);
      if (added > 0) logger.info(`${added} neue(r) Ladevorgang/Ladevorgänge aus der Wallbox übernommen.`);
    } catch (error) {
      logger.warn(`Historie nicht abrufbar: ${error.message}`);
      // Kein return: eventuell liegen noch alte Einträge in der Warteschlange,
      // die jetzt zugestellt werden können.
    }

    await flushQueue();
  }

  /** Arbeitet die Warteschlange paketweise ab. */
  async function flushQueue() {
    while (queue.size > 0) {
      const batch = queue.batch(batchSize);
      // Die ID wird mitgegeben, damit sich die Bestätigung eindeutig zuordnen
      // lässt - auch wenn die Gegenstelle die Reihenfolge ändert.
      const payload = batch.map((entry) => ({ ...entry, __id: identify(entry) }));

      const result = await uplink.sendSessions(payload);

      if (!result.ok) {
        // Beim nächsten Takt erneut versuchen; die Einträge bleiben gespeichert.
        logger.info(`${queue.size} Vorgang/Vorgänge bleiben in der Warteschlange.`);
        return;
      }

      queue.acknowledge(result.acknowledged);
      queue.discard(result.rejected);

      // Schutz vor einer Endlosschleife, falls die Gegenstelle nichts bestätigt.
      if (result.acknowledged.length === 0 && result.rejected.length === 0) {
        logger.error('Gegenstelle hat nichts bestätigt - Abbruch bis zum nächsten Takt.');
        return;
      }
    }
  }

  // ------------------------------------------------------------ Zeitgeber
  await statusTick();
  await sessionsTick();

  const statusTimer = setInterval(() => { statusTick().catch(() => {}); }, config.statusIntervalMs);
  const sessionsTimer = setInterval(() => { sessionsTick().catch(() => {}); }, config.sessionsIntervalMs);

  // ------------------------------------------------------- Herunterfahren
  function shutdown(signal) {
    logger.info(`${signal} empfangen - beende.`);
    clearInterval(statusTimer);
    clearInterval(sessionsTimer);
    const stats = queue.stats();
    if (stats.pending > 0) {
      logger.warn(`${stats.pending} Vorgang/Vorgänge noch nicht zugestellt - bleiben gespeichert.`);
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unbehandelte Ablehnung:', reason instanceof Error ? reason.message : String(reason));
  });
}

if (require.main === module) {
  main().catch((error) => {
    logger.error(`Start fehlgeschlagen: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { identify, delay };
