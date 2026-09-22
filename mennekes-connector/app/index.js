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
const WallboxModbus = require('./lib/wallboxModbus');
const Uplink = require('./lib/uplink');
const Queue = require('./lib/queue');
const mqttClient = require('./lib/mqttClient');
const { HomeAssistantBridge, topicsFor } = require('./lib/haBridge');

/** Nach so vielen aufeinanderfolgenden Fehlversuchen gelten die
 *  Home-Assistant-Entities als "nicht verfügbar" statt stumm veraltete Werte
 *  zu zeigen. Bei 10s-Takt sind das ~30s - kurz genug, um im Dashboard
 *  aufzufallen, lang genug, um eine einzelne Störung nicht als Ausfall zu werten. */
const HA_UNAVAILABLE_AFTER_FAILURES = 3;

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

  // 'Start'/'Uid' (groß) sind die MENNEKES-AMTRON-Rohfeldnamen (REST
  // /ChargeRecords wie auch die selbst rekonstruierten Modbus-Sitzungen,
  // siehe lib/wallboxModbus.js) - ohne diese Prüfung würde queue.enqueue()
  // jeden AMTRON-Datensatz mangels ID stillschweigend verwerfen.
  const start = entry.start || entry.startTime || entry.startedAt || entry.sessionStart || entry.Start;
  if (!start) return null;

  const tag = entry.idTag || entry.rfid || entry.rfidTag || entry.tokenId || entry.Uid || 'anon';
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

  // AMTRON Professional/ChargeControl & Co. haben keine REST-Schnittstelle,
  // nur Modbus TCP - siehe lib/wallboxModbus.js.
  const wallbox = config.wallbox.protocol === 'modbus'
    ? new WallboxModbus(config.wallbox)
    : new Wallbox(config.wallbox);
  const uplink = new Uplink(config.target, config.version);
  const queue = new Queue(config.stateDir);

  logger.info(`Connector ${config.version} gestartet.`);
  logger.info(`Offene Ladevorgänge in der Warteschlange: ${queue.size}`);

  // ------------------------------------------------- Home Assistant (MQTT)
  // Optional und auto-erkennend: fehlt der Broker (weder manuell konfiguriert
  // noch über den Home-Assistant-Dienst gefunden, siehe run.sh), bleiben die
  // Sensoren einfach weg - kein Fehlerfall, nicht jede Installation hat MQTT.
  let bridge = null;
  let mqttConn = null;
  if (config.mqtt.enabled) {
    try {
      const topics = topicsFor(config.mqtt.nodeId);
      mqttConn = mqttClient.connect(config.mqtt, topics.availability);
      bridge = new HomeAssistantBridge(config.mqtt, mqttConn.publisher, logger);

      mqttConn.whenConnected()
        .then(() => logger.info(`MQTT verbunden: ${mqttClient.buildUrl(config.mqtt)}`))
        .catch((error) => logger.warn(`MQTT-Erstverbindung fehlgeschlagen, Connector arbeitet im Hintergrund weiter: ${error.message}`));

      logger.info(`Home-Assistant-Sensoren aktiv (Gerät "${config.mqtt.deviceName}").`);
    } catch (error) {
      logger.warn(`Home-Assistant-Anbindung (MQTT) konnte nicht gestartet werden: ${error.message}`);
      bridge = null;
    }
  } else {
    logger.info('Home-Assistant-Sensoren deaktiviert (kein MQTT-Broker konfiguriert).');
  }

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
  let haUnavailableNotified = false;

  async function statusTick() {
    let normalized = null;
    let wallboxError = null;

    try {
      const status = await wallbox.getStatus();
      // sendStatus() gibt den vom Online-Tool NORMALISIERTEN Zustand zurück
      // (Status als Klartext, kW, aufgelöster RFID-Name) - genau der speist
      // die Home-Assistant-Sensoren unten. Der Connector deutet die
      // Wallbox-Rohdaten bewusst nicht selbst: das würde die Interpretation
      // an zwei Stellen halten, die über kurz oder lang auseinanderliefen.
      const sent = await uplink.sendStatus(status); // sendStatus() protokolliert eigene Fehlschläge selbst
      normalized = sent.ok ? sent.normalized : null;

      // Modbus rekonstruiert Ladevorgänge selbst aus dem Statusverlauf (siehe
      // lib/wallboxModbus.js) - im selben, schnellen Takt statt erst mit dem
      // langsameren sessionsTick() in die Warteschlange übernehmen: sonst läge
      // ein gerade beendeter Ladevorgang bis zu sessions_interval_seconds lang
      // nur im Arbeitsspeicher und wäre bei einem Absturz in der Zwischenzeit
      // verloren.
      await flushModbusSessions();
    } catch (error) {
      wallboxError = error;
    }

    if (normalized) {
      if (statusFailures > 0) {
        logger.info(`Wallbox wieder erreichbar (nach ${statusFailures} Fehlversuchen).`);
      }
      statusFailures = 0;
      haUnavailableNotified = false;

      if (bridge) {
        await bridge.publishState(normalized).catch((error) => {
          logger.warn(`Home-Assistant-Sensoren nicht aktualisiert: ${error.message}`);
        });
      }
      return;
    }

    // Kein Zustand zum Veröffentlichen - entweder war die Wallbox nicht
    // erreichbar (Meldung unten) oder das Online-Tool hat die Sendung
    // abgelehnt (von sendStatus() bereits geloggt). Beides zählt für die
    // Home-Assistant-Verfügbarkeit als Fehlversuch.
    statusFailures += 1;
    // Nicht bei jedem Versuch schreien: bei einer über Nacht abgeschalteten
    // Wallbox liefe das Protokoll sonst voll.
    if (wallboxError && (statusFailures === 1 || statusFailures % 30 === 0)) {
      logger.warn(`Wallbox nicht erreichbar (Versuch ${statusFailures}): ${wallboxError.message}`);
    }
    if (bridge && !haUnavailableNotified && statusFailures >= HA_UNAVAILABLE_AFTER_FAILURES) {
      haUnavailableNotified = true;
      await bridge.setAvailable(false).catch(() => {});
    }
  }

  /**
   * Übernimmt seit dem letzten Aufruf abgeschlossene, selbst rekonstruierte
   * Modbus-Ladevorgänge sofort in die Warteschlange (No-Op bei REST - dort
   * liefert die Wallbox ihre Historie über sessionsTick()/getSessions(since)).
   */
  async function flushModbusSessions() {
    if (config.wallbox.protocol !== 'modbus') return;
    const entries = await wallbox.getSessions();
    if (entries.length === 0) return;

    const added = queue.enqueue(entries, identify);
    if (added > 0) {
      logger.info(`${added} neue(r) Ladevorgang/Ladevorgänge übernommen.`);
      await flushQueue();
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

  // Ueberlappungsschutz: setInterval startet den naechsten Durchlauf
  // unabhaengig davon, ob der vorige fertig ist. Bei 10s Takt faellt das nie
  // auf, bei 2s schon: ein Modbus-Lesevorgang plus HTTPS-Push kann laenger
  // dauern, und dann liefen mehrere Abfragen gleichzeitig ueber DIESELBE
  // Modbus-Verbindung -- deren Antworten sind nicht zuverlaessig einander
  // zuzuordnen. Ein hängender Durchlauf laesst den Takt lieber einmal
  // aussetzen, als sich aufzustauen.
  const ticking = { status: false, sessions: false };
  const schedule = (name, fn, intervalMs) => setInterval(() => {
    if (ticking[name]) {
      logger.debug(`${name}-Takt uebersprungen: vorheriger Durchlauf laeuft noch.`);
      return;
    }
    ticking[name] = true;
    fn().catch(() => {}).finally(() => { ticking[name] = false; });
  }, intervalMs);

  const statusTimer = schedule('status', statusTick, config.statusIntervalMs);
  const sessionsTimer = schedule('sessions', sessionsTick, config.sessionsIntervalMs);

  // ------------------------------------------------------- Herunterfahren
  async function shutdown(signal) {
    logger.info(`${signal} empfangen - beende.`);
    clearInterval(statusTimer);
    clearInterval(sessionsTimer);
    const stats = queue.stats();
    if (stats.pending > 0) {
      logger.warn(`${stats.pending} Vorgang/Vorgänge noch nicht zugestellt - bleiben gespeichert.`);
    }

    // "offline" melden, bevor der Prozess verschwindet - das Last-Will-
    // Testament des MQTT-Clients greift nur bei einem harten Absturz.
    if (bridge) await bridge.close().catch(() => {});
    if (mqttConn) await new Promise((resolve) => mqttConn.client.end(false, {}, resolve)).catch(() => {});

    process.exit(0);
  }

  // Erzwungenes Beenden, falls das MQTT-Abmelden hängen bleibt - ein
  // Add-on-Neustart darf nicht an einem trägen Broker scheitern.
  function shutdownWithTimeout(signal) {
    const forceExit = setTimeout(() => {
      logger.warn('Herunterfahren dauert zu lange - erzwinge Beenden.');
      process.exit(1);
    }, 5000);
    forceExit.unref?.();
    shutdown(signal).finally(() => clearTimeout(forceExit));
  }

  process.on('SIGTERM', () => shutdownWithTimeout('SIGTERM'));
  process.on('SIGINT', () => shutdownWithTimeout('SIGINT'));

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
