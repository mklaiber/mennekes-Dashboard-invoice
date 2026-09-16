'use strict';

/**
 * Tests der Warteschlange.
 *
 * Node-eigener Test-Runner (`node --test`) statt Jest: das Add-on-Image soll
 * keine Entwicklungsabhängigkeiten mitschleppen.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Queue = require('../lib/queue');

/** Frisches Zustandsverzeichnis je Test. */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-'));
}

const identify = (entry) => (entry && entry.id ? String(entry.id) : null);

test('nimmt neue Einträge auf', () => {
  const queue = new Queue(tempDir());
  const added = queue.enqueue([{ id: 'a' }, { id: 'b' }], identify);

  assert.strictEqual(added, 2);
  assert.strictEqual(queue.size, 2);
});

test('nimmt denselben Eintrag nicht zweimal auf', () => {
  const queue = new Queue(tempDir());
  queue.enqueue([{ id: 'a' }], identify);

  assert.strictEqual(queue.enqueue([{ id: 'a' }], identify), 0);
  assert.strictEqual(queue.size, 1);
});

test('überspringt Einträge ohne ID', () => {
  const queue = new Queue(tempDir());
  const added = queue.enqueue([{ id: 'a' }, { ohneId: true }, null], identify);

  assert.strictEqual(added, 1);
});

test('nimmt bereits zugestellte Einträge nicht erneut auf', () => {
  const queue = new Queue(tempDir());
  queue.enqueue([{ id: 'a' }], identify);
  queue.acknowledge(['a']);

  // Die Wallbox liefert bei jedem Abruf dieselbe Historie - ohne diese Sperre
  // würde jeder Ladevorgang endlos erneut gesendet.
  assert.strictEqual(queue.enqueue([{ id: 'a' }], identify), 0);
  assert.strictEqual(queue.size, 0);
});

test('übersteht einen Neustart ohne Datenverlust', () => {
  const dir = tempDir();
  const first = new Queue(dir);
  first.enqueue([{ id: 'a', energy: 12 }, { id: 'b', energy: 5 }], identify);
  first.acknowledge(['a']);

  // Genau der Fall, für den es die Datei gibt: Add-on-Update, Stromausfall.
  const second = new Queue(dir);

  assert.strictEqual(second.size, 1);
  assert.strictEqual(second.batch()[0].id, 'b');
  // 'a' gilt weiterhin als zugestellt.
  assert.strictEqual(second.enqueue([{ id: 'a' }], identify), 0);
});

test('schreibt atomar und hinterlässt keine Restdatei', () => {
  const dir = tempDir();
  const queue = new Queue(dir);
  queue.enqueue([{ id: 'a' }], identify);

  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

test('beginnt bei kaputter Datei neu, statt abzustürzen', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'pending-sessions.json'), '{ kein JSON', 'utf8');

  const queue = new Queue(dir);

  assert.strictEqual(queue.size, 0);
  assert.strictEqual(queue.enqueue([{ id: 'a' }], identify), 1);
});

test('liefert Pakete in der gewünschten Größe', () => {
  const queue = new Queue(tempDir());
  queue.enqueue(Array.from({ length: 250 }, (unused, i) => ({ id: `s${i}` })), identify);

  assert.strictEqual(queue.batch(100).length, 100);
  assert.strictEqual(queue.batch(500).length, 250);
});

test('verwirft dauerhaft abgelehnte Einträge', () => {
  const queue = new Queue(tempDir());
  queue.enqueue([{ id: 'kaputt' }, { id: 'gut' }], identify);

  queue.discard(['kaputt']);

  // Ohne das Verwerfen bliebe ein einzelner fehlerhafter Datensatz für immer
  // vorne stehen und blockierte alle nachfolgenden.
  assert.strictEqual(queue.size, 1);
  assert.strictEqual(queue.batch()[0].id, 'gut');
  assert.strictEqual(queue.enqueue([{ id: 'kaputt' }], identify), 0);
});

test('verwirft beim Überlauf die ältesten Einträge', () => {
  const dir = tempDir();
  const queue = new Queue(dir, { maxEntries: 10 });

  queue.enqueue(Array.from({ length: 25 }, (unused, i) => ({ id: `s${i}` })), identify);

  assert.strictEqual(queue.size, 10);
  // Die jüngsten bleiben - sie gehören zur laufenden Abrechnung.
  const ids = queue.batch(10).map((entry) => entry.id);
  assert.ok(ids.includes('s24'));
  assert.ok(!ids.includes('s0'));
});

test('meldet Kennzahlen für die Betriebsanzeige', () => {
  const queue = new Queue(tempDir());
  queue.enqueue([{ id: 'a' }, { id: 'b' }], identify);
  queue.acknowledge(['a']);

  const stats = queue.stats();
  assert.strictEqual(stats.pending, 1);
  assert.strictEqual(stats.delivered, 1);
  assert.ok(stats.file.endsWith('pending-sessions.json'));
});
