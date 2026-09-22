'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const LiveFeed = require('../src/services/liveFeed');
const fleet = require('../src/repositories/fleetRepository');
const database = require('../src/db');
const { resetDatabase, createUser, login } = require('./helpers/testDb');

const CREDENTIALS = { user: 'testadmin', pass: 'test-passwort-1234' };

let app;
let admin;
let viewer;

beforeEach(async () => {
  resetDatabase();
  await createUser({ username: CREDENTIALS.user, password: CREDENTIALS.pass, role: 'admin' });
  await createUser({ username: 'gast', password: CREDENTIALS.pass, role: 'viewer' });

  const liveFeed = new LiveFeed({ client: null, pollIntervalMs: 60000, pushOnly: true });
  ({ app } = createApp({ mennekesClient: null, liveFeed }));

  admin = await login(request, app, CREDENTIALS);
  viewer = await login(request, app, { username: 'gast', password: CREDENTIALS.pass });
});

describe('Zugriff', () => {
  it('ist nur für Administratoren erreichbar', async () => {
    await viewer.agent.get('/fuhrpark').expect(403);
    await admin.agent.get('/fuhrpark').expect(200);
  });

  it('weist einen Betrachter auch bei schreibenden Aufrufen ab', async () => {
    await viewer.agent
      .post('/api/fleet/companies')
      .set('X-CSRF-Token', viewer.csrfToken)
      .send({ name: 'Heimlich GmbH' })
      .expect(403);
  });
});

describe('Stammdaten über die API', () => {
  it('legt Firma, Mitarbeiter und Fahrzeug an und verknüpft sie', async () => {
    const company = await admin.agent
      .post('/api/fleet/companies')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ name: 'Klaiber GmbH', contactEmail: 'buchhaltung@example.net', pricePerKwh: '0,42' })
      .expect(201);

    // Deutsches Dezimalkomma muss durchgehen - sonst scheitert jede Eingabe
    // aus dem Formular an einem Punkt, den niemand tippt.
    expect(company.body.company.pricePerKwh).toBe(0.42);

    const employee = await admin.agent
      .post('/api/fleet/employees')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ name: 'Moritz', companyId: company.body.company.id, personnelNo: '042' })
      .expect(201);

    const vehicle = await admin.agent
      .post('/api/fleet/vehicles')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        plate: 'TUT-MK-100',
        companyId: company.body.company.id,
        employeeId: employee.body.employee.id,
      })
      .expect(201);

    expect(vehicle.body.vehicle).toMatchObject({
      plate: 'TUT-MK-100', companyName: 'Klaiber GmbH', employeeName: 'Moritz',
    });
  });

  it('lehnt ein Fahrzeug ohne Kennzeichen ab', async () => {
    const response = await admin.agent
      .post('/api/fleet/vehicles')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ label: 'Namenlos' })
      .expect(400);

    expect(response.body.message).toMatch(/Kennzeichen/);
  });

  it('unterscheidet leeren Arbeitspreis von null', async () => {
    const response = await admin.agent
      .post('/api/fleet/companies')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ name: 'Ohne Preis', pricePerKwh: '' })
      .expect(201);

    expect(response.body.company.pricePerKwh).toBeNull();
  });
});

describe('Kartenzuordnung über die API', () => {
  beforeEach(() => {
    database.db().prepare(`
      INSERT INTO charging_sessions (id, start_at, end_at, duration_seconds, energy_kwh, rfid, rfid_raw, source, received_at)
      VALUES ('s1', '2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z', 3600, 12, 'zzzz9999', 'ZZ', 'connector', '2026-08-01T11:00:00Z')
    `).run();
  });

  it('ordnet eine Karte zu und übernimmt auf Wunsch rückwirkend', async () => {
    const vehicle = fleet.createVehicle({ plate: 'TUT-MK-100' });

    const response = await admin.agent
      .post('/api/fleet/cards/zzzz9999/assign')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ vehicleId: vehicle.id, backfill: true })
      .expect(200);

    expect(response.body.backfilled).toBe(1);
    expect(response.body.unassignedCards).toHaveLength(0);
  });

  it('lässt die Rückwirkung weg, wenn sie nicht angefordert wurde', async () => {
    const vehicle = fleet.createVehicle({ plate: 'TUT-MK-100' });

    const response = await admin.agent
      .post('/api/fleet/cards/zzzz9999/assign')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ vehicleId: vehicle.id })
      .expect(200);

    expect(response.body.backfilled).toBe(0);
    // Der Ladevorgang bleibt in der Arbeitsliste sichtbar.
    expect(response.body.unassignedCards).toHaveLength(1);
  });

  it('meldet ein unbekanntes Fahrzeug als 404 statt still zu scheitern', async () => {
    await admin.agent
      .post('/api/fleet/cards/zzzz9999/assign')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ vehicleId: 9999, backfill: true })
      .expect(404);
  });

  it('zeigt die nicht zugeordnete Karte auf der Seite an', async () => {
    const page = await admin.agent.get('/fuhrpark').expect(200);

    expect(page.text).toContain('zzzz9999');
    expect(page.text).toContain('Nicht zugeordnete Karten');
  });
});
