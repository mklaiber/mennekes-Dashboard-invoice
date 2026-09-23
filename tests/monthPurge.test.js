'use strict';

jest.mock('puppeteer', () => ({ launch: jest.fn(async () => ({ newPage: jest.fn(), close: jest.fn(), connected: true })) }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const config = require('../src/config');
const { createApp } = require('../src/app');
const LiveFeed = require('../src/services/liveFeed');
const monthPurge = require('../src/services/monthPurge');
const fleet = require('../src/repositories/fleetRepository');
const database = require('../src/db');
const { resetDatabase, createUser, login } = require('./helpers/testDb');

const PASSWORD = 'test-passwort-1234';
const TZ = 'Europe/Berlin';

let app;
let liveFeed;
let outputDir;
let originalOutputDir;
let period;

const insertSession = (id, startAt, kwh = 10) => database.db().prepare(`
  INSERT INTO charging_sessions (id, start_at, end_at, duration_seconds, energy_kwh, rfid, rfid_raw, source, received_at)
  VALUES (?, ?, ?, 3600, ?, '04d3a1b27c5e80', '04d3a1b27c5e80', 'connector', ?)
`).run(id, startAt, startAt, kwh, startAt);

const count = (sql, ...args) => database.db().prepare(sql).get(...args).c;

beforeEach(async () => {
  resetDatabase();
  originalOutputDir = config.server.outputDir;
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-'));
  config.server.outputDir = outputDir;

  liveFeed = new LiveFeed({ client: null, pollIntervalMs: 60000, pushOnly: true });
  ({ app } = createApp({ mennekesClient: null, liveFeed }));
  await createUser({ username: 'admin', password: PASSWORD, role: 'admin' });

  period = monthPurge.currentPeriod(TZ);

  // Laufender Monat: zwei Vorgaenge, Vormonat: einer, der ueberleben muss.
  const mitte = new Date((period.start.getTime() + period.end.getTime()) / 2).toISOString();
  insertSession('dieser-1', mitte, 0.169);
  insertSession('dieser-2', new Date(period.start.getTime() + 60_000).toISOString(), 0.051);
  insertSession('vormonat', new Date(period.start.getTime() - 60_000).toISOString(), 22.5);

  const prev = new Date(period.start.getTime() - 86_400_000);
  const prevKey = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  for (const [key, runId] of [[period.key, 1], [prevKey, 2]]) {
    database.db().prepare("INSERT INTO report_runs (id, period_key, started_at) VALUES (?, ?, '2026-01-01T00:00:00Z')").run(runId, key);
  }
  fs.writeFileSync(path.join(outputDir, `ladestrom_${period.key}_abrechnung.pdf`), '%PDF');
  fs.writeFileSync(path.join(outputDir, `ladestrom_${period.key}_firma-2-test_detail.csv`), 'x');
  fs.writeFileSync(path.join(outputDir, `ladestrom_${prevKey}_abrechnung.pdf`), '%PDF');

  fleet.createVehicle({ plate: 'TUT-MK-100' });
});

afterEach(() => {
  liveFeed.shutdown();
  config.server.outputDir = originalOutputDir;
  fs.rmSync(outputDir, { recursive: true, force: true });
});

const purge = (agent, csrfToken, body) =>
  agent.post('/api/data/current-month/purge').set('X-CSRF-Token', csrfToken).send(body);

const valid = () => ({ period: period.key, confirmation: period.label, password: PASSWORD });

describe('Vorschau', () => {
  it('zählt, was ein Löschen jetzt beträfe', async () => {
    const { agent } = await login(request, app, { username: 'admin', password: PASSWORD });
    const res = await agent.get('/api/data/current-month').expect(200);

    expect(res.body).toMatchObject({
      period: { key: period.key, label: period.label },
      sessionCount: 2,
      energyKwh: 0.22,
      reportRunCount: 1,
      fileCount: 2,
    });
  });
});

describe('Löschen des laufenden Monats', () => {
  it('löscht NUR den laufenden Monat - Vormonat und seine Dateien überleben', async () => {
    const { agent, csrfToken } = await login(request, app, { username: 'admin', password: PASSWORD });

    const res = await purge(agent, csrfToken, valid()).expect(200);

    expect(res.body).toMatchObject({ sessions: 2, reportRuns: 1, files: 2 });
    expect(count('SELECT COUNT(*) c FROM charging_sessions')).toBe(1);
    expect(database.db().prepare('SELECT id FROM charging_sessions').get().id).toBe('vormonat');
    expect(count('SELECT COUNT(*) c FROM report_runs')).toBe(1);
    expect(fs.readdirSync(outputDir)).toHaveLength(1);
    expect(fs.readdirSync(outputDir)[0]).not.toContain(period.key);
  });

  it('lässt Karten, Fahrzeuge und das Protokoll unberührt', async () => {
    const { agent, csrfToken } = await login(request, app, { username: 'admin', password: PASSWORD });
    fleet.assignCardToVehicle('04d3a1b27c5e80', fleet.listVehicles()[0].id);

    await purge(agent, csrfToken, valid()).expect(200);

    expect(fleet.listVehicles()).toHaveLength(1);
    expect(fleet.resolveAttribution('04d3a1b27c5e80').vehiclePlate).toBe('TUT-MK-100');
    // Das Protokoll ist der Nachweis, DASS geloescht wurde.
    const eintrag = database.db().prepare("SELECT detail FROM audit_log WHERE action = 'data.purged'").get();
    expect(eintrag.detail).toMatch(/2 Ladevorgänge/);
  });
});

describe('Sicherungen - jede auf dem Server, nicht nur im Dialog', () => {
  const nichtsGeloescht = () => {
    expect(count('SELECT COUNT(*) c FROM charging_sessions')).toBe(3);
    expect(fs.readdirSync(outputDir)).toHaveLength(3);
  };

  it('verweigert Betrachtern den Zugriff', async () => {
    await createUser({ username: 'gast', password: PASSWORD, role: 'viewer' });
    const { agent, csrfToken } = await login(request, app, { username: 'gast', password: PASSWORD });

    await purge(agent, csrfToken, valid()).expect(403);
    await agent.get('/api/data/current-month').expect(403);
    nichtsGeloescht();
  });

  it('verlangt das Passwort', async () => {
    const { agent, csrfToken } = await login(request, app, { username: 'admin', password: PASSWORD });
    await purge(agent, csrfToken, { ...valid(), password: '' }).expect(400);
    nichtsGeloescht();
  });

  it('weist ein falsches Passwort ab - ohne Anmeldedialog im Browser', async () => {
    const { agent, csrfToken } = await login(request, app, { username: 'admin', password: PASSWORD });

    const res = await purge(agent, csrfToken, { ...valid(), password: 'falsch-falsch-1234' });

    // 401 wuerde fuer /api/-Pfade einen WWW-Authenticate-Kopf ausloesen.
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.body.message).toMatch(/nichts gelöscht/);
    nichtsGeloescht();
    const denied = database.db().prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'data.purge.denied'").get().c;
    expect(denied).toBe(1);
  });

  it('sperrt nach zu vielen Fehlversuchen wie beim Login', async () => {
    const { agent, csrfToken } = await login(request, app, { username: 'admin', password: PASSWORD });

    let last;
    for (let i = 0; i < config.auth.maxFailedAttempts; i++) {
      last = await purge(agent, csrfToken, { ...valid(), password: `falsch-${i}-xxxxxxxx` });
    }
    expect(last.status).toBe(423);

    // Selbst mit richtigem Passwort bleibt es jetzt gesperrt.
    await purge(agent, csrfToken, valid()).expect(423);
    nichtsGeloescht();
  });

  it('verlangt den Monatsnamen wörtlich', async () => {
    const { agent, csrfToken } = await login(request, app, { username: 'admin', password: PASSWORD });

    await purge(agent, csrfToken, { ...valid(), confirmation: 'ja' }).expect(400);
    await purge(agent, csrfToken, { ...valid(), confirmation: period.label.toLowerCase() }).expect(400);
    nichtsGeloescht();
  });

  it('löscht keinen anderen Monat als den laufenden', async () => {
    // Wer am 30. um 23:59 den Dialog oeffnet und um 00:00 absendet, darf
    // nicht versehentlich den neuen Monat treffen.
    const { agent, csrfToken } = await login(request, app, { username: 'admin', password: PASSWORD });

    const res = await purge(agent, csrfToken, { ...valid(), period: '2000-01' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/gewechselt/);
    nichtsGeloescht();
  });

  it('prüft das Passwort erst NACH Monat und Bestätigung', async () => {
    // Sonst liesse sich ueber die Reihenfolge der Fehler das Passwort testen,
    // ohne die Bestaetigung zu kennen - und jeder Fehlversuch zaehlte gegen
    // die Sperre.
    const { agent, csrfToken } = await login(request, app, { username: 'admin', password: PASSWORD });
    await purge(agent, csrfToken, { period: period.key, confirmation: 'falsch', password: 'auch-falsch-123' }).expect(400);

    const versuche = database.db().prepare("SELECT failed_attempts FROM users WHERE username = 'admin'").get().failed_attempts;
    expect(versuche).toBe(0);
  });
});
