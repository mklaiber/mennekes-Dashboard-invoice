'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const LiveFeed = require('../src/services/liveFeed');
const { assetVersion, _reset } = require('../src/utils/assets');
const { resetDatabase, createUser, login } = require('./helpers/testDb');

const CREDENTIALS = { username: 'testadmin', password: 'test-passwort-1234' };

let app;

beforeEach(async () => {
  resetDatabase();
  _reset();
  await createUser(CREDENTIALS);
  const liveFeed = new LiveFeed({ client: null, pollIntervalMs: 60000, pushOnly: true });
  ({ app } = createApp({ mennekesClient: null, liveFeed }));
});

describe('Versionskennung der statischen Dateien', () => {
  it('ist stabil über mehrere Aufrufe hinweg', () => {
    // Aus dem Dateiinhalt, nicht aus der Startzeit: ein Neustart des Pods
    // darf den Cache der Besucher nicht entwerten.
    expect(assetVersion()).toBe(assetVersion());
    expect(assetVersion()).toMatch(/^[0-9a-f]{10}$/);
  });

  it('hängt an jeder Einbindung von CSS und JavaScript', async () => {
    const { agent } = await login(request, app, CREDENTIALS);
    const version = assetVersion();

    for (const pfad of ['/', '/einstellungen', '/fuhrpark', '/benutzer']) {
      const page = await agent.get(pfad).expect(200);

      // Ohne Kennung fragt ein Browser die Datei sieben Tage lang nicht mehr
      // an (max-age=604800 bei unveraendertem Dateinamen) - jedes Deployment
      // bliebe fuer wiederkehrende Besucher unsichtbar.
      const ohne = page.text.match(/(?:href|src)="\/static\/[^"?]+\.(?:css|js)"/g);
      expect(ohne).toBeNull();

      expect(page.text).toContain(`/static/css/material.css?v=${version}`);
    }
  });

  it('trägt die Kennung auch auf der Anmeldeseite', async () => {
    const page = await request(app).get('/login').expect(200);
    expect(page.text).toContain(`?v=${assetVersion()}`);
  });

  it('trägt die Kennung auch auf der Fehlerseite', async () => {
    // Die Fehlerseite wird ganz am Ende der Kette gerendert. Waere die
    // Kennung erst spaeter gesetzt worden, wuerfe die Vorlage hier selbst.
    const { agent } = await login(request, app, CREDENTIALS);
    const page = await agent.get('/gibt-es-nicht').expect(404);
    expect(page.text).toContain(`?v=${assetVersion()}`);
  });
});
