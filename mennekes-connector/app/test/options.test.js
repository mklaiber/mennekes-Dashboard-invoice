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

test('AMTRON: "query"-Auth verlangt Token UND Query-Parameternamen', () => {
  withEnv({ WALLBOX_AUTH_MODE: 'query' }, () => {
    assert.throws(() => options.load(), /wallbox_token/);
  });
  withEnv({ WALLBOX_AUTH_MODE: 'query', WALLBOX_TOKEN: '1234' }, () => {
    assert.throws(() => options.load(), /wallbox_auth_query_param/);
  });
  withEnv({ WALLBOX_AUTH_MODE: 'query', WALLBOX_TOKEN: '1234', WALLBOX_AUTH_QUERY_PARAM: 'DevKey' }, () => {
    const config = options.load();
    assert.strictEqual(config.wallbox.authMode, 'query');
    assert.strictEqual(config.wallbox.authQueryParam, 'DevKey');
  });
});


test('MQTT ist per Default aktiviert, aber ohne Host wirkungslos', () => {
  withEnv({}, () => {
    // Kein MQTT_HOST gesetzt - im Add-on käme das vor, wenn weder eine
    // manuelle Adresse noch der Home-Assistant-Dienst einen Broker liefert.
    assert.strictEqual(options.load().mqtt.enabled, false);
  });
});

test('MQTT aktiviert sich automatisch, sobald ein Host bekannt ist', () => {
  withEnv({ MQTT_HOST: 'core-mosquitto' }, () => {
    const config = options.load();
    assert.strictEqual(config.mqtt.enabled, true);
    assert.strictEqual(config.mqtt.host, 'core-mosquitto');
    assert.strictEqual(config.mqtt.port, 1883);
  });
});

test('MQTT_ENABLED=false gewinnt, auch mit gesetztem Host', () => {
  withEnv({ MQTT_HOST: 'core-mosquitto', MQTT_ENABLED: 'false' }, () => {
    assert.strictEqual(options.load().mqtt.enabled, false);
  });
});

test('nutzt sinnvolle Defaults für Discovery-Prefix und Knotennamen', () => {
  withEnv({ MQTT_HOST: 'core-mosquitto' }, () => {
    const config = options.load();
    assert.strictEqual(config.mqtt.discoveryPrefix, 'homeassistant');
    assert.strictEqual(config.mqtt.nodeId, 'mennekes_wallbox');
  });
});

test('macht einen frei eingegebenen Knotennamen MQTT-themen-tauglich', () => {
  withEnv({ MQTT_HOST: 'core-mosquitto', MQTT_NODE_ID: 'Garage Wallbox #2!' }, () => {
    assert.strictEqual(options.load().mqtt.nodeId, 'garage_wallbox_2');
  });
});

test('fehlende MQTT-Konfiguration lässt die übrige Prüfung unberührt', () => {
  // MQTT ist optional - eine fehlende Broker-Adresse darf den Start nicht
  // verhindern, anders als ein fehlendes target_token.
  withEnv({}, () => {
    assert.doesNotThrow(() => options.load());
  });
});
