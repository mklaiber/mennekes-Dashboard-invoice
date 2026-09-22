'use strict';

// Puppeteer mocken - der manuelle Report-Lauf über die API soll kein Chromium starten.
const mockPage = {
  setContent: jest.fn(async () => undefined),
  evaluate: jest.fn(async () => undefined),
  pdf: jest.fn(async () => Buffer.from('%PDF-1.4 via-api')),
  close: jest.fn(async () => undefined),
};
jest.mock('puppeteer', () => ({
  launch: jest.fn(async () => ({
    newPage: jest.fn(async () => mockPage),
    close: jest.fn(async () => undefined),
    connected: true,
  })),
}));

const fs = require('fs');
const http = require('http');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../src/app');
const config = require('../src/config');
const settingsStore = require('../src/repositories/settingsRepository');
const { resetDatabase, createUser, login } = require('./helpers/testDb');
const users = require('../src/repositories/userRepository');
const MennekesClient = require('../src/services/mennekesClient');
const LiveFeed = require('../src/services/liveFeed');
const pdfService = require('../src/services/pdfService');
const fixtures = require('./fixtures/wallbox');

const CREDENTIALS = { user: 'testadmin', pass: 'test-passwort-1234' };

/** Basic-Auth-Header für die maschinellen Zugriffe. */
function basic(user = CREDENTIALS.user, pass = CREDENTIALS.pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/** Wallbox-Attrappe für die App. */
function fakeClient(overrides = {}) {
  return {
    getLiveStatus: jest.fn(async () => MennekesClient.normalizeStatus(fixtures.statusCharging)),
    getChargingSessions: jest.fn(async (from, to) => fixtures.sessionsMarch2026.transactions
      .map((entry) => MennekesClient.normalizeSession(entry))
      .filter(Boolean)
      .filter((session) => session.start >= from && session.start < to)),
    ping: jest.fn(async () => ({ reachable: true })),
    ...overrides,
  };
}

let app;
let liveFeed;
let mennekesClient;
/** Angemeldeter Administrator inkl. CSRF-Token - für die meisten Tests. */
let admin;

function build(clientOverrides = {}) {
  mennekesClient = fakeClient(clientOverrides);
  liveFeed = new LiveFeed({ client: mennekesClient, pollIntervalMs: 60000 });
  ({ app } = createApp({ mennekesClient, liveFeed }));
  return app;
}

beforeEach(async () => {
  jest.clearAllMocks();
  pdfService._resetCaches();
  resetDatabase();

  await createUser({ username: CREDENTIALS.user, password: CREDENTIALS.pass, role: 'admin' });

  settingsStore.save({
    billing: { pricePerKwh: 0.3, timezone: 'Europe/Berlin', currency: 'EUR', locale: 'de-DE' },
    mail: { from: 'wallbox@example.com', to: ['buchhaltung@firma.de'], cc: [] },
    rfidMappings: fixtures.rfidMappings,
  });

  build();
  admin = await login(request, app);
});

afterEach(() => {
  if (liveFeed) liveFeed.shutdown();
});

describe('Authentifizierung', () => {
  describe('ohne Anmeldung', () => {
    it.each([
      ['/', 'Dashboard'],
      ['/einstellungen', 'Einstellungen'],
      ['/benutzer', 'Benutzerverwaltung'],
      ['/passwort', 'Passwortwechsel'],
    ])('leitet %s (%s) zur Anmeldung um', async (url) => {
      const response = await request(app).get(url);

      expect(response.status).toBe(302);
      expect(response.headers.location).toMatch(/^\/login\?next=/);
    });

    it('merkt sich das Ziel für die Weiterleitung nach der Anmeldung', async () => {
      const response = await request(app).get('/einstellungen');
      expect(response.headers.location).toBe('/login?next=%2Feinstellungen');
    });

    it.each([
      ['/api/status'],
      ['/api/report'],
      ['/api/settings'],
      ['/api/users'],
    ])('antwortet auf %s mit 401 statt einer Weiterleitung', async (url) => {
      const response = await request(app).get(url);
      expect(response.status).toBe(401);
    });

    it('liefert die Login-Seite aus', async () => {
      const response = await request(app).get('/login').expect(200);
      expect(response.text).toContain('Benutzername');
      expect(response.text).toContain('name="password"');
    });

    it('gibt statische Dateien frei - die Login-Seite braucht ihr Stylesheet', async () => {
      await request(app).get('/static/css/material.css').expect(200);
    });
  });

  describe('Anmeldung', () => {
    it('setzt bei korrekten Daten ein httpOnly-Sitzungscookie', async () => {
      const response = await request(app)
        .post('/login').type('form')
        .send({ username: CREDENTIALS.user, password: CREDENTIALS.pass });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('/');

      const cookie = response.headers['set-cookie'].join(';');
      expect(cookie).toContain('wb_session=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
    });

    it('weist ein falsches Passwort ab, ohne Cookie zu setzen', async () => {
      const response = await request(app)
        .post('/login').type('form')
        .send({ username: CREDENTIALS.user, password: 'falsch' });

      expect(response.status).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.text).toContain('Benutzername oder Passwort ist falsch.');
    });

    it('nennt bei unbekanntem Konto dieselbe Meldung wie bei falschem Passwort', async () => {
      // Sonst liesse sich abfragen, welche Benutzernamen existieren.
      const response = await request(app)
        .post('/login').type('form')
        .send({ username: 'gibtesnicht', password: 'irgendwas' });

      expect(response.status).toBe(401);
      expect(response.text).toContain('Benutzername oder Passwort ist falsch.');
    });

    it('sperrt das Konto nach zu vielen Fehlversuchen', async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await request(app).post('/login').type('form')
          .send({ username: CREDENTIALS.user, password: 'falsch' });
      }

      // Auch mit dem RICHTIGEN Passwort bleibt das Konto jetzt gesperrt.
      const response = await request(app).post('/login').type('form')
        .send({ username: CREDENTIALS.user, password: CREDENTIALS.pass });

      expect(response.status).toBe(401);
      expect(response.text).toContain('vorübergehend gesperrt');
    });

    it('lässt ein deaktiviertes Konto nicht herein', async () => {
      const viewer = await createUser({ username: 'inaktiv', password: 'test-passwort-1234', role: 'viewer' });
      users.update(viewer.id, { isActive: false });

      const response = await request(app).post('/login').type('form')
        .send({ username: 'inaktiv', password: 'test-passwort-1234' });

      expect(response.status).toBe(401);
      expect(response.text).toContain('deaktiviert');
    });

    it('folgt nur pfadrelativen Weiterleitungen (kein Open Redirect)', async () => {
      const response = await request(app).post('/login').type('form')
        .send({ username: CREDENTIALS.user, password: CREDENTIALS.pass, next: 'https://boese.example/' });

      expect(response.headers.location).toBe('/');
    });
  });

  describe('Abmeldung', () => {
    it('beendet die Sitzung und löscht das Cookie', async () => {
      const response = await admin.agent.post('/logout')
        .set('X-CSRF-Token', admin.csrfToken)
        .expect(302);

      expect(response.headers['set-cookie'].join(';')).toMatch(/wb_session=;/);
      // Der Agent hält das gelöschte Cookie - der nächste Aufruf muss umleiten.
      await admin.agent.get('/').expect(302);
    });
  });

  describe('Basic-Auth für maschinelle Zugriffe', () => {
    it('erlaubt den Health-Endpunkt ohne Sitzung', async () => {
      const response = await request(app)
        .get('/api/health')
        .set('Authorization', basic())
        .expect(200);

      expect(response.body.status).toBe('ok');
    });

    it('weist falsche Zugangsdaten ab', async () => {
      await request(app).get('/api/health')
        .set('Authorization', basic('testadmin', 'falsch'))
        .expect(401);
    });

    it('gilt nicht für HTML-Seiten', async () => {
      // Dort führt Basic-Auth zwar zur Anmeldung, die Seite wird aber
      // regulär gerendert - kein Browser-Dialog, kein Sonderweg.
      const response = await request(app).get('/').set('Authorization', basic());
      expect(response.status).toBe(200);
    });
  });

  describe('Rollen', () => {
    let viewer;

    beforeEach(async () => {
      await createUser({ username: 'betrachter', password: 'test-passwort-1234', role: 'viewer' });
      viewer = await login(request, app, { username: 'betrachter', password: 'test-passwort-1234' });
    });

    it('lässt Betrachter auf das Dashboard', async () => {
      await viewer.agent.get('/').expect(200);
    });

    it('lässt Betrachter die Abrechnungsvorschau lesen', async () => {
      await viewer.agent.get('/api/report?year=2026&month=3').expect(200);
    });

    it.each([
      ['/einstellungen'],
      ['/benutzer'],
    ])('sperrt Betrachter aus %s aus', async (url) => {
      await viewer.agent.get(url).expect(403);
    });

    it('verbietet Betrachtern das Ändern der Einstellungen', async () => {
      const response = await viewer.agent
        .put('/api/settings')
        .set('X-CSRF-Token', viewer.csrfToken)
        .send({ billing: { pricePerKwh: 0.99 } });

      expect(response.status).toBe(403);
      expect(settingsStore.load({ force: true }).billing.pricePerKwh).toBe(0.3);
    });

    it('verbietet Betrachtern den manuellen Report-Lauf', async () => {
      await viewer.agent
        .post('/api/report/run')
        .set('X-CSRF-Token', viewer.csrfToken)
        .send({ year: 2026, month: 3, sendMail: false })
        .expect(403);
    });

    it('verbirgt Verwaltungs-Links in der Navigation', async () => {
      const response = await viewer.agent.get('/').expect(200);
      expect(response.text).not.toContain('href="/einstellungen"');
      expect(response.text).not.toContain('href="/benutzer"');
    });
  });

  describe('CSRF-Schutz', () => {
    it('weist schreibende Anfragen ohne Token ab', async () => {
      const response = await admin.agent
        .put('/api/settings')
        .send({ billing: { pricePerKwh: 0.99 } });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('csrf_failed');
    });

    it('weist ein falsches Token ab', async () => {
      await admin.agent
        .put('/api/settings')
        .set('X-CSRF-Token', 'komplett-falsches-token')
        .send({ billing: { pricePerKwh: 0.99 } })
        .expect(403);
    });

    it('lässt lesende Anfragen ohne Token durch', async () => {
      await admin.agent.get('/api/settings').expect(200);
    });

    it('greift nicht bei Basic-Auth - ohne Cookie gibt es kein CSRF-Risiko', async () => {
      await request(app)
        .put('/api/settings')
        .set('Authorization', basic())
        .send({ wallbox: { displayName: 'Per Skript' } })
        .expect(200);

      expect(settingsStore.load({ force: true }).wallbox.displayName).toBe('Per Skript');
    });
  });

  describe('Erzwungener Passwortwechsel', () => {
    it('leitet auf die Passwortseite um und sperrt den Rest', async () => {
      await createUser({
        username: 'neuling', password: 'test-passwort-1234',
        role: 'admin', mustChangePassword: true,
      });
      const fresh = await login(request, app, {
        username: 'neuling', password: 'test-passwort-1234', tokenFrom: '/passwort',
      });

      const dashboard = await fresh.agent.get('/');
      expect(dashboard.status).toBe(302);
      expect(dashboard.headers.location).toBe('/passwort');

      // Die Passwortseite selbst bleibt erreichbar.
      await fresh.agent.get('/passwort').expect(200);
    });
  });
});

