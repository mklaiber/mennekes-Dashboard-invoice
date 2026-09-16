'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { identify } = require('../index');
const Wallbox = require('../lib/wallbox');

test('nutzt die ID der Wallbox, wenn vorhanden', () => {
  assert.strictEqual(identify({ id: 'tx-1' }), 'tx-1');
  assert.strictEqual(identify({ sessionId: 42 }), '42');
  assert.strictEqual(identify({ transactionId: 'abc' }), 'abc');
});

test('bildet eine stabile Ersatz-ID aus Startzeit und Karte', () => {
  const entry = { startTime: '2026-03-02T06:30:00Z', idTag: '04:A1:B2:C3' };

  // Muss bei jedem Abruf identisch herauskommen, sonst entstünden Dubletten.
  assert.strictEqual(identify(entry), identify({ ...entry }));
  assert.match(identify(entry), /2026-03-02/);
});

test('unterscheidet Vorgänge derselben Karte an unterschiedlichen Zeiten', () => {
  const a = identify({ startTime: '2026-03-02T06:30:00Z', idTag: 'X' });
  const b = identify({ startTime: '2026-03-03T06:30:00Z', idTag: 'X' });

  assert.notStrictEqual(a, b);
});

test('liefert null, wenn nichts Brauchbares da ist', () => {
  assert.strictEqual(identify({}), null);
  assert.strictEqual(identify(null), null);
  assert.strictEqual(identify('text'), null);
});

test('findet die Vorgangsliste in den gängigen Antwortformen', () => {
  const expected = [{ a: 1 }];

  assert.deepStrictEqual(Wallbox.extractArray(expected), expected);
  assert.deepStrictEqual(Wallbox.extractArray({ transactions: expected }), expected);
  assert.deepStrictEqual(Wallbox.extractArray({ sessions: expected }), expected);
  assert.deepStrictEqual(Wallbox.extractArray({ data: expected }), expected);
  assert.deepStrictEqual(Wallbox.extractArray({ data: { sessions: expected } }), expected);
});

test('liefert bei unbekannter Struktur eine leere Liste', () => {
  assert.deepStrictEqual(Wallbox.extractArray({ irgendwas: 42 }), []);
  assert.deepStrictEqual(Wallbox.extractArray(null), []);
});
