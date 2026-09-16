'use strict';

const test = require('node:test');
const assert = require('node:assert');

const options = require('../lib/options');

/** Setzt eine vollständige, gültige Umgebung und führt fn aus. */
function withEnv(overrides, fn) {
  const backup = { ...process.env };
  Object.assign(process.env, {
    WALLBOX_URL: 'http://192.168.1.50',
    WALLBOX_AUTH_MODE: 'none',
    TARGET_URL: 'https://abrechnung.example.com',
    TARGET_TOKEN: 'geheim',
    STATUS_INTERVAL_SECONDS: '10',
    SESSIONS_INTERVAL_SECONDS: '900',
  }, overrides);

  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, backup);
  }
}

test('liest eine vollständige Konfiguration', () => {
  withEnv({}, () => {
    const config = options.load();

    assert.strictEqual(config.wallbox.baseUrl, 'http://192.168.1.50');
    assert.strictEqual(config.target.baseUrl, 'https://abrechnung.example.com');
    assert.strictEqual(config.statusIntervalMs, 10000);
    assert.strictEqual(config.sessionsIntervalMs, 900000);
  });
});

test('entfernt abschließende Schrägstriche aus URLs', () => {
  withEnv({ TARGET_URL: 'https://abrechnung.example.com/' }, () => {
    assert.strictEqual(options.load().target.baseUrl, 'https://abrechnung.example.com');
  });
});

test('behandelt bashios "null" wie einen leeren Wert', () => {
  withEnv({ ENDPOINT_METER: 'null' }, () => {
    assert.strictEqual(options.load().wallbox.endpoints.meter, undefined);
  });
});

test('verlangt eine Wallbox-Adresse', () => {
  withEnv({ WALLBOX_URL: '' }, () => {
    assert.throws(() => options.load(), /wallbox_url/);
  });
});

test('verlangt ein Ziel-Token', () => {
  withEnv({ TARGET_TOKEN: '' }, () => {
    assert.throws(() => options.load(), /target_token/);
  });
});

test('lehnt ein Ziel ohne TLS ab', () => {
  // Das Token ginge im Klartext durchs Internet.
  withEnv({ TARGET_URL: 'http://abrechnung.example.com' }, () => {
    assert.throws(() => options.load(), /Klartext/);
  });
});

test('erlaubt http nur auf dem eigenen Rechner', () => {
  // Für einen Testaufbau auf demselben Host ist das unbedenklich.
  withEnv({ TARGET_URL: 'http://localhost:3000' }, () => {
    assert.strictEqual(options.load().target.baseUrl, 'http://localhost:3000');
  });
  withEnv({ TARGET_URL: 'http://127.0.0.1:3000' }, () => {
    assert.strictEqual(options.load().target.baseUrl, 'http://127.0.0.1:3000');
  });
});

test('prüft die Wallbox-Zugangsdaten passend zum Verfahren', () => {
  withEnv({ WALLBOX_AUTH_MODE: 'basic' }, () => {
    assert.throws(() => options.load(), /wallbox_username/);
  });
  withEnv({ WALLBOX_AUTH_MODE: 'bearer' }, () => {
    assert.throws(() => options.load(), /wallbox_token/);
  });
  withEnv({ WALLBOX_AUTH_MODE: 'bearer', WALLBOX_TOKEN: 'abc' }, () => {
    assert.strictEqual(options.load().wallbox.authMode, 'bearer');
  });
});

test('nennt alle Probleme auf einmal', () => {
  withEnv({ WALLBOX_URL: '', TARGET_URL: '', TARGET_TOKEN: '' }, () => {
    try {
      options.load();
      assert.fail('hätte werfen müssen');
    } catch (error) {
      assert.match(error.message, /wallbox_url/);
      assert.match(error.message, /target_url/);
      assert.match(error.message, /target_token/);
    }
  });
});
