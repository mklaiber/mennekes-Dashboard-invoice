'use strict';

/**
 * Verbindung zum MQTT-Broker.
 *
 * Reiner Transport - Themen, Payloads und die Discovery-Struktur leben in
 * lib/haBridge.js, damit diese sich ohne echten Broker testen lässt. Diese
 * Datei bündelt ausschließlich das Verbinden und Veröffentlichen über die
 * `mqtt`-Bibliothek.
 */

const mqtt = require('mqtt');
const logger = require('./logger');

/**
 * @param {object} options siehe lib/options.js (Zweig `mqtt`)
 * @returns {string}
 */
function buildUrl(options) {
  const protocol = options.ssl ? 'mqtts' : 'mqtt';
  return `${protocol}://${options.host}:${options.port}`;
}

/**
 * Baut einen MQTT-Client und eine dazu passende Publisher-Schnittstelle für
 * HomeAssistantBridge.
 *
 * @param {object} options siehe lib/options.js (Zweig `mqtt`)
 * @param {string} availabilityTopic Ziel des Last-Will-Testaments
 * @returns {{client: import('mqtt').MqttClient, publisher: {publish: Function},
 *            whenConnected: () => Promise<void>}}
 */
function connect(options, availabilityTopic) {
  const client = mqtt.connect(buildUrl(options), {
    username: options.username || undefined,
    password: options.password || undefined,
    clientId: `mennekes-connector-${options.nodeId}-${Math.random().toString(16).slice(2, 8)}`,
    // Automatisches Neuverbinden - ein kurzer Netzwerkhänger im Heimnetz soll
    // den Connector nicht dauerhaft von Home Assistant trennen.
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    // Wird vom Broker zugestellt, falls der Prozess abstürzt statt sich
    // ordentlich abzumelden - sonst zeigte Home Assistant veraltete Werte
    // unkommentiert als "aktuell" an.
    will: { topic: availabilityTopic, payload: 'offline', retain: true, qos: 1 },
  });

  client.on('error', (error) => logger.warn(`MQTT-Fehler: ${error.message}`));
  client.on('reconnect', () => logger.debug('MQTT: verbinde erneut ...'));
  client.on('close', () => logger.debug('MQTT-Verbindung geschlossen.'));

  const publisher = {
    publish: (topic, payload, opts) => new Promise((resolve, reject) => {
      client.publish(topic, payload, opts, (error) => (error ? reject(error) : resolve()));
    }),
  };

  /** Wartet auf die erste erfolgreiche Verbindung (oder einen Fehler). */
  function whenConnected() {
    if (client.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      function cleanup() {
        client.off('connect', onConnect);
        client.off('error', onError);
      }
      client.once('connect', onConnect);
      client.once('error', onError);
    });
  }

  return { client, publisher, whenConnected };
}

module.exports = { connect, buildUrl };