describe('Sicherheits-Header', () => {
  it('setzt die Helmet-Header', async () => {
    const response = await admin.agent.get('/');

    expect(response.headers['content-security-policy']).toBeDefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('erlaubt in der CSP keine fremden Skript-Hosts', async () => {
    const response = await admin.agent.get('/');
    const csp = response.headers['content-security-policy'];

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // Inline-Skripte nur über Nonce, nicht pauschal.
    expect(csp).toMatch(/script-src[^;]*'nonce-/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    // Das Material-Stylesheet liegt lokal - kein CDN mehr im script-src.
    expect(csp).not.toContain('cdn.tailwindcss.com');
  });
});

describe('WebUI', () => {
  it('rendert das Dashboard', async () => {
    const response = await admin.agent.get('/').expect(200);

    expect(response.text).toContain('Live-Übersicht');
    expect(response.text).toContain('Aktuelle Ladeleistung');
    expect(response.text).toContain('/static/js/dashboard.js');
  });

  it('rendert die Einstellungen mit den gespeicherten Werten', async () => {
    const response = await admin.agent.get('/einstellungen').expect(200);

    // Die Kartenverwaltung ist in den Fuhrpark umgezogen - eine Karte gehoert
    // zu einem Fahrzeug, und dort steht sie jetzt auch. Ebenso Arbeitgeber,
    // Kennzeichen und Fahrer: global gaebe es sie nur einmal.
    expect(response.text).not.toContain('RFID-Zuordnung');
    expect(response.text).not.toContain('billing-vehiclePlate');
    expect(response.text).not.toContain('wallbox-baseUrl');
    expect(response.text).toContain('/fuhrpark');
    expect(response.text).toContain('buchhaltung@firma.de');
    expect(response.text).toContain('Europe/Berlin');
  });

  it('liefert eine 404-Seite für unbekannte Pfade', async () => {
    const response = await admin.agent.get('/gibt-es-nicht').expect(404);
    expect(response.text).toContain('Diese Seite existiert nicht.');
  });

  it('antwortet bei unbekannten API-Pfaden mit JSON', async () => {
    const response = await admin.agent.get('/api/gibt-es-nicht').expect(404);
    expect(response.body.error).toBe('not_found');
  });
});

describe('GET /api/status', () => {
  it('liefert den normalisierten Zustand', async () => {
    const response = await admin.agent.get('/api/status').expect(200);

    expect(response.body).toMatchObject({
      status: 'charging', statusLabel: 'Lädt', powerKw: 11.04, rfid: '04a1b2c3',
    });
  });

  it('löst den RFID-Namen aus dem Mapping auf', async () => {
    const response = await admin.agent.get('/api/status').expect(200);
    expect(response.body.rfidName).toBe('Max Mustermann');
  });

  it('meldet einen Wallbox-Ausfall als 500 mit Meldung', async () => {
    build({ getLiveStatus: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    // build() erzeugt eine neue App-Instanz; der Agent muss darauf zeigen.
    const session = await login(request, app);

    const response = await session.agent.get('/api/status').expect(500);
    expect(response.body.error).toBe('internal_error');
  });
});

describe('GET /api/report', () => {
  it('liefert den Report für den angefragten Monat', async () => {
    const response = await admin.agent
      .get('/api/report?year=2026&month=3')
      .expect(200);

    expect(response.body.period.key).toBe('2026-03');
    expect(response.body.totals.energyKwh).toBe(76.125);
    expect(response.body.groups).toHaveLength(3);
  });

  it('nutzt ohne Parameter den Vormonat', async () => {
    const response = await admin.agent.get('/api/report').expect(200);
    expect(response.body.period.key).toMatch(/^\d{4}-\d{2}$/);
  });

  it.each([
    ['?year=1999&month=3', 'Jahr zu klein'],
    ['?year=2026&month=13', 'Monat zu gross'],
    ['?year=2026&month=0', 'Monat zu klein'],
    ['?year=abc&month=3', 'Jahr keine Zahl'],
  ])('weist ungültige Parameter zurück: %s (%s)', async (query) => {
    const response = await admin.agent
      .get(`/api/report${query}`)
      .expect(400);

    expect(response.body.error).toBe('bad_request');
  });
});

describe('POST /api/report/run', () => {
  it('erzeugt Dateien ohne Versand', async () => {
    const response = await admin.agent
      .post('/api/report/run')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ year: 2026, month: 3, sendMail: false })
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.files.pdf).toBe('ladestrom_2026-03_abrechnung.pdf');
    expect(response.body.mail).toBeNull();
    expect(fs.existsSync(path.join(config.server.outputDir, response.body.files.pdf))).toBe(true);
  });

  it('validiert den Zeitraum auch hier', async () => {
    await admin.agent
      .post('/api/report/run')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ year: 2026, month: 99, sendMail: false })
      .expect(400);
  });
});

