'use strict';

// Puppeteer mocken - die App lädt den pdfService beim Start.
// Alle Methoden geben Promises zurück - der echte Puppeteer tut das auch,
// und pdfService hängt an einige davon ein .catch().
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
const chargingSessions = require('../src/repositories/chargingSessionRepository');
const connectorState = require('../src/repositories/connectorStateRepository');
const settingsStore = require('../src/repositories/settingsRepository');
const sessionSource = require('../src/services/sessionSource');
const LiveFeed = require('../src/services/liveFeed');
const { resetDatabase, createUser, login } = require('./helpers/testDb');
const fixtures = require('./fixtures/wallbox');

const TOKEN = 'connector-token-fuer-die-tests';
const PASSWORD = 'test-passwort-1234';

let app;
let liveFeed;

/** Setzt den Connector-Betrieb und baut die App neu. */
function buildConnectorApp() {
  config.connector.mode = 'connector';
  config.connector.token = TOKEN;

  liveFeed = new LiveFeed({ pushOnly: true, pollIntervalMs: 60000 });
  ({ app } = createApp({ mennekesClient: {
    getLiveStatus: jest.fn(async () => { throw new Error('Wallbox ist von hier nicht erreichbar'); }),
    getChargingSessions: jest.fn(async () => { throw new Error('Wallbox ist von hier nicht erreichbar'); }),
    ping: jest.fn(async () => ({ reachable: false, error: 'nicht erreichbar' })),
  }, liveFeed }));

  return app;
}

/** Baut eine Sendung, wie der Connector sie schickt (Rohdaten der Wallbox). */
function sessionPayload(overrides = {}) {
  return {
    id: 'tx-2001',
    startTime: '2026-03-05T06:30:00.000Z',
    endTime: '2026-03-05T09:45:00.000Z',
    energy: 24.5,
    idTag: '04:A1:B2:C3',
    ...overrides,
  };
}

const auth = (token = TOKEN) => ({ Authorization: `Bearer ${token}` });

beforeEach(() => {
  jest.clearAllMocks();
  resetDatabase();
  buildConnectorApp();
});

afterEach(() => {
  if (liveFeed) liveFeed.shutdown();
  config.connector.mode = 'direct';
  config.connector.token = undefined;
});

