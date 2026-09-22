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
  it('legt Firma und Fahrzeug an und verknüpft sie', async () => {
    const company = await admin.agent
      .post('/api/fleet/companies')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ name: 'Klaiber GmbH', contactEmail: 'buchhaltung@example.net', pricePerKwh: '0,42' })
      .expect(201);

    // Deutsches Dezimalkomma muss durchgehen - sonst scheitert jede Eingabe
    // aus dem Formular an einem Punkt, den niemand tippt.
    expect(company.body.company.pricePerKwh).toBe(0.42);

    const vehicle = await admin.agent
      .post('/api/fleet/vehicles')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        plate: 'TUT-MK-100',
        companyId: company.body.company.id,
        employeeName: 'Moritz',
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
    expect(response.body.cards.filter((card) => !card.assigned)).toHaveLength(0);
  });

  it('lässt die Rückwirkung weg, wenn sie nicht angefordert wurde', async () => {
    const vehicle = fleet.createVehicle({ plate: 'TUT-MK-100' });

    const response = await admin.agent
      .post('/api/fleet/cards/zzzz9999/assign')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ vehicleId: vehicle.id })
      .expect(200);

    expect(response.body.backfilled).toBe(0);
    // Die Karte haengt jetzt am Fahrzeug, ihr alter Ladevorgang aber nicht -
    // er bleibt als offener Posten sichtbar.
    const karte = response.body.cards.find((c) => c.rfid === 'zzzz9999');
    expect(karte.assigned).toBe(true);
    expect(karte.openSessionCount).toBe(1);
  });

  it('meldet ein unbekanntes Fahrzeug als 404 statt still zu scheitern', async () => {
    await admin.agent
      .post('/api/fleet/cards/zzzz9999/assign')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ vehicleId: 9999, backfill: true })
      .expect(404);
  });

  it('zeigt die Karte mitsamt Aktivität auf der Seite an', async () => {
    const page = await admin.agent.get('/fuhrpark').expect(200);

    expect(page.text).toContain('zzzz9999');
    expect(page.text).toContain('Ladekarten');
    expect(page.text).toContain('ohne Fahrzeug');
  });

  it('führt bekannte und bisher nur gesehene Karten in EINER Liste', async () => {
    // Frueher standen sie an zwei Orten: bekannte in den Einstellungen,
    // unbekannte im Fuhrpark. Wer eine Karte umbuchen wollte, musste die
    // Seite wechseln.
    const vehicle = fleet.createVehicle({ plate: 'TUT-MK-100' });
    fleet.assignCardToVehicle('aaaa1111', vehicle.id);

    const response = await admin.agent.get('/api/fleet').expect(200);
    const rfids = response.body.cards.map((card) => card.rfid).sort();

    expect(rfids).toEqual(['aaaa1111', 'zzzz9999']);
    // Nicht zugeordnete zuerst: sie brauchen eine Entscheidung.
    expect(response.body.cards[0].rfid).toBe('zzzz9999');
  });

  it('schaltet die Abrechenbarkeit einer Karte', async () => {
    const response = await admin.agent
      .put('/api/fleet/cards/zzzz9999')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ billable: false })
      .expect(200);

    const karte = response.body.cards.find((c) => c.rfid === 'zzzz9999');
    expect(karte.billable).toBe(false);
  });
});