describe('Dateien', () => {
  beforeEach(async () => {
    await admin.agent
      .post('/api/report/run')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ year: 2026, month: 3, sendMail: false });
  });

  it('listet die erzeugten Dateien', async () => {
    const response = await admin.agent.get('/api/report/files').expect(200);

    const names = response.body.files.map((file) => file.fileName);
    expect(names).toContain('ladestrom_2026-03_abrechnung.pdf');
    expect(names).toContain('ladestrom_2026-03_detail.csv');
  });

  it('liefert eine Datei zum Download aus', async () => {
    const response = await admin.agent
      .get('/api/report/files/ladestrom_2026-03_detail.csv')
      .expect(200);

    expect(response.headers['content-disposition']).toContain('ladestrom_2026-03_detail.csv');
  });

  it.each([
    ['../../../etc/passwd', 'relativer Pfad'],
    ['..%2f..%2fetc%2fpasswd', 'URL-kodiert'],
    ['settings.json', 'falsche Endung'],
    ['report.pdf.sh', 'untergeschobene Endung'],
  ])('blockt Path-Traversal: %s (%s)', async (name) => {
    const response = await admin.agent
      .get(`/api/report/files/${name}`);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.text).not.toContain('root:');
  });

  it('meldet 404 für eine nicht vorhandene Datei', async () => {
    await admin.agent
      .get('/api/report/files/ladestrom_1999-01_abrechnung.pdf')
      .expect(404);
  });
});

