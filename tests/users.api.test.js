'use strict';

// Puppeteer mocken - diese Suite fasst die Report-Routen nicht an, aber die
// App lädt den pdfService beim Start.
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
const { createApp } = require('../src/app');
const users = require('../src/repositories/userRepository');
const sessions = require('../src/repositories/sessionRepository');
const audit = require('../src/repositories/auditRepository');
const MennekesClient = require('../src/services/mennekesClient');
const LiveFeed = require('../src/services/liveFeed');
const { resetDatabase, createUser, login } = require('./helpers/testDb');

const PASSWORD = 'test-passwort-1234';

let app;
let liveFeed;
let admin;

beforeEach(async () => {
  resetDatabase();
  await createUser({ username: 'testadmin', password: PASSWORD, role: 'admin' });

  const client = {
    getLiveStatus: jest.fn(async () => MennekesClient.normalizeStatus({ status: 'A' })),
    getChargingSessions: jest.fn(async () => []),
    ping: jest.fn(async () => ({ reachable: true })),
  };
  liveFeed = new LiveFeed({ client, pollIntervalMs: 60000 });
  ({ app } = createApp({ mennekesClient: client, liveFeed }));

  admin = await login(request, app, { username: 'testadmin', password: PASSWORD });
});

afterEach(() => {
  if (liveFeed) liveFeed.shutdown();
});

describe('GET /benutzer', () => {
  it('listet die Konten', async () => {
    await createUser({ username: 'betrachter', password: PASSWORD, role: 'viewer' });

    const response = await admin.agent.get('/benutzer').expect(200);

    expect(response.text).toContain('testadmin');
    expect(response.text).toContain('betrachter');
    expect(response.text).toContain('Administrator');
    expect(response.text).toContain('Betrachter');
  });

  it('zeigt das Protokoll', async () => {
    const response = await admin.agent.get('/benutzer').expect(200);
    expect(response.text).toContain('login.success');
  });
});

describe('POST /api/users', () => {
  it('legt ein Konto mit erzeugtem Passwort an', async () => {
    const response = await admin.agent
      .post('/api/users')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ username: 'neuer', role: 'viewer' })
      .expect(201);

    expect(response.body.user).toMatchObject({ username: 'neuer', role: 'viewer' });
    // Das Startpasswort wird genau einmal zurückgegeben.
    expect(response.body.generatedPassword).toMatch(/^[A-Za-z0-9_-]+-[A-Za-z0-9_-]+$/);
    expect(response.body.user.mustChangePassword).toBe(true);

    expect((await users.authenticate('neuer', response.body.generatedPassword)).ok).toBe(true);
  });

  it('übernimmt ein vorgegebenes Passwort', async () => {
    const response = await admin.agent
      .post('/api/users')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ username: 'neuer', password: 'eigenes-passwort-123' })
      .expect(201);

    expect(response.body.generatedPassword).toBeNull();
    expect((await users.authenticate('neuer', 'eigenes-passwort-123')).ok).toBe(true);
  });

  it('weist doppelte Benutzernamen ab', async () => {
    const response = await admin.agent
      .post('/api/users')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ username: 'testadmin' })
      .expect(409);

    expect(response.body.message).toContain('bereits vergeben');
  });

  it('protokolliert das Anlegen', async () => {
    await admin.agent.post('/api/users').set('X-CSRF-Token', admin.csrfToken)
      .send({ username: 'neuer' }).expect(201);

    const entries = audit.list({ action: 'user.created' });
    expect(entries[0].detail).toContain('neuer');
    expect(entries[0].username).toBe('testadmin');
  });
});

