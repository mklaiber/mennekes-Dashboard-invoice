'use strict';

const { test, describe } = require('node:test');
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

// ============================================================================
// MENNEKES AMTRON (MHCP/1.0) - dieselbe reverse-engineerte API wie serverseitig
// in src/services/mennekesClient.js. Der Connector reicht Rohdaten durch,
// braucht das Zustandsprotokoll für /ChargeRecords aber selbst, um die
// Warteschlange zu befüllen.
// ============================================================================

describe('AMTRON: DevKey als Query-Parameter', () => {
  test('hängt den Token als Query-Parameter an jede Anfrage', async () => {
    const calls = [];
    const http = { get: async (path, opts) => { calls.push({ path, params: opts.params }); return { data: { ChgState: 'Idle' } }; } };
    const box = new Wallbox({
      baseUrl: 'http://x', authMode: 'query', authQueryParam: 'DevKey', token: '1234',
      endpoints: { status: '/ChargeData' },
    }, http);

    await box.getStatus();

    assert.deepStrictEqual(calls[0].params, { DevKey: '1234' });
  });

  test('bleibt ohne Token wirkungslos', async () => {
    const calls = [];
    const http = { get: async (path, opts) => { calls.push(opts.params); return { data: {} }; } };
    const box = new Wallbox({
      baseUrl: 'http://x', authMode: 'query', authQueryParam: 'DevKey', token: undefined,
      endpoints: { status: '/ChargeData' },
    }, http);

    await box.getStatus();

    assert.deepStrictEqual(calls[0], {});
  });
});

describe('AMTRON: zustandsbehaftetes Historienprotokoll (Open/Read/Close)', () => {
  /** Simuliert die Open/Read/Close-Zustandsmaschine von /ChargeRecords. */
  function fakeAmtronHistory(batches) {
    const calls = [];
    let readIndex = 0;
    return {
      calls,
      get: async (path, opts) => {
        calls.push({ path, params: opts.params });
        const state = opts.params.State;
        if (state === 'Open') {
          const total = batches.reduce((sum, batch) => sum + batch.length, 0);
          return { data: { RemEntries: total } };
        }
        if (state === 'Read') {
          const batch = batches[readIndex] || [];
          readIndex += 1;
          const remaining = batches.slice(readIndex).reduce((sum, b) => sum + b.length, 0);
          return { data: { RemEntries: remaining, Records: batch } };
        }
        if (state === 'Close') return { data: {} };
        throw new Error(`unerwarteter State: ${state}`);
      },
    };
  }

  test('durchläuft Open, mehrere Read-Schritte und Close', async () => {
    const http = fakeAmtronHistory([
      [{ Start: 1772688600, Stop: 1772700300, ChrNr: 24500, Uid: 'AABB' }],
      [{ Start: 1772775000, Stop: 1772786700, ChrNr: 32250, Uid: 'CCDD' }],
    ]);
    const box = new Wallbox({
      baseUrl: 'http://x', sessionsProtocol: 'amtron-stateful',
      endpoints: { sessions: '/ChargeRecords' },
    }, http);

    const sessions = await box.getSessions(new Date('2026-03-01'));

    assert.strictEqual(sessions.length, 2);
    assert.deepStrictEqual(http.calls.map((call) => call.params.State), ['Open', 'Read', 'Read', 'Close']);
  });

  test('sendet Start/End als Unix-Sekunden', async () => {
    const http = fakeAmtronHistory([]);
    const box = new Wallbox({
      baseUrl: 'http://x', sessionsProtocol: 'amtron-stateful',
      endpoints: { sessions: '/ChargeRecords' },
    }, http);

    await box.getSessions(new Date('2026-03-01T00:00:00Z'));

    assert.strictEqual(http.calls[0].params.Start, Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000));
    assert.ok(Number.isInteger(http.calls[0].params.End));
  });

  test('schließt die Sitzung auch, wenn Read fehlschlägt', async () => {
    const states = [];
    const http = {
      get: async (path, opts) => {
        states.push(opts.params.State);
        if (opts.params.State === 'Open') return { data: { RemEntries: 5 } };
        if (opts.params.State === 'Read') throw new Error('ECONNRESET');
        return { data: {} };
      },
    };
    const box = new Wallbox({
      baseUrl: 'http://x', sessionsProtocol: 'amtron-stateful',
      endpoints: { sessions: '/ChargeRecords' },
    }, http);

    await assert.rejects(() => box.getSessions(new Date('2026-03-01')));
    assert.ok(states.includes('Close'), 'Close wurde trotz Fehler nicht gesendet');
  });

  test('bricht ab, wenn eine Read-Antwort leer bleibt, obwohl RemEntries > 0', async () => {
    let readCalls = 0;
    const http = {
      get: async (path, opts) => {
        if (opts.params.State === 'Open') return { data: { RemEntries: 999 } };
        if (opts.params.State === 'Read') { readCalls += 1; return { data: { RemEntries: 999, Records: [] } }; }
        return { data: {} };
      },
    };
    const box = new Wallbox({
      baseUrl: 'http://x', sessionsProtocol: 'amtron-stateful',
      endpoints: { sessions: '/ChargeRecords' },
    }, http);

    const sessions = await box.getSessions(new Date('2026-03-01'));

    assert.deepStrictEqual(sessions, []);
    assert.strictEqual(readCalls, 1);
  });

  test('verwendet ohne Konfiguration weiterhin das einfache Protokoll', async () => {
    const calls = [];
    const http = { get: async (path, opts) => { calls.push(opts.params); return { data: { transactions: [] } }; } };
    const box = new Wallbox({ baseUrl: 'http://x', endpoints: { sessions: '/api/v1/transactions' } }, http);

    await box.getSessions(new Date('2026-03-01'));

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].State, undefined);
  });
});

describe('AMTRON: extractArray-Fallbacks', () => {
  test('findet Datensätze unter "Records"', () => {
    const result = Wallbox.extractArray({ RemEntries: 0, Records: [{ Start: 1, ChrNr: 100 }] });
    assert.strictEqual(result.length, 1);
  });

  test('erkennt flach abgelegte Datensätze ohne Array-Hülle', () => {
    const result = Wallbox.extractArray({
      RemEntries: 0, first: { Start: 1, ChrNr: 100 }, second: { Start: 2, ChrNr: 200 },
    });
    assert.strictEqual(result.length, 2);
  });
});
