'use strict';

const test = require('node:test');
const assert = require('node:assert');

const Uplink = require('../lib/uplink');

/** Erzeugt einen Fehler, wie ihn axios bei einer HTTP-Antwort wirft. */
function httpError(status, message = 'abgelehnt') {
  return Object.assign(new Error(message), { response: { status, data: { message } } });
}

test('Netzwerkfehler gelten als wiederholbar', () => {
  const info = Uplink.classify(new Error('ECONNREFUSED'));

  assert.strictEqual(info.retryable, true);
  assert.match(info.message, /Netzwerkfehler/);
});

test('falsches Token gilt NICHT als wiederholbar', () => {
  // Endloses Wiederholen mit falschem Token belastet nur die Gegenstelle.
  for (const status of [401, 403]) {
    assert.strictEqual(Uplink.classify(httpError(status)).retryable, false);
  }
});

test('fehlerhafte Nutzdaten gelten NICHT als wiederholbar', () => {
  for (const status of [400, 422]) {
    assert.strictEqual(Uplink.classify(httpError(status)).retryable, false);
  }
});

test('404 nennt die wahrscheinliche Ursache', () => {
  const info = Uplink.classify(httpError(404));

  assert.strictEqual(info.retryable, false);
  assert.match(info.message, /DATA_SOURCE=connector/);
});

test('Serverfehler und Drosselung gelten als wiederholbar', () => {
  assert.strictEqual(Uplink.classify(httpError(500)).retryable, true);
  assert.strictEqual(Uplink.classify(httpError(503)).retryable, true);
  assert.strictEqual(Uplink.classify(httpError(429)).retryable, true);
});

test('sendet den Zustand und meldet Erfolg', async () => {
  const calls = [];
  const uplink = new Uplink({ baseUrl: 'https://x', token: 't' }, '1.0.0', {
    post: async (path, body) => { calls.push({ path, body }); return { data: { ok: true, normalized: null } }; },
  });

  const result = await uplink.sendStatus({ status: 'Charging' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls[0].path, '/status');
  assert.deepStrictEqual(calls[0].body, { status: { status: 'Charging' } });
});

test('reicht den vom Online-Tool normalisierten Zustand zurück', async () => {
  // Genau dieser Rückgabewert speist die Home-Assistant-Sensoren (siehe
  // haBridge.js) - der Connector interpretiert die Wallbox-Rohdaten
  // bewusst nicht selbst.
  const normalized = { status: 'charging', statusLabel: 'Lädt', powerKw: 11.04, rfidName: 'Max Mustermann' };
  const uplink = new Uplink({ baseUrl: 'https://x', token: 't' }, '1.0.0', {
    post: async () => ({ data: { ok: true, normalized } }),
  });

  const result = await uplink.sendStatus({ ChgState: 'Charging' });
  assert.deepStrictEqual(result.normalized, normalized);
});

test('meldet einen fehlgeschlagenen Zustandsversand, ohne zu werfen', async () => {
  const uplink = new Uplink({ baseUrl: 'https://x', token: 't' }, '1.0.0', {
    post: async () => { throw new Error('ETIMEDOUT'); },
  });

  // Ein verpasster Live-Wert darf den Connector nicht beenden.
  const result = await uplink.sendStatus({});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.normalized, null);
});

test('bestätigt übermittelte Vorgänge anhand ihrer ID', async () => {
  const uplink = new Uplink({ baseUrl: 'https://x', token: 't' }, '1.0.0', {
    post: async () => ({ data: { inserted: 2, updated: 0, rejected: [] } }),
  });

  const result = await uplink.sendSessions([
    { __id: 'a', energy: 1 },
    { __id: 'b', energy: 2 },
  ]);

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.acknowledged, ['a', 'b']);
});

test('trennt abgelehnte von bestätigten Vorgängen', async () => {
  const uplink = new Uplink({ baseUrl: 'https://x', token: 't' }, '1.0.0', {
    post: async () => ({ data: { inserted: 1, updated: 0, rejected: [{ id: 'b', reason: 'ungültige Energiemenge' }] } }),
  });

  const result = await uplink.sendSessions([{ __id: 'a' }, { __id: 'b' }]);

  assert.deepStrictEqual(result.acknowledged, ['a']);
  assert.deepStrictEqual(result.rejected, ['b']);
});

test('meldet bei einem Sendefehler, ob ein neuer Versuch lohnt', async () => {
  const uplink = new Uplink({ baseUrl: 'https://x', token: 't' }, '1.0.0', {
    post: async () => { throw httpError(503); },
  });

  const result = await uplink.sendSessions([{ __id: 'a' }]);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.retryable, true);
  // Nichts bestätigt - die Einträge bleiben in der Warteschlange.
  assert.deepStrictEqual(result.acknowledged, []);
});

test('sendet ein leeres Paket gar nicht erst', async () => {
  let called = false;
  const uplink = new Uplink({ baseUrl: 'https://x', token: 't' }, '1.0.0', {
    post: async () => { called = true; return { data: {} }; },
  });

  const result = await uplink.sendSessions([]);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(called, false);
});
