'use strict';

jest.mock('puppeteer', () => ({
  launch: jest.fn(async () => ({
    newPage: jest.fn(async () => ({
      setContent: jest.fn(async () => undefined),
      evaluate: jest.fn(async () => undefined),
      pdf: jest.fn(async () => Buffer.from('%PDF')),
      close: jest.fn(async () => undefined),
    })),
    close: jest.fn(async () => undefined),
    connected: true,
  })),
}));

const request = require('supertest');
const config = require('../src/config');
const { createApp } = require('../src/app');
const LiveFeed = require('../src/services/liveFeed');
const fleet = require('../src/repositories/fleetRepository');
const cardLearning = require('../src/repositories/cardLearningRepository');
const database = require('../src/db');
const { resetDatabase, createUser, login } = require('./helpers/testDb');

const TOKEN = 'connector-token-fuer-die-tests';
const PASSWORD = 'test-passwort-1234';
const auth = { Authorization: `Bearer ${TOKEN}` };

let app;
let liveFeed;
let vehicle;

beforeEach(async () => {
  resetDatabase();
  config.connector.mode = 'connector';
  config.connector.token = TOKEN;
  liveFeed = new LiveFeed({ pushOnly: true, pollIntervalMs: 60000 });
  ({ app } = createApp({ mennekesClient: null, liveFeed }));
  await createUser({ username: 'admin', password: PASSWORD, role: 'admin' });
  vehicle = fleet.createVehicle({ plate: 'TUT-MK-100', employeeName: 'Moritz' });
});

afterEach(() => {
  liveFeed.shutdown();
  config.connector.mode = 'direct';
  config.connector.token = undefined;
});

/** Status, wie ihn der Connector waehrend eines Ladevorgangs schickt. */
const chargingStatus = (uid) => ({
  status: { status: 'C', ActPwr: 11000, ChgNrg: 1200, Uid: uid },
});

describe('Anlernmodus', () => {
  it('lernt nichts an, solange er nicht gestartet ist', () => {
    expect(cardLearning.tryCapture('04d3a1b27c5e80')).toEqual({ captured: false });
    expect(fleet.resolveAttribution('04d3a1b27c5e80').vehicleId).toBeNull();
  });

  it('ordnet die nächste unbekannte Karte dem Fahrzeug zu und beendet sich', () => {
    cardLearning.arm(vehicle.id, 'admin');

    const result = cardLearning.tryCapture('04d3a1b27c5e80');

    expect(result.captured).toBe(true);
    expect(fleet.resolveAttribution('04d3a1b27c5e80').vehiclePlate).toBe('TUT-MK-100');
    const state = cardLearning.status();
    expect(state.armed).toBe(false);
    expect(state.capturedRfid).toBe('04d3a1b27c5e80');
  });

  it('schlägt "Laden ohne Karte" nie einem Fahrzeug zu und bleibt aktiv', () => {
    // Sonst ginge jede kartenlose Ladung auf die Rechnung dieses Dienstwagens.
    cardLearning.arm(vehicle.id, 'admin');

    const result = cardLearning.tryCapture('aaaabbbbccccddddeeee');

    expect(result.captured).toBe(false);
    expect(fleet.resolveAttribution('aaaabbbbccccddddeeee').vehicleId).toBeNull();
    const state = cardLearning.status();
    expect(state.armed).toBe(true);
    expect(state.notice).toMatch(/ohne Karte/);
  });

  it('bucht eine bereits zugeordnete Karte NICHT stillschweigend um', () => {
    // Sonst genuegte es, dass waehrend des Anlernens zufaellig jemand
    // anderes mit seiner Karte laedt.
    const anderes = fleet.createVehicle({ plate: 'TUT-PK-200' });
    fleet.assignCardToVehicle('04d3a1b27c5e80', anderes.id);
    cardLearning.arm(vehicle.id, 'admin');

    const result = cardLearning.tryCapture('04d3a1b27c5e80');

    expect(result.captured).toBe(false);
    expect(fleet.resolveAttribution('04d3a1b27c5e80').vehiclePlate).toBe('TUT-PK-200');
    expect(cardLearning.status().notice).toMatch(/gehört bereits zu TUT-PK-200/);
  });

  it('greift nach Ablauf der Frist nicht mehr', () => {
    cardLearning.arm(vehicle.id, 'admin');
    database.db().prepare("UPDATE card_learning SET expires_at = '2000-01-01T00:00:00.000Z'").run();

    expect(cardLearning.tryCapture('04d3a1b27c5e80').captured).toBe(false);
    expect(cardLearning.status().armed).toBe(false);
  });

  it('übernimmt frühere Ladevorgänge der Karte rückwirkend', () => {
    database.db().prepare(`
      INSERT INTO charging_sessions (id, start_at, end_at, duration_seconds, energy_kwh, rfid, rfid_raw, source, received_at)
      VALUES ('alt', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', 3600, 12, '04d3a1b27c5e80', '04d3a1b27c5e80', 'connector', '2026-09-01T11:00:00Z')
    `).run();
    cardLearning.arm(vehicle.id, 'admin');

    const result = cardLearning.tryCapture('04d3a1b27c5e80');

    expect(result.backfilled).toBe(1);
    const row = database.db().prepare("SELECT vehicle_plate FROM charging_sessions WHERE id = 'alt'").get();
    expect(row.vehicle_plate).toBe('TUT-MK-100');
  });
});