describe('Authentifizierung der Datenannahme', () => {
  it.each([
    ['/api/ingest/status', 'post'],
    ['/api/ingest/sessions', 'post'],
    ['/api/ingest/health', 'get'],
  ])('weist %s ohne Token ab', async (url, method) => {
    const response = await request(app)[method](url).send({});
    expect(response.status).toBe(401);
  });

  it('weist ein falsches Token ab', async () => {
    const response = await request(app)
      .post('/api/ingest/status')
      .set(auth('falsches-token'))
      .send({ status: {} });

    expect(response.status).toBe(401);
  });

  it('weist ein Token abweichender Länge ab, ohne zu werfen', async () => {
    // timingSafeEqual wirft bei ungleicher Länge - das muss abgefangen sein.
    await request(app).post('/api/ingest/status').set(auth('kurz')).send({ status: {} }).expect(401);
    await request(app).post('/api/ingest/status').set(auth(`${TOKEN}-laenger`)).send({ status: {} }).expect(401);
  });

  it('verlangt das Bearer-Schema', async () => {
    await request(app)
      .post('/api/ingest/status')
      .set({ Authorization: `Basic ${TOKEN}` })
      .send({ status: {} })
      .expect(401);
  });

  it('akzeptiert das richtige Token', async () => {
    await request(app).get('/api/ingest/health').set(auth()).expect(200);
  });

  it('ist im direkten Betrieb gar nicht vorhanden', async () => {
    config.connector.mode = 'direct';

    const response = await request(app).get('/api/ingest/health').set(auth());

    // 404 statt 401: ohne aktivierte Annahme gibt es den Endpunkt nicht.
    expect(response.status).toBe(404);
  });

  it('braucht keine Benutzeranmeldung', async () => {
    // Der Connector ist kein Nutzer - er darf weder Sitzung noch Rolle brauchen.
    const response = await request(app).get('/api/ingest/health').set(auth()).expect(200);
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});

describe('POST /api/ingest/status', () => {
  it('nimmt einen Rohzustand entgegen und normalisiert ihn', async () => {
    await request(app)
      .post('/api/ingest/status')
      .set(auth())
      .send({ status: fixtures.statusCharging })
      .expect(200);

    const state = connectorState.health().status;
    expect(state).toMatchObject({ status: 'charging', statusLabel: 'Lädt', powerKw: 11.04 });
  });

  it('löst den RFID-Namen aus der Zuordnung auf', async () => {
    settingsStore.save({ rfidMappings: fixtures.rfidMappings });

    await request(app).post('/api/ingest/status').set(auth())
      .send({ status: fixtures.statusCharging }).expect(200);

    expect(connectorState.health().status.rfidName).toBe('Max Mustermann');
  });

  it('markiert den Zustand als über den Connector geliefert', async () => {
    await request(app).post('/api/ingest/status').set(auth())
      .send({ status: fixtures.statusCharging }).expect(200);

    expect(connectorState.health().status.viaConnector).toBe(true);
  });

  it('reicht den Zustand an offene Dashboards weiter', async () => {
    const frames = [];
    liveFeed.addSubscriber({ write: (chunk) => frames.push(chunk), end: jest.fn() });

    await request(app).post('/api/ingest/status').set(auth())
      .send({ status: fixtures.statusCharging }).expect(200);

    expect(frames.join('')).toContain('event: status');
    expect(frames.join('')).toContain('"powerKw":11.04');
  });

  it('weist eine Sendung ohne Zustand ab', async () => {
    await request(app).post('/api/ingest/status').set(auth()).send({}).expect(400);
    await request(app).post('/api/ingest/status').set(auth()).send({ status: 'text' }).expect(400);
  });

  it('vermerkt Version und Zeitpunkt des Kontakts', async () => {
    await request(app)
      .post('/api/ingest/status')
      .set({ ...auth(), 'X-Connector-Version': '1.2.3' })
      .send({ status: fixtures.statusCharging })
      .expect(200);

    const health = connectorState.health();
    expect(health.version).toBe('1.2.3');
    expect(health.connected).toBe(true);
    expect(health.secondsSinceLastSeen).toBeLessThan(5);
  });
});

describe('POST /api/ingest/sessions', () => {
  it('speichert gelieferte Ladevorgänge', async () => {
    const response = await request(app)
      .post('/api/ingest/sessions')
      .set(auth())
      .send({ sessions: [sessionPayload()] })
      .expect(200);

    expect(response.body).toMatchObject({ ok: true, received: 1, inserted: 1, updated: 0 });
    expect(chargingSessions.count()).toBe(1);
  });

  it('aktualisiert bei erneuter Sendung statt zu verdoppeln', async () => {
    await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: [sessionPayload()] }).expect(200);

    // Genau der Fall nach einem Verbindungsabbruch: der Connector sendet erneut.
    const second = await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: [sessionPayload({ energy: 25.0 })] }).expect(200);

    expect(second.body).toMatchObject({ inserted: 0, updated: 1 });
    expect(chargingSessions.count()).toBe(1);

    const stored = chargingSessions.findInRange(new Date('2026-03-01'), new Date('2026-04-01'));
    expect(stored[0].energyKwh).toBe(25.0);
  });

  it('normalisiert die Rohdaten der Wallbox', async () => {
    await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: [sessionPayload({ energy: 12250, energyUnit: 'Wh', idTag: 'AA-BB-CC-DD' })] })
      .expect(200);

    const stored = chargingSessions.findInRange(new Date('2026-03-01'), new Date('2026-04-01'));
    expect(stored[0].energyKwh).toBe(12.25);
    expect(stored[0].rfid).toBe('aabbccdd');
  });

  it('nimmt mehrere Vorgänge in einer Sendung an', async () => {
    const response = await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: fixtures.sessionsMarch2026.transactions })
      .expect(200);

    // Zwei Datensätze der Fixtures sind bewusst unbrauchbar.
    expect(response.body.inserted).toBe(5);
    expect(response.body.rejected.length).toBe(1);
  });

  it('meldet unbrauchbare Datensätze einzeln zurück', async () => {
    const response = await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: [sessionPayload(), { id: 'kaputt', energy: 5 }] })
      .expect(200);

    expect(response.body.inserted).toBe(1);
    expect(response.body.rejected).toEqual([{ id: 'kaputt', reason: 'nicht auswertbar' }]);
  });

  it('lehnt unplausible Energiemengen ab', async () => {
    // Eine Heim-Wallbox liefert keine 5000 kWh in einem Vorgang - das wäre ein
    // Einheitenfehler und würde die Abrechnung sprengen.
    const response = await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: [sessionPayload({ energy: 5000 })] })
      .expect(200);

    expect(response.body.inserted).toBe(0);
    expect(response.body.rejected[0].reason).toMatch(/unplausible/);
  });

  it('lehnt ein Ende vor dem Beginn ab', async () => {
    const response = await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: [sessionPayload({ endTime: '2026-03-05T05:00:00.000Z' })] })
      .expect(200);

    expect(response.body.rejected[0].reason).toMatch(/Ende vor Beginn/);
  });

  it('weist eine Sendung ohne Liste ab', async () => {
    await request(app).post('/api/ingest/sessions').set(auth()).send({}).expect(400);
    await request(app).post('/api/ingest/sessions').set(auth()).send({ sessions: 'text' }).expect(400);
  });

  it('begrenzt die Paketgröße', async () => {
    const tooMany = Array.from({ length: config.connector.maxSessionsPerRequest + 1 },
      (unused, i) => sessionPayload({ id: `tx-${i}` }));

    const response = await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: tooMany })
      .expect(400);

    expect(response.body.message).toMatch(/kleineren Paketen/);
  });

  it('zählt gelieferte Vorgänge im Connector-Zustand mit', async () => {
    await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: [sessionPayload(), sessionPayload({ id: 'tx-2002' })] }).expect(200);

    expect(connectorState.health().sessionsReceived).toBe(2);
  });

  it('bewahrt den Rohdatensatz für die Nachvollziehbarkeit', async () => {
    await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: [sessionPayload({ herstellerFeld: 'irgendwas' })] }).expect(200);

    const row = require('../src/db').db()
      .prepare('SELECT payload FROM charging_sessions WHERE id = ?').get('tx-2001');

    expect(JSON.parse(row.payload).herstellerFeld).toBe('irgendwas');
  });
});

