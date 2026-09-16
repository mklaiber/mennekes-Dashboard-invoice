'use strict';

/**
 * Woher kommen die Ladevorgänge?
 *
 * Zwei Betriebsarten, bewusst hinter einer gemeinsamen Schnittstelle:
 *
 *  - **direct**    Die Anwendung läuft im selben Netz wie die Wallbox und fragt
 *                  deren REST-API direkt ab.
 *  - **connector** Die Wallbox steht im Heimnetz und ist von außen nicht
 *                  erreichbar. Ein Home-Assistant-Add-on liest sie dort aus und
 *                  schiebt die Daten hierher; gelesen wird dann aus der eigenen
 *                  Datenbank.
 *
 * Alles darüber (Abrechnung, PDF, CSV, Zeitplan) kennt diesen Unterschied nicht.
 */

const config = require('../config');
const logger = require('../utils/logger');
const chargingSessions = require('../repositories/chargingSessionRepository');
const connectorState = require('../repositories/connectorStateRepository');

/** @returns {boolean} true, wenn die Daten von einem Connector kommen */
function isConnectorMode() {
  return config.connector.mode === 'connector';
}

/**
 * Liefert die Ladevorgänge eines Zeitraums.
 *
 * @param {object} params
 * @param {Date} params.from inklusiv
 * @param {Date} params.to exklusiv
 * @param {object} [params.client] Wallbox-Client (nur im direkten Betrieb)
 * @returns {Promise<Array<object>>}
 */
async function getSessions({ from, to, client }) {
  if (isConnectorMode()) {
    const sessions = chargingSessions.findInRange(from, to);
    logger.info(`${sessions.length} Ladevorgänge aus der Connector-Datenbank gelesen.`);

    // Ein leerer Monat kann echt sein - oder bedeuten, dass der Connector nie
    // geliefert hat. Der Unterschied gehört ins Log, nicht in eine stille Null.
    if (sessions.length === 0) {
      const health = connectorState.health();
      if (!health.lastSeenAt) {
        logger.warn('Der Connector hat sich noch nie gemeldet - der Zeitraum ist möglicherweise nicht leer, sondern unvollständig.');
      } else if (health.stale) {
        logger.warn(`Der Connector meldet sich seit ${health.secondsSinceLastSeen} s nicht mehr.`);
      }
    }

    return sessions;
  }

  if (!client) {
    throw new Error('Im direkten Betrieb wird ein Wallbox-Client benötigt.');
  }
  return client.getChargingSessions(from, to);
}

/**
 * Zustand der Datenquelle für Health-Endpunkt und Dashboard.
 *
 * @param {object} [client] Wallbox-Client (nur im direkten Betrieb)
 * @returns {Promise<object>}
 */
async function getSourceHealth(client) {
  if (isConnectorMode()) {
    const health = connectorState.health();
    return {
      mode: 'connector',
      reachable: health.connected,
      ...health,
      storedSessions: chargingSessions.count(),
    };
  }

  const ping = client ? await client.ping() : { reachable: false, error: 'kein Client' };
  return { mode: 'direct', ...ping };
}

module.exports = { isConnectorMode, getSessions, getSourceHealth };
