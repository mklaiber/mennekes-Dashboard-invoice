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
const settingsStore = require('../src/config/settings');
const MennekesClient = require('../src/services/mennekesClient');
const LiveFeed = require('../src/services/liveFeed');
const pdfService = require('../src/services/pdfService');
const fixtures = require('./fixtures/wallbox');

const CREDENTIALS = { user: 'testuser', pass: 'testpassword' };

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

function build(clientOverrides = {}) {
  mennekesClient = fakeClient(clientOverrides);
  liveFeed = new LiveFeed({ client: mennekesClient, pollIntervalMs: 60000 });
  ({ app } = createApp({ mennekesClient, liveFeed }));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  pdfService._resetCaches();
  settingsStore.reset();
  settingsStore.save({
    billing: { pricePerKwh: 0.3, timezone: 'Europe/Berlin', currency: 'EUR', locale: 'de-DE' },
    mail: { from: 'wallbox@example.com', to: ['buchhaltung@firma.de'], cc: [] },
    rfidMappings: fixtures.rfidMappings,
  });
  build();
});

afterEach(() => {
  if (liveFeed) liveFeed.shutdown();
});

describe('Authentifizierung', () => {
  it.each([
    ['/', 'Dashboard'],
    ['/einstellungen', 'Einstellungen'],
    ['/api/status', 'Status-API'],
    ['/api/report', 'Report-API'],
    ['/api/settings', 'Settings-API'],
    ['/api/health', 'Health-API'],
    ['/static/js/dashboard.js', 'statische Dateien'],
  ])('verlangt Anmeldung für %s (%s)', async (url) => {
    const response = await request(app).get(url);

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toMatch(/Basic/);
  });

  it('weist falsche Zugangsdaten ab', async () => {
    await request(app).get('/').auth('testuser', 'falsch').expect(401);
    await request(app).get('/').auth('hacker', 'testpassword').expect(401);
  });

  it('lässt korrekte Zugangsdaten durch', async () => {
    await request(app).get('/').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(200);
  });

  it('startet nicht, wenn nirgends ein Passwort konfiguriert ist', () => {
    // Die Option fällt bewusst auf config.auth.password zurück - für diesen
    // Test muss deshalb auch die Konfiguration leer sein.
    const original = config.auth.password;
    config.auth.password = undefined;
    try {
      expect(() => createApp()).toThrow(/AUTH_PASSWORD/);
    } finally {
      config.auth.password = original;
    }
  });
});