describe('Einstellungen über die API', () => {
  it('liefert die aktuellen Einstellungen', async () => {
    const response = await admin.agent.get('/api/settings').expect(200);

    expect(response.body.billing.pricePerKwh).toBe(0.3);
    expect(response.body.mail.to).toEqual(['buchhaltung@firma.de']);
  });

  it('gibt niemals Secrets preis', async () => {
    const response = await admin.agent.get('/api/settings').expect(200);
    const serialized = JSON.stringify(response.body).toLowerCase();

    expect(serialized).not.toContain('testpassword');
    expect(serialized).not.toContain('smtp_password');
    expect(serialized).not.toContain('"password"');
  });

  it('speichert gültige Aenderungen', async () => {
    const response = await admin.agent
      .put('/api/settings')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        billing: { pricePerKwh: 0.42, currency: 'CHF' },
        mail: { to: ['neu@firma.de', 'zweite@firma.de'] },
      })
      .expect(200);

    expect(response.body.settings.billing.pricePerKwh).toBe(0.42);
    expect(response.body.settings.mail.to).toEqual(['neu@firma.de', 'zweite@firma.de']);
    // Persistenz prüfen: neu laden statt Cache.
    expect(settingsStore.load({ force: true }).billing.currency).toBe('CHF');
  });

  it('nimmt Empfänger auch als kommaseparierten String an', async () => {
    const response = await admin.agent
      .put('/api/settings')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ mail: { to: 'a@firma.de, b@firma.de' } })
      .expect(200);

    expect(response.body.settings.mail.to).toEqual(['a@firma.de', 'b@firma.de']);
  });

  it('nimmt keine Ladekarten mehr entgegen - die gehören in den Fuhrpark', async () => {
    const response = await admin.agent
      .put('/api/settings')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ rfidMappings: [{ rfid: 'DEADBEEF', name: 'Neuer Fahrer' }] })
      .expect(200);

    // Stillschweigend ignoriert statt abgewiesen: das Feld ist schlicht nicht
    // mehr Teil der Einstellungen, und zwei Schreibwege auf dieselben Daten
    // waeren eine Fehlerquelle.
    const angelegt = response.body.settings.rfidMappings.map((entry) => entry.rfid);
    expect(angelegt).not.toContain('deadbeef');
  });

  it.each([
    [{ billing: { pricePerKwh: -1 } }, 'negativer Preis'],
    [{ billing: { pricePerKwh: 99 } }, 'unrealistischer Preis'],
    [{ billing: { pricePerKwh: 'teuer' } }, 'keine Zahl'],
    [{ billing: { timezone: 'Mars/Olympus' } }, 'unbekannte Zeitzone'],
    [{ mail: { to: ['keine-email'] } }, 'ungültige Adresse'],
  ])('weist ungültige Eingaben zurück (%#: %s)', async (payload) => {
    const response = await admin.agent
      .put('/api/settings')
      .set('X-CSRF-Token', admin.csrfToken)
      .send(payload)
      .expect(400);

    expect(response.body.error).toBe('bad_request');
  });

  it('ignoriert nicht gewhitelistete Felder', async () => {
    const response = await admin.agent
      .put('/api/settings')
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        smtpPassword: 'geheim',
        auth: { password: 'übernommen' },
        billing: { pricePerKwh: 0.35, eviltag: '<script>' },
      })
      .expect(200);

    expect(response.body.settings.smtpPassword).toBeUndefined();
    expect(response.body.settings.auth).toBeUndefined();
    expect(response.body.settings.billing.eviltag).toBeUndefined();
    expect(response.body.settings.billing.pricePerKwh).toBe(0.35);
  });
});

