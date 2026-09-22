'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const { HomeAssistantBridge, entityDefinitions, topicsFor } = require('../lib/haBridge');

/** Sammelt publish()-Aufrufe, wie ein echter MQTT-Client sie ausführen würde. */
function fakePublisher() {
  const calls = [];
  return {
    calls,
    publish: async (topic, payload, opts) => { calls.push({ topic, payload, opts }); },
  };
}

function makeBridge(publisher) {
  return new HomeAssistantBridge(
    { nodeId: 'mennekes_wallbox', discoveryPrefix: 'homeassistant', deviceName: 'Meine Wallbox', version: '1.0.0' },
    publisher,
    { info: () => {}, warn: () => {}, debug: () => {} } // stummer Logger für die Tests
  );
}

describe('topicsFor', () => {
  test('leitet Zustands- und Verfügbarkeitsthema konsistent ab', () => {
    const topics = topicsFor('mennekes_wallbox');
    assert.strictEqual(topics.base, 'mennekes_connector/mennekes_wallbox');
    assert.strictEqual(topics.state, 'mennekes_connector/mennekes_wallbox/state');
    assert.strictEqual(topics.availability, 'mennekes_connector/mennekes_wallbox/availability');
  });

  test('liefert für unterschiedliche Knoten unterschiedliche Themen', () => {
    assert.notStrictEqual(topicsFor('a').base, topicsFor('b').base);
  });
});

describe('HomeAssistantBridge#publishDiscovery', () => {
  test('veröffentlicht eine Konfiguration je definierter Entity', async () => {
    const publisher = fakePublisher();
    const bridge = makeBridge(publisher);

    await bridge.publishDiscovery();

    assert.strictEqual(publisher.calls.length, entityDefinitions().length);
  });

  test('jede Konfiguration ist retained und verweist auf dasselbe Gerät', async () => {
    const publisher = fakePublisher();
    const bridge = makeBridge(publisher);

    await bridge.publishDiscovery();

    for (const call of publisher.calls) {
      assert.strictEqual(call.opts.retain, true);
      const payload = JSON.parse(call.payload);
      assert.deepStrictEqual(payload.device.identifiers, ['mennekes_wallbox']);
      assert.strictEqual(payload.device.name, 'Meine Wallbox');
      assert.strictEqual(payload.availability_topic, 'mennekes_connector/mennekes_wallbox/availability');
      assert.strictEqual(payload.state_topic, 'mennekes_connector/mennekes_wallbox/state');
    }
  });

  test('jede Entity hat eine eindeutige unique_id und liegt im richtigen Themenpfad', async () => {
    const publisher = fakePublisher();
    const bridge = makeBridge(publisher);

    await bridge.publishDiscovery();

    const ids = publisher.calls.map((call) => JSON.parse(call.payload).unique_id);
    assert.strictEqual(new Set(ids).size, ids.length, 'unique_id ist nicht überall eindeutig');

    for (const call of publisher.calls) {
      assert.match(call.topic, /^homeassistant\/(sensor|binary_sensor)\/mennekes_wallbox\/[a-z_]+\/config$/);
    }
  });

  test('binary_sensor-Entities liefern payload_on/off passend zum Zustandstemplate', async () => {
    const publisher = fakePublisher();
    const bridge = makeBridge(publisher);

    await bridge.publishDiscovery();

    const binarySensors = publisher.calls.filter((call) => call.topic.includes('/binary_sensor/'));
    assert.ok(binarySensors.length >= 2);
    for (const call of binarySensors) {
      const payload = JSON.parse(call.payload);
      assert.strictEqual(payload.payload_on, 'true');
      assert.strictEqual(payload.payload_off, 'false');
    }
  });

  test('verwendet einen anderen Discovery-Prefix, wenn konfiguriert', async () => {
    const publisher = fakePublisher();
    const bridge = new HomeAssistantBridge(
      { nodeId: 'x', discoveryPrefix: 'custom-prefix', deviceName: 'X' }, publisher, console
    );

    await bridge.publishDiscovery();

    assert.ok(publisher.calls.every((call) => call.topic.startsWith('custom-prefix/')));
  });
});