describe('Anlernen über den Connector', () => {
  it('erkennt die Karte im Status-Takt während des Ladens', async () => {
    cardLearning.arm(vehicle.id, 'admin');

    await request(app).post('/api/ingest/status').set(auth).send(chargingStatus('04d3a1b27c5e80')).expect(200);

    expect(fleet.resolveAttribution('04d3a1b27c5e80').vehiclePlate).toBe('TUT-MK-100');
  });

  it('friert schon den ERSTEN Ladevorgang mit der neuen Zuordnung ein', async () => {
    // Der Kernpunkt: kommt ein kurzer Vorgang an, ohne dass der Status-Takt
    // die Karte vorher gesehen hat, wird sie VOR dem Speichern angelernt -
    // der Vorgang braucht dann keine rueckwirkende Korrektur.
    cardLearning.arm(vehicle.id, 'admin');

    await request(app).post('/api/ingest/sessions').set(auth).send({
      sessions: [{
        normalized: true, id: 'kurz-1',
        start: '2026-09-23T18:05:43Z', end: '2026-09-23T18:06:44Z',
        durationSeconds: 61, energyKwh: 0.169, rfid: '04d3a1b27c5e80', rfidRaw: '04d3a1b27c5e80',
      }],
    }).expect(200);

    const row = database.db().prepare("SELECT vehicle_id, vehicle_plate FROM charging_sessions WHERE id = 'kurz-1'").get();
    expect(row.vehicle_id).toBe(vehicle.id);
    expect(row.vehicle_plate).toBe('TUT-MK-100');
  });
});

describe('Laden ohne Karte', () => {
  it('erkennt die bekannte Platzhalter-IdTag automatisch', () => {
    expect(fleet.isFreeCharging('aaaabbbbccccddddeeee')).toBe(true);
    expect(fleet.isFreeCharging('04d3a1b27c5e80')).toBe(false);
  });

  it('lässt sich ausdrücklich umstellen - in beide Richtungen', () => {
    fleet.setCardKind('aaaabbbbccccddddeeee', 'card');
    expect(fleet.isFreeCharging('aaaabbbbccccddddeeee', fleet.cardKind('aaaabbbbccccddddeeee'))).toBe(false);

    fleet.setCardKind('1234abcd', 'free');
    expect(fleet.isFreeCharging('1234abcd', fleet.cardKind('1234abcd'))).toBe(true);
  });

  it('wird in der Kartenliste als solches gekennzeichnet', () => {
    database.db().prepare(`
      INSERT INTO charging_sessions (id, start_at, end_at, duration_seconds, energy_kwh, rfid, rfid_raw, source, received_at)
      VALUES ('frei', '2026-09-23T18:09:24Z', '2026-09-23T18:09:45Z', 21, 0.051, 'aaaabbbbccccddddeeee', 'aaaabbbbccccddddeeee', 'connector', '2026-09-23T18:10:00Z')
    `).run();

    const karte = fleet.listCards().find((c) => c.rfid === 'aaaabbbbccccddddeeee');
    expect(karte.isFreeCharging).toBe(true);
  });
});

describe('Anlern-API', () => {
  it('startet, meldet und bricht das Anlernen ab', async () => {
    const { agent, csrfToken } = await login(request, app, { username: 'admin', password: PASSWORD });

    const armed = await agent.post('/api/fleet/learn').set('X-CSRF-Token', csrfToken)
      .send({ vehicleId: vehicle.id }).expect(200);
    expect(armed.body.armed).toBe(true);
    expect(armed.body.vehiclePlate).toBe('TUT-MK-100');

    const polled = await agent.get('/api/fleet/learn').expect(200);
    expect(polled.body.armed).toBe(true);

    const cancelled = await agent.delete('/api/fleet/learn').set('X-CSRF-Token', csrfToken).expect(200);
    expect(cancelled.body.armed).toBe(false);
  });

  it('lernt für ein stillgelegtes Fahrzeug keine Karte an', async () => {
    const { agent, csrfToken } = await login(request, app, { username: 'admin', password: PASSWORD });
    fleet.updateVehicle(vehicle.id, { active: false });

    await agent.post('/api/fleet/learn').set('X-CSRF-Token', csrfToken)
      .send({ vehicleId: vehicle.id }).expect(400);
  });

  it('ist Betrachtern verschlossen', async () => {
    await createUser({ username: 'gast', password: PASSWORD, role: 'viewer' });
    const { agent, csrfToken } = await login(request, app, { username: 'gast', password: PASSWORD });

    await agent.get('/api/fleet/learn').expect(403);
    await agent.post('/api/fleet/learn').set('X-CSRF-Token', csrfToken).send({ vehicleId: vehicle.id }).expect(403);
  });

  it('vermerkt am Handy gelesene Karten im Protokoll als NFC', async () => {
    const { agent, csrfToken } = await login(request, app, { username: 'admin', password: PASSWORD });

    await agent.post('/api/fleet/cards/04d3a1b27c5e80/assign').set('X-CSRF-Token', csrfToken)
      .send({ vehicleId: vehicle.id, source: 'nfc' }).expect(200);

    const eintrag = database.db().prepare(
      "SELECT detail FROM audit_log WHERE action = 'fleet.card.assigned' ORDER BY id DESC LIMIT 1"
    ).get();
    expect(eintrag.detail).toMatch(/\[nfc\]/);
  });
});