describe('Sicherheits-Header', () => {
  it('setzt die Helmet-Header', async () => {
    const response = await request(app).get('/').auth(CREDENTIALS.user, CREDENTIALS.pass);

    expect(response.headers['content-security-policy']).toBeDefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('erlaubt in der CSP nur den Tailwind-CDN und eigene Skripte', async () => {
    const response = await request(app).get('/').auth(CREDENTIALS.user, CREDENTIALS.pass);
    const csp = response.headers['content-security-policy'];

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('https://cdn.tailwindcss.com');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // Inline-Skripte nur über Nonce, nicht pauschal.
    expect(csp).toMatch(/script-src[^;]*'nonce-/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});

describe('WebUI', () => {
  it('rendert das Dashboard', async () => {
    const response = await request(app).get('/').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(200);

    expect(response.text).toContain('Live-Übersicht');
    expect(response.text).toContain('Aktuelle Ladeleistung');
    expect(response.text).toContain('/static/js/dashboard.js');
  });

  it('rendert die Einstellungen mit den gespeicherten Werten', async () => {
    const response = await request(app).get('/einstellungen').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(200);

    expect(response.text).toContain('RFID-Zuordnung');
    expect(response.text).toContain('buchhaltung@firma.de');
    expect(response.text).toContain('Europe/Berlin');
  });

  it('liefert eine 404-Seite für unbekannte Pfade', async () => {
    const response = await request(app).get('/gibt-es-nicht').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(404);
    expect(response.text).toContain('Diese Seite existiert nicht.');
  });

  it('antwortet bei unbekannten API-Pfaden mit JSON', async () => {
    const response = await request(app).get('/api/gibt-es-nicht').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(404);
    expect(response.body.error).toBe('not_found');
  });
});

describe('GET /api/status', () => {
  it('liefert den normalisierten Zustand', async () => {
    const response = await request(app).get('/api/status').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(200);

    expect(response.body).toMatchObject({
      status: 'charging', statusLabel: 'Lädt', powerKw: 11.04, rfid: '04a1b2c3',
    });
  });

  it('löst den RFID-Namen aus dem Mapping auf', async () => {
    const response = await request(app).get('/api/status').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(200);
    expect(response.body.rfidName).toBe('Max Mustermann');
  });

  it('meldet einen Wallbox-Ausfall als 500 mit Meldung', async () => {
    build({ getLiveStatus: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) });

    const response = await request(app).get('/api/status').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(500);
    expect(response.body.error).toBe('internal_error');
  });
});

describe('GET /api/report', () => {
  it('liefert den Report für den angefragten Monat', async () => {
    const response = await request(app)
      .get('/api/report?year=2026&month=3')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .expect(200);

    expect(response.body.period.key).toBe('2026-03');
    expect(response.body.totals.energyKwh).toBe(76.125);
    expect(response.body.groups).toHaveLength(3);
  });

  it('nutzt ohne Parameter den Vormonat', async () => {
    const response = await request(app).get('/api/report').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(200);
    expect(response.body.period.key).toMatch(/^\d{4}-\d{2}$/);
  });

  it.each([
    ['?year=1999&month=3', 'Jahr zu klein'],
    ['?year=2026&month=13', 'Monat zu gross'],
    ['?year=2026&month=0', 'Monat zu klein'],
    ['?year=abc&month=3', 'Jahr keine Zahl'],
  ])('weist ungültige Parameter zurück: %s (%s)', async (query) => {
    const response = await request(app)
      .get(`/api/report${query}`)
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .expect(400);

    expect(response.body.error).toBe('bad_request');
  });
});

describe('POST /api/report/run', () => {
  it('erzeugt Dateien ohne Versand', async () => {
    const response = await request(app)
      .post('/api/report/run')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .send({ year: 2026, month: 3, sendMail: false })
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.files.pdf).toBe('ladestrom_2026-03_abrechnung.pdf');
    expect(response.body.mail).toBeNull();
    expect(fs.existsSync(path.join(config.server.outputDir, response.body.files.pdf))).toBe(true);
  });

  it('validiert den Zeitraum auch hier', async () => {
    await request(app)
      .post('/api/report/run')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .send({ year: 2026, month: 99, sendMail: false })
      .expect(400);
  });
});

describe('Dateien', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/report/run')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .send({ year: 2026, month: 3, sendMail: false });
  });

  it('listet die erzeugten Dateien', async () => {
    const response = await request(app).get('/api/report/files').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(200);

    const names = response.body.files.map((file) => file.fileName);
    expect(names).toContain('ladestrom_2026-03_abrechnung.pdf');
    expect(names).toContain('ladestrom_2026-03_detail.csv');
  });

  it('liefert eine Datei zum Download aus', async () => {
    const response = await request(app)
      .get('/api/report/files/ladestrom_2026-03_detail.csv')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .expect(200);

    expect(response.headers['content-disposition']).toContain('ladestrom_2026-03_detail.csv');
  });

  it.each([
    ['../../../etc/passwd', 'relativer Pfad'],
    ['..%2f..%2fetc%2fpasswd', 'URL-kodiert'],
    ['settings.json', 'falsche Endung'],
    ['report.pdf.sh', 'untergeschobene Endung'],
  ])('blockt Path-Traversal: %s (%s)', async (name) => {
    const response = await request(app)
      .get(`/api/report/files/${name}`)
      .auth(CREDENTIALS.user, CREDENTIALS.pass);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.text).not.toContain('root:');
  });

  it('meldet 404 für eine nicht vorhandene Datei', async () => {
    await request(app)
      .get('/api/report/files/ladestrom_1999-01_abrechnung.pdf')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .expect(404);
  });
});

describe('Einstellungen über die API', () => {
  it('liefert die aktuellen Einstellungen', async () => {
    const response = await request(app).get('/api/settings').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(200);

    expect(response.body.billing.pricePerKwh).toBe(0.3);
    expect(response.body.mail.to).toEqual(['buchhaltung@firma.de']);
  });

  it('gibt niemals Secrets preis', async () => {
    const response = await request(app).get('/api/settings').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(200);
    const serialized = JSON.stringify(response.body).toLowerCase();

    expect(serialized).not.toContain('testpassword');
    expect(serialized).not.toContain('smtp_password');
    expect(serialized).not.toContain('"password"');
  });

  it('speichert gültige Aenderungen', async () => {
    const response = await request(app)
      .put('/api/settings')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .send({
        billing: { pricePerKwh: 0.42, companyName: 'Neue GmbH' },
        mail: { to: ['neu@firma.de', 'zweite@firma.de'] },
      })
      .expect(200);

    expect(response.body.settings.billing.pricePerKwh).toBe(0.42);
    expect(response.body.settings.mail.to).toEqual(['neu@firma.de', 'zweite@firma.de']);
    // Persistenz prüfen: neu laden statt Cache.
    expect(settingsStore.load({ force: true }).billing.companyName).toBe('Neue GmbH');
  });

  it('nimmt Empfänger auch als kommaseparierten String an', async () => {
    const response = await request(app)
      .put('/api/settings')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .send({ mail: { to: 'a@firma.de, b@firma.de' } })
      .expect(200);

    expect(response.body.settings.mail.to).toEqual(['a@firma.de', 'b@firma.de']);
  });

  it('speichert RFID-Zuordnungen', async () => {
    const response = await request(app)
      .put('/api/settings')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .send({ rfidMappings: [{ rfid: 'DEADBEEF', name: 'Neuer Fahrer', plate: 'B-EV 9', billable: false }] })
      .expect(200);

    expect(response.body.settings.rfidMappings).toEqual([
      { rfid: 'DEADBEEF', name: 'Neuer Fahrer', plate: 'B-EV 9', billable: false },
    ]);
  });

  it('verwirft RFID-Einträge ohne ID', async () => {
    const response = await request(app)
      .put('/api/settings')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .send({ rfidMappings: [{ rfid: '', name: 'Leer' }, { rfid: 'OK01', name: 'Gut' }] })
      .expect(200);

    expect(response.body.settings.rfidMappings).toHaveLength(1);
  });

  it.each([
    [{ billing: { pricePerKwh: -1 } }, 'negativer Preis'],
    [{ billing: { pricePerKwh: 99 } }, 'unrealistischer Preis'],
    [{ billing: { pricePerKwh: 'teuer' } }, 'keine Zahl'],
    [{ billing: { timezone: 'Mars/Olympus' } }, 'unbekannte Zeitzone'],
    [{ mail: { to: ['keine-email'] } }, 'ungültige Adresse'],
    [{ wallbox: { baseUrl: 'ftp://wallbox' } }, 'falsches Protokoll'],
  ])('weist ungültige Eingaben zurück (%#: %s)', async (payload) => {
    const response = await request(app)
      .put('/api/settings')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
      .send(payload)
      .expect(400);

    expect(response.body.error).toBe('bad_request');
  });

  it('ignoriert nicht gewhitelistete Felder', async () => {
    const response = await request(app)
      .put('/api/settings')
      .auth(CREDENTIALS.user, CREDENTIALS.pass)
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
    const response = await request(app).get('/api/health').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.wallbox.reachable).toBe(true);
    expect(response.body).toHaveProperty('uptimeSeconds');
  });

  it('meldet 503, wenn die Wallbox nicht antwortet', async () => {
    build({ ping: jest.fn(async () => ({ reachable: false, error: 'ETIMEDOUT' })) });

    const response = await request(app).get('/api/health').auth(CREDENTIALS.user, CREDENTIALS.pass).expect(503);
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
