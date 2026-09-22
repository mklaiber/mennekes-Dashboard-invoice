'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { buildUrl } = require('../lib/mqttClient');

describe('buildUrl', () => {
  test('baut eine mqtt://-URL ohne TLS', () => {
    assert.strictEqual(buildUrl({ host: 'core-mosquitto', port: 1883, ssl: false }), 'mqtt://core-mosquitto:1883');
  });

  test('baut eine mqtts://-URL mit TLS', () => {
    assert.strictEqual(buildUrl({ host: 'broker.example.com', port: 8883, ssl: true }), 'mqtts://broker.example.com:8883');
  });

  test('funktioniert mit einer IP-Adresse als Host', () => {
    assert.strictEqual(buildUrl({ host: '192.168.1.5', port: 1883, ssl: false }), 'mqtt://192.168.1.5:1883');
  });
});