describe('Dialoge im Markup', () => {
  // Der erste Anlauf baute die Dialoge in JavaScript zusammen und erfand dabei
  // Klassennamen, die es im Stylesheet nicht gibt. Sie oeffneten sich, die
  // Daten liefen korrekt durch - nur sah man ein durchsichtiges Formular ohne
  // Hintergrund quer ueber der Seite. Kein Test schlug fehl, weil keiner
  // hinsah. Diese Zusicherungen fangen den Rueckfall ab.
  const COMPONENT_CLASSES = [
    'md-dialog__panel',   // ohne dies ist der Dialog durchsichtig
    'md-dialog__title',
    'md-field__input',
    'md-field__select',
    'md-field__textarea',
    'md-field__label',
    'md-switch__track',
  ];

  it('benutzt ausschließlich vorhandene Komponentenklassen', async () => {
    const page = await admin.agent.get('/fuhrpark').expect(200);

    COMPONENT_CLASSES.forEach((className) => {
      expect(page.text).toContain(className);
    });

    // Klassen, die es nie gab - ein Tippfehler faellt sonst nur visuell auf.
    expect(page.text).not.toMatch(/class="[^"]*\bmd-input\b/);
    expect(page.text).not.toMatch(/class="[^"]*\bmd-select\b/);
  });

  it('liefert für Fahrzeug und Firma je einen Dialog mit Panel', async () => {
    const page = await admin.agent.get('/fuhrpark').expect(200);

    ['vehicle', 'company'].forEach((type) => {
      expect(page.text).toContain(`id="${type}-dialog"`);
      expect(page.text).toContain(`id="${type}-dialog-error"`);
      expect(page.text).toContain(`id="${type}-dialog-title"`);
    });

    // Der Mitarbeiterstamm ist absichtlich entfallen: fuer einen Haushalt
    // mit ein paar Dienstwagen ist er Ballast, der Name steht am Auto.
    expect(page.text).not.toContain('id="employee-dialog"');

    // Je Dialog ein Panel - gezaehlt wird im Abschnitt des jeweiligen
    // Dialogs, nicht auf der ganzen Seite: foot.ejs bringt einen eigenen
    // Bestaetigungsdialog mit, der ebenfalls ein Panel hat.
    ['vehicle', 'company'].forEach((type) => {
      const start = page.text.indexOf(`id="${type}-dialog"`);
      const block = page.text.slice(start, page.text.indexOf('</dialog>', start));
      expect(block).toContain('md-dialog__panel');
    });
  });

  it('versteckt die Fehlerleiste über die Klasse, nicht über das Attribut', async () => {
    // .hidden traegt !important; ein hidden-Attribut wuerde von
    // .md-banner { display:flex } ueberstimmt und die leere rote Leiste
    // bliebe dauerhaft sichtbar.
    const page = await admin.agent.get('/fuhrpark').expect(200);

    expect(page.text).toMatch(/md-banner md-banner--error hidden/);
    expect(page.text).not.toMatch(/md-banner--error"[^>]*\shidden(\s|>)/);
  });
});

describe('Beziehung Firma – Fahrzeug', () => {
  it('kennzeichnet eine Firma ohne Fahrzeug', async () => {
    await admin.agent
      .post('/api/fleet/companies')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ name: 'Ohne Auto GmbH' })
      .expect(201);

    const page = await admin.agent.get('/fuhrpark').expect(200);
    expect(page.text).toContain('keine Fahrzeuge');
  });

  it('lässt den Hinweis weg, sobald die Firma ein Fahrzeug hat', async () => {
    const company = await admin.agent
      .post('/api/fleet/companies')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ name: 'Mit Auto GmbH' })
      .expect(201);

    await admin.agent
      .post('/api/fleet/vehicles')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ plate: 'TUT-AA-1', companyId: company.body.company.id, employeeName: 'Moritz' })
      .expect(201);

    const page = await admin.agent.get('/fuhrpark').expect(200);
    const row = page.text.slice(page.text.indexOf('Mit Auto GmbH'));
    expect(row.slice(0, row.indexOf('</tr>'))).not.toContain('keine Fahrzeuge');
  });

  it('ordnet ein Fahrzeug genau einer Firma zu oder keiner', async () => {
    const response = await admin.agent
      .post('/api/fleet/vehicles')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ plate: 'TUT-PRIV-1' })
      .expect(201);

    // Ohne Firma ist das Auto privat - das Modell kennt keinen dritten Fall.
    expect(response.body.vehicle.companyId).toBeNull();
    expect(response.body.vehicle.companyName).toBe('');
    expect(response.body.vehicle.isPrivate).toBe(true);
  });
});

describe('Ungültige Verweise', () => {
  it('weist eine nicht existierende Firma mit 400 ab, statt mit 500 zu scheitern', async () => {
    const response = await admin.agent
      .post('/api/fleet/vehicles')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ plate: 'TUT-XX-1', companyId: 9999 })
      .expect(400);

    expect(response.body.message).toMatch(/keine Firma mit der ID 9999/);
  });

  it('nimmt eine leere Firma als "privat" an, nicht als Fehler', async () => {
    const response = await admin.agent
      .post('/api/fleet/vehicles')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ plate: 'TUT-XX-2', companyId: '' })
      .expect(201);

    expect(response.body.vehicle.isPrivate).toBe(true);
  });

  it('weist auch beim Bearbeiten eine erfundene Firma ab', async () => {
    const created = await admin.agent
      .post('/api/fleet/vehicles')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ plate: 'TUT-XX-3' })
      .expect(201);

    await admin.agent
      .put(`/api/fleet/vehicles/${created.body.vehicle.id}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ companyId: 4242 })
      .expect(400);
  });
});