describe('GET /api/ingest/health', () => {
  it('bestätigt Erreichbarkeit und nennt die Paketgrenze', async () => {
    const response = await request(app).get('/api/ingest/health').set(auth()).expect(200);

    expect(response.body).toMatchObject({
      ok: true,
      mode: 'connector',
      storedSessions: 0,
      maxSessionsPerRequest: config.connector.maxSessionsPerRequest,
    });
  });
});

describe('Abrechnung im Connector-Betrieb', () => {
  it('rechnet aus den gelieferten Daten ab, ohne die Wallbox zu fragen', async () => {
    await createUser({ username: 'testadmin', password: PASSWORD, role: 'admin' });
    settingsStore.save({
      billing: { pricePerKwh: 0.3, timezone: 'Europe/Berlin', currency: 'EUR', locale: 'de-DE' },
      rfidMappings: fixtures.rfidMappings,
    });

    await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: fixtures.sessionsMarch2026.transactions }).expect(200);

    const admin = await login(request, app, { username: 'testadmin', password: PASSWORD });
    const response = await admin.agent.get('/api/report?year=2026&month=3').expect(200);

    // Dieselben Summen wie im direkten Betrieb.
    expect(response.body.totals.sessionCount).toBe(4);
    expect(response.body.totals.energyKwh).toBe(76.125);
    expect(response.body.groups).toHaveLength(3);
  });

  it('meldet den Connector-Zustand im Health-Endpunkt', async () => {
    await createUser({ username: 'testadmin', password: PASSWORD, role: 'admin' });
    await request(app).post('/api/ingest/status').set(auth())
      .send({ status: fixtures.statusCharging }).expect(200);

    const admin = await login(request, app, { username: 'testadmin', password: PASSWORD });
    const response = await admin.agent.get('/api/health').expect(200);

    expect(response.body.dataSource.mode).toBe('connector');
    expect(response.body.dataSource.connected).toBe(true);
  });

  it('meldet 503, solange sich der Connector nie gemeldet hat', async () => {
    await createUser({ username: 'testadmin', password: PASSWORD, role: 'admin' });
    const admin = await login(request, app, { username: 'testadmin', password: PASSWORD });

    const response = await admin.agent.get('/api/health').expect(503);

    expect(response.body.dataSource.connected).toBe(false);
    expect(response.body.dataSource.lastSeenAt).toBeNull();
  });

  it('liefert 503 beim Live-Status, bevor Daten eingetroffen sind', async () => {
    await createUser({ username: 'testadmin', password: PASSWORD, role: 'admin' });
    const admin = await login(request, app, { username: 'testadmin', password: PASSWORD });

    const response = await admin.agent.get('/api/status').expect(503);
    expect(response.body.error).toBe('connector_no_data');
  });

  it('liefert danach den zuletzt gelieferten Zustand', async () => {
    await createUser({ username: 'testadmin', password: PASSWORD, role: 'admin' });
    await request(app).post('/api/ingest/status').set(auth())
      .send({ status: fixtures.statusCharging }).expect(200);

    const admin = await login(request, app, { username: 'testadmin', password: PASSWORD });
    const response = await admin.agent.get('/api/status').expect(200);

    expect(response.body.powerKw).toBe(11.04);
    expect(response.body.viaConnector).toBe(true);
  });

  it('fragt die Wallbox auch beim Report-Lauf nicht an', async () => {
    await createUser({ username: 'testadmin', password: PASSWORD, role: 'admin' });
    await request(app).post('/api/ingest/sessions').set(auth())
      .send({ sessions: [sessionPayload()] }).expect(200);

    const admin = await login(request, app, { username: 'testadmin', password: PASSWORD });
    const response = await admin.agent
      .post('/api/report/run')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ year: 2026, month: 3, sendMail: false })
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.totals.sessionCount).toBe(1);
  });
});

describe('sessionSource', () => {
  it('erkennt die Betriebsart', () => {
    expect(sessionSource.isConnectorMode()).toBe(true);

    config.connector.mode = 'direct';
    expect(sessionSource.isConnectorMode()).toBe(false);
  });

  it('verlangt im direkten Betrieb einen Client', async () => {
    config.connector.mode = 'direct';

    await expect(sessionSource.getSessions({ from: new Date(), to: new Date() }))
      .rejects.toThrow('Wallbox-Client');
  });
});