describe('HomeAssistantBridge#publishState', () => {
  test('veröffentlicht den Zustand unretained auf dem gemeinsamen Zustandsthema', async () => {
    const publisher = fakePublisher();
    const bridge = makeBridge(publisher);

    await bridge.publishState({ status: 'charging', powerKw: 11.04 });

    const stateCall = publisher.calls.find((call) => call.topic === 'mennekes_connector/mennekes_wallbox/state');
    assert.ok(stateCall);
    assert.strictEqual(stateCall.opts.retain, false);
    assert.deepStrictEqual(JSON.parse(stateCall.payload), { status: 'charging', powerKw: 11.04 });
  });

  test('meldet die Discovery-Konfiguration automatisch vor dem ersten Zustand an', async () => {
    const publisher = fakePublisher();
    const bridge = makeBridge(publisher);

    await bridge.publishState({ status: 'charging' });

    const configCalls = publisher.calls.filter((call) => call.topic.endsWith('/config'));
    assert.strictEqual(configCalls.length, entityDefinitions().length);
  });

  test('meldet Discovery nur beim ersten Mal, nicht bei jedem Zustand', async () => {
    const publisher = fakePublisher();
    const bridge = makeBridge(publisher);

    await bridge.publishState({ status: 'a' });
    await bridge.publishState({ status: 'b' });
    await bridge.publishState({ status: 'c' });

    const configCalls = publisher.calls.filter((call) => call.topic.endsWith('/config'));
    assert.strictEqual(configCalls.length, entityDefinitions().length);
  });

  test('setzt die Verfügbarkeit auf online', async () => {
    const publisher = fakePublisher();
    const bridge = makeBridge(publisher);

    await bridge.publishState({ status: 'charging' });

    const availCall = publisher.calls.find((call) => call.topic === 'mennekes_connector/mennekes_wallbox/availability');
    assert.strictEqual(availCall.payload, 'online');
    assert.strictEqual(availCall.opts.retain, true);
  });
});

describe('HomeAssistantBridge#setAvailable / close', () => {
  test('setAvailable(false) veröffentlicht "offline" retained', async () => {
    const publisher = fakePublisher();
    const bridge = makeBridge(publisher);

    await bridge.setAvailable(false);

    assert.strictEqual(publisher.calls.length, 1);
    assert.strictEqual(publisher.calls[0].payload, 'offline');
    assert.strictEqual(publisher.calls[0].opts.retain, true);
  });

  test('close() meldet "offline", auch ohne vorherigen publishState-Aufruf', async () => {
    const publisher = fakePublisher();
    const bridge = makeBridge(publisher);

    await bridge.close();

    assert.strictEqual(publisher.calls[0].payload, 'offline');
  });

  test('close() wirft nicht, wenn der Publisher fehlschlägt', async () => {
    const bridge = makeBridge({ publish: async () => { throw new Error('MQTT weg'); } });
    await assert.doesNotReject(() => bridge.close());
  });
});

describe('entityDefinitions', () => {
  test('jede Entity hat ein eigenes value_template', () => {
    for (const entity of entityDefinitions()) {
      assert.ok(entity.config.value_template, `${entity.objectId} hat kein value_template`);
    }
  });

  test('component ist entweder sensor oder binary_sensor', () => {
    for (const entity of entityDefinitions()) {
      assert.ok(['sensor', 'binary_sensor'].includes(entity.component));
    }
  });

  test('object_ids sind eindeutig', () => {
    const ids = entityDefinitions().map((entity) => entity.objectId);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  test('der Zählerstand nutzt state_class total_increasing (Energie-Dashboard-tauglich)', () => {
    const meter = entityDefinitions().find((entity) => entity.objectId === 'meter');
    assert.strictEqual(meter.config.state_class, 'total_increasing');
  });

  test('die Sitzungsenergie nutzt state_class measurement (kein lebenslanger Zähler)', () => {
    const session = entityDefinitions().find((entity) => entity.objectId === 'session_energy');
    assert.strictEqual(session.config.state_class, 'measurement');
  });
});
