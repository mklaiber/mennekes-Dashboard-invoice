'use strict';

const LiveFeed = require('../src/services/liveFeed');
const { enrichWithIdentity } = require('../src/services/liveFeed');
const settingsStore = require('../src/config/settings');
const MennekesClient = require('../src/services/mennekesClient');
const fixtures = require('./fixtures/wallbox');

/** Response-Attrappe, die die geschriebenen SSE-Frames sammelt. */
function fakeResponse() {
  return { frames: [], write(chunk) { this.frames.push(chunk); return true; }, end: jest.fn() };
}

function fakeClient() {
  return { getLiveStatus: jest.fn(async () => MennekesClient.normalizeStatus(fixtures.statusCharging)) };
}

beforeEach(() => {
  settingsStore.reset();
  settingsStore.save({ rfidMappings: fixtures.rfidMappings });
});

describe('enrichWithIdentity', () => {
  it('ergänzt den Klartextnamen der Ladekarte', () => {
    const state = enrichWithIdentity(MennekesClient.normalizeStatus(fixtures.statusCharging));

    expect(state.rfidName).toBe('Max Mustermann');
    expect(state.rfidPlate).toBe('M-EV 1234');
  });

  it('lässt den Namen leer, wenn die Karte unbekannt ist', () => {
    const state = enrichWithIdentity(MennekesClient.normalizeStatus({ status: 'Charging', rfid: 'DEADBEEF' }));
    expect(state.rfidName).toBeNull();
  });

  it('kommt ohne Karte klar', () => {
    const state = enrichWithIdentity(MennekesClient.normalizeStatus({ status: 'A' }));
    expect(state.rfidName).toBeNull();
    expect(state.rfidPlate).toBeNull();
  });
});

describe('LiveFeed', () => {
  it('fragt die Wallbox ab und verteilt den Zustand', async () => {
    const client = fakeClient();
    const feed = new LiveFeed({ client, pollIntervalMs: 60000 });
    const res = fakeResponse();

    feed.addSubscriber(res);
    await feed.poll();

    expect(client.getLiveStatus).toHaveBeenCalled();
    expect(res.frames.join('')).toContain('event: status');
    expect(res.frames.join('')).toContain('"powerKw":11.04');
    feed.shutdown();
  });

  it('fragt EINMAL ab und verteilt an alle Clients (Fan-out)', async () => {
    const client = fakeClient();
    const feed = new LiveFeed({ client, pollIntervalMs: 60000 });
    const clients = [fakeResponse(), fakeResponse(), fakeResponse()];

    // Erst einen Zustand herstellen: sonst stößt der erste addSubscriber
    // selbst einen Poll an und der explizite Poll unten liefe ins Overlap-Guard.
    await feed.poll();
    clients.forEach((res) => feed.addSubscriber(res));
    clients.forEach((res) => { res.frames.length = 0; });
    client.getLiveStatus.mockClear();

    await feed.poll();

    // Ein Poll, drei Empfänger - die Wallbox wird nicht pro Tab belastet.
    expect(client.getLiveStatus).toHaveBeenCalledTimes(1);
    clients.forEach((res) => expect(res.frames.join('')).toContain('event: status'));
    feed.shutdown();
  });

  it('liefert neuen Clients sofort den letzten bekannten Zustand', async () => {
    const feed = new LiveFeed({ client: fakeClient(), pollIntervalMs: 60000 });
    await feed.poll();

    const res = fakeResponse();
    feed.addSubscriber(res);

    expect(res.frames.join('')).toContain('"status":"charging"');
    feed.shutdown();
  });

  it('startet den Timer erst mit dem ersten Client und stoppt ihn mit dem letzten', () => {
    const feed = new LiveFeed({ client: fakeClient(), pollIntervalMs: 60000 });
    expect(feed.timer).toBeNull();

    const res = fakeResponse();
    feed.addSubscriber(res);
    expect(feed.timer).not.toBeNull();

    feed.removeSubscriber(res);
    expect(feed.timer).toBeNull();
    expect(feed.subscriberCount).toBe(0);
  });

  it('verhindert überlappende Polls', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const client = { getLiveStatus: jest.fn(async () => { await gate; return MennekesClient.normalizeStatus(fixtures.statusCharging); }) };
    const feed = new LiveFeed({ client, pollIntervalMs: 60000 });

    const first = feed.poll();
    await feed.poll(); // darf nicht erneut abfragen

    expect(client.getLiveStatus).toHaveBeenCalledTimes(1);
    release();
    await first;
    feed.shutdown();
  });

  it('sendet ein error-Event statt zu werfen, wenn die Wallbox ausfällt', async () => {
    const client = { getLiveStatus: jest.fn(async () => { throw new Error('ETIMEDOUT'); }) };
    const feed = new LiveFeed({ client, pollIntervalMs: 60000 });
    const res = fakeResponse();
    // 'error'-Listener registrieren, sonst wirft der EventEmitter selbst.
    feed.on('error', () => { /* erwartet */ });

    feed.addSubscriber(res);
    const result = await feed.poll();

    expect(result).toBeNull();
    expect(res.frames.join('')).toContain('event: error');
    expect(res.frames.join('')).toContain('ETIMEDOUT');
    feed.shutdown();
  });

  it('entfernt Clients, deren Verbindung beim Schreiben bricht', async () => {
    const feed = new LiveFeed({ client: fakeClient(), pollIntervalMs: 60000 });
    const broken = { write: () => { throw new Error('EPIPE'); }, end: jest.fn() };

    feed.addSubscriber(broken);
    await feed.poll();

    expect(feed.subscriberCount).toBe(0);
    feed.shutdown();
  });

  it('schließt beim Shutdown alle Verbindungen', () => {
    const feed = new LiveFeed({ client: fakeClient(), pollIntervalMs: 60000 });
    const clients = [fakeResponse(), fakeResponse()];
    clients.forEach((res) => feed.addSubscriber(res));

    feed.shutdown();

    clients.forEach((res) => expect(res.end).toHaveBeenCalled());
    expect(feed.subscriberCount).toBe(0);
    expect(feed.timer).toBeNull();
  });

  it('hält Verbindungen mit Heartbeat-Kommentaren offen', () => {
    const feed = new LiveFeed({ client: fakeClient(), pollIntervalMs: 60000 });
    const res = fakeResponse();
    feed.addSubscriber(res);
    res.frames.length = 0;

    feed.heartbeat();

    expect(res.frames.join('')).toBe(': ping\n\n');
    feed.shutdown();
  });
});