describe('PUT /api/users/:id', () => {
  it('ändert Rolle und Anzeigename', async () => {
    const user = await createUser({ username: 'anna', password: PASSWORD, role: 'viewer' });

    const response = await admin.agent
      .put(`/api/users/${user.id}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ role: 'admin', displayName: 'Anna A.' })
      .expect(200);

    expect(response.body.user).toMatchObject({ role: 'admin', displayName: 'Anna A.' });
  });

  it('verhindert, dass ein Administrator sich selbst herabstuft', async () => {
    const me = users.findByUsername('testadmin');

    const response = await admin.agent
      .put(`/api/users/${me.id}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ role: 'viewer' })
      .expect(409);

    expect(response.body.message).toContain('eigene Administratorrolle');
    expect(users.findById(me.id).role).toBe('admin');
  });

  it('verhindert die Selbst-Deaktivierung', async () => {
    const me = users.findByUsername('testadmin');

    await admin.agent
      .put(`/api/users/${me.id}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ isActive: false })
      .expect(409);
  });

  it('weist eine ungültige ID ab', async () => {
    await admin.agent.put('/api/users/keine-zahl')
      .set('X-CSRF-Token', admin.csrfToken).send({ role: 'viewer' }).expect(400);
  });
});

describe('POST /api/users/:id/password', () => {
  it('setzt ein neues Passwort und gibt es einmalig zurück', async () => {
    const user = await createUser({ username: 'anna', password: PASSWORD, role: 'viewer' });

    const response = await admin.agent
      .post(`/api/users/${user.id}/password`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({})
      .expect(200);

    expect(response.body.generatedPassword).toBeTruthy();
    expect((await users.authenticate('anna', response.body.generatedPassword)).ok).toBe(true);
    expect((await users.authenticate('anna', PASSWORD)).ok).toBe(false);
  });

  it('erzwingt danach einen Passwortwechsel', async () => {
    const user = await createUser({ username: 'anna', password: PASSWORD, role: 'viewer' });

    const response = await admin.agent
      .post(`/api/users/${user.id}/password`)
      .set('X-CSRF-Token', admin.csrfToken).send({}).expect(200);

    expect(response.body.user.mustChangePassword).toBe(true);
  });
});

describe('DELETE /api/users/:id', () => {
  it('löscht ein fremdes Konto', async () => {
    const user = await createUser({ username: 'anna', password: PASSWORD, role: 'viewer' });

    await admin.agent.delete(`/api/users/${user.id}`)
      .set('X-CSRF-Token', admin.csrfToken).expect(200);

    expect(users.findById(user.id)).toBeNull();
  });

  it('verhindert das Löschen des eigenen Kontos', async () => {
    const me = users.findByUsername('testadmin');

    const response = await admin.agent.delete(`/api/users/${me.id}`)
      .set('X-CSRF-Token', admin.csrfToken).expect(409);

    expect(response.body.message).toContain('eigene Konto');
  });
});

describe('POST /api/users/:id/logout-all', () => {
  it('beendet alle Sitzungen eines Kontos', async () => {
    const user = await createUser({ username: 'anna', password: PASSWORD, role: 'viewer' });
    sessions.create({ userId: user.id });
    sessions.create({ userId: user.id });

    const response = await admin.agent
      .post(`/api/users/${user.id}/logout-all`)
      .set('X-CSRF-Token', admin.csrfToken).expect(200);

    expect(response.body.closed).toBe(2);
    expect(sessions.listForUser(user.id)).toHaveLength(0);
  });
});

describe('Passwortwechsel durch den Benutzer', () => {
  it('ändert das eigene Passwort', async () => {
    const response = await admin.agent
      .post('/passwort').type('form')
      .send({
        _csrf: admin.csrfToken,
        currentPassword: PASSWORD,
        newPassword: 'mein-neues-passwort',
        repeatPassword: 'mein-neues-passwort',
      })
      .expect(200);

    expect(response.text).toContain('Passwort geändert');
    expect((await users.authenticate('testadmin', 'mein-neues-passwort')).ok).toBe(true);
  });

  it('verlangt das aktuelle Passwort', async () => {
    const response = await admin.agent
      .post('/passwort').type('form')
      .send({
        _csrf: admin.csrfToken,
        currentPassword: 'falsch',
        newPassword: 'mein-neues-passwort',
        repeatPassword: 'mein-neues-passwort',
      })
      .expect(400);

    expect(response.text).toContain('aktuelle Passwort ist falsch');
  });

  it('prüft, dass beide Eingaben übereinstimmen', async () => {
    const response = await admin.agent
      .post('/passwort').type('form')
      .send({
        _csrf: admin.csrfToken,
        currentPassword: PASSWORD,
        newPassword: 'mein-neues-passwort',
        repeatPassword: 'etwas-anderes-123',
      })
      .expect(400);

    expect(response.text).toContain('stimmen nicht überein');
  });

  it('lehnt das bisherige Passwort als neues ab', async () => {
    const response = await admin.agent
      .post('/passwort').type('form')
      .send({
        _csrf: admin.csrfToken,
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
        repeatPassword: PASSWORD,
      })
      .expect(400);

    expect(response.text).toContain('unterscheiden');
  });

  it('erzwingt die Mindestlänge', async () => {
    const response = await admin.agent
      .post('/passwort').type('form')
      .send({
        _csrf: admin.csrfToken,
        currentPassword: PASSWORD,
        newPassword: 'kurz',
        repeatPassword: 'kurz',
      })
      .expect(400);

    expect(response.text).toContain('mindestens');
  });

  it('beendet andere Sitzungen, behält aber die eigene', async () => {
    const me = users.findByUsername('testadmin');
    sessions.create({ userId: me.id });   // zweites "Gerät"
    expect(sessions.listForUser(me.id).length).toBeGreaterThanOrEqual(2);

    await admin.agent.post('/passwort').type('form').send({
      _csrf: admin.csrfToken,
      currentPassword: PASSWORD,
      newPassword: 'mein-neues-passwort',
      repeatPassword: 'mein-neues-passwort',
    }).expect(200);

    // Genau eine Sitzung bleibt: die, mit der gerade gearbeitet wird.
    expect(sessions.listForUser(me.id)).toHaveLength(1);
    await admin.agent.get('/').expect(200);
  });
});