describe('GET /api/health', () => {
  it('meldet 200, wenn die Wallbox erreichbar ist', async () => {
    const response = await admin.agent.get('/api/health').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.wallbox.reachable).toBe(true);
    expect(response.body).toHaveProperty('uptimeSeconds');
  });

  it('meldet 503, wenn die Wallbox nicht antwortet', async () => {
    build({ ping: jest.fn(async () => ({ reachable: false, error: 'ETIMEDOUT' })) });
    const session = await login(request, app);

    const response = await session.agent.get('/api/health').expect(503);
    expect(response.body.status).toBe('degraded');
  });
});

describe('GET /api/live (SSE)', () => {
  // SSE lässt sich mit supertest schlecht testen (der Request endet nie).
  // Deshalb hier ein echter Server plus roher http-Client, der nach der
  // Zusicherung selbst abbricht.
  let server;
  let baseUrl;

  beforeEach((done) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach((done) => {
    server.close(() => done());
  });

  /**
   * Oeffnet /api/live und ruft onChunk für jeden Datenblock auf.
   * Gibt onChunk true zurück, wird die Verbindung geschlossen und das Promise aufgelöst.
   */
  function openStream(headers, onChunk) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `${baseUrl}/api/live`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${CREDENTIALS.user}:${CREDENTIALS.pass}`).toString('base64')}`,
            ...headers,
          },
        },
        (res) => {
          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buffer += chunk;
            if (onChunk(res, buffer)) {
              // Erst zerstören, dann auflösen - sonst feuert noch ein error-Event.
              res.destroy();
              req.destroy();
              resolve();
            }
          });
          res.on('error', () => { /* durch destroy() erwartet */ });
        }
      );
      req.on('error', (error) => {
        // ECONNRESET nach dem eigenen destroy() ist kein Testfehler.
        if (error.code !== 'ECONNRESET') reject(error);
      });
      setTimeout(() => {
        req.destroy();
        reject(new Error('Timeout: kein SSE-Frame empfangen'));
      }, 4000).unref();
    });
  }

  it('liefert die korrekten Stream-Header', async () => {
    await openStream({}, (res) => {
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.headers['cache-control']).toContain('no-cache');
      expect(res.headers['x-accel-buffering']).toBe('no');
      return true;
    });
  });

  /** Ein Frame gilt erst als vollständig, wenn die Leerzeile es abschliesst. */
  function hasCompleteStatusFrame(buffer) {
    return /event: status\ndata: .+\n\n/.test(buffer);
  }

  it('pusht den Wallbox-Zustand als status-Event', async () => {
    await openStream({}, (res, buffer) => {
      if (!hasCompleteStatusFrame(buffer)) return false;
      expect(buffer).toContain('"status":"charging"');
      expect(buffer).toContain('"powerKw":11.04');
      expect(buffer).toContain('"rfidName":"Max Mustermann"');
      return true;
    });
  });

  it('komprimiert den Stream nicht (sonst blieben Events hängen)', async () => {
    await openStream({ 'Accept-Encoding': 'gzip' }, (res) => {
      expect(res.headers['content-encoding']).toBeUndefined();
      return true;
    });
  });

  it('registriert und entfernt Abonnenten sauber', async () => {
    expect(liveFeed.subscriberCount).toBe(0);

    await openStream({}, (res, buffer) => hasCompleteStatusFrame(buffer));

    // Das close-Event des Requests kommt asynchron.
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(liveFeed.subscriberCount).toBe(0);
  });
});
