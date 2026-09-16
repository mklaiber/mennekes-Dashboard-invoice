'use strict';

const MennekesClient = require('../src/services/mennekesClient');
const { MennekesApiError } = require('../src/services/mennekesClient');
const fixtures = require('./fixtures/wallbox');

/** Minimaler Axios-Ersatz: liefert vorgegebene Antworten und protokolliert die Aufrufe. */
function fakeHttp(responses) {
  const calls = [];
  return {
    calls,
    get: jest.fn(async (path, options) => {
      calls.push({ path, params: options?.params });
      const entry = responses[path];
      if (entry === undefined) {
        const error = new Error(`Request failed with status code 404`);
        error.response = { status: 404 };
        throw error;
      }
      if (entry instanceof Error) throw entry;
      if (typeof entry === 'function') return { data: await entry(calls.length) };
      return { data: entry };
    }),
  };
}

describe('MennekesClient', () => {
  describe('normalizeStatus', () => {
    it('normalisiert eine Ladevorgangs-Antwort', () => {
      const state = MennekesClient.normalizeStatus(fixtures.statusCharging);

      expect(state.status).toBe('charging');
      expect(state.statusLabel).toBe('Lädt');
      expect(state.powerKw).toBe(11.04);
      expect(state.energySessionKwh).toBe(8.42);
      expect(state.meterKwh).toBe(4211.7);
      expect(state.currentA).toBe(16.1);
      expect(state.voltageV).toBe(230);
      // Trennzeichen werden entfernt und kleingeschrieben.
      expect(state.rfid).toBe('04a1b2c3');
      expect(state.rfidRaw).toBe('04:A1:B2:C3');
      expect(state.vehicleConnected).toBe(true);
      expect(state.sessionStart).toEqual(new Date('2026-03-05T17:12:00.000Z'));
    });

    it('rechnet Watt in Kilowatt um, wenn die Einheit es sagt', () => {
      const state = MennekesClient.normalizeStatus({ status: 'Charging', power: 11040, powerUnit: 'W' });
      expect(state.powerKw).toBe(11.04);
    });

    it('erkennt Watt heuristisch auch ohne Einheitsangabe', () => {
      // > 100 kW gibt es an keiner Heim-Wallbox -> muss Watt sein.
      const state = MennekesClient.normalizeStatus({ status: 'Charging', power: 22000 });
      expect(state.powerKw).toBe(22);
    });

    it('versteht IEC-61851-Zustandsbuchstaben', () => {
      expect(MennekesClient.normalizeStatus({ state: 'A' }).status).toBe('standby');
      expect(MennekesClient.normalizeStatus({ state: 'B' }).status).toBe('connected');
      expect(MennekesClient.normalizeStatus({ state: 'C' }).status).toBe('charging');
      expect(MennekesClient.normalizeStatus({ state: 'E' }).status).toBe('error');
    });

    it('versteht OCPP-Statuswerte', () => {
      const state = MennekesClient.normalizeStatus(fixtures.statusSuspended);
      expect(state.status).toBe('connected');
      expect(state.statusLabel).toBe('Verbunden');
      expect(state.rfid).toBe('aabbccdd');
    });

    it('fällt bei unbekanntem Status auf "unknown" zurück', () => {
      const state = MennekesClient.normalizeStatus({ status: 'Völliger Quatsch' });
      expect(state.status).toBe('unknown');
      expect(state.statusLabel).toBe('Unbekannt');
      expect(state.vehicleConnected).toBe(false);
    });

    it('liefert brauchbare Defaults bei leerer Antwort', () => {
      const state = MennekesClient.normalizeStatus({});
      expect(state.status).toBe('unknown');
      expect(state.powerKw).toBe(0);
      expect(state.rfid).toBeNull();
      expect(state.meterKwh).toBeNull();
    });

    it('nie eine negative Leistung', () => {
      // Rückspeisung/Messrauschen darf das Dashboard nicht ins Minus ziehen.
      expect(MennekesClient.normalizeStatus({ status: 'Charging', power: -2.5 }).powerKw).toBe(0);
    });
  });

  describe('normalizeSession', () => {
    it('normalisiert einen vollständigen Datensatz', () => {
      const session = MennekesClient.normalizeSession(fixtures.sessionsMarch2026.transactions[0]);

      expect(session.id).toBe('tx-1001');
      expect(session.start).toEqual(new Date('2026-03-02T06:30:00.000Z'));
      expect(session.energyKwh).toBe(24.5);
      expect(session.rfid).toBe('04a1b2c3');
      expect(session.durationSeconds).toBe(3 * 3600 + 15 * 60);
    });

    it('berechnet die Energie aus den Zählerständen, wenn kein Energiefeld da ist', () => {
      const session = MennekesClient.normalizeSession(fixtures.sessionsMarch2026.transactions[1]);
      expect(session.energyKwh).toBe(32.25);
    });

    it('rechnet Wattstunden in kWh um', () => {
      const session = MennekesClient.normalizeSession(fixtures.sessionsMarch2026.transactions[2]);
      expect(session.energyKwh).toBe(12.25);
    });

    it('versteht Unix-Timestamps in Sekunden', () => {
      const session = MennekesClient.normalizeSession(fixtures.sessionsMarch2026.transactions[3]);
      expect(session.start.getTime()).toBe(1774252800 * 1000);
      expect(session.durationSeconds).toBe(7200);
    });

    it('verwirft Datensätze ohne Startzeitpunkt', () => {
      expect(MennekesClient.normalizeSession({ energy: 5, idTag: 'x' })).toBeNull();
    });

    it('verwirft Datensätze ohne ermittelbare Energie', () => {
      expect(MennekesClient.normalizeSession({ startTime: '2026-03-01T10:00:00Z' })).toBeNull();
    });

    it('verwirft negative Energiemengen', () => {
      expect(MennekesClient.normalizeSession({ startTime: '2026-03-01T10:00:00Z', energy: -3 })).toBeNull();
    });

    it('nutzt "unbekannt" als RFID, wenn kein Tag geliefert wird', () => {
      const session = MennekesClient.normalizeSession({ startTime: '2026-03-01T10:00:00Z', energy: 3 });
      expect(session.rfid).toBe('unbekannt');
      expect(session.rfidRaw).toBeNull();
    });

    it('ist robust gegen Unsinn', () => {
      expect(MennekesClient.normalizeSession(null)).toBeNull();
      expect(MennekesClient.normalizeSession('string')).toBeNull();
    });
  });

  describe('extractSessionArray', () => {
    it.each([
      ['nacktes Array', [{ a: 1 }]],
      ['unter transactions', { transactions: [{ a: 1 }] }],
      ['unter sessions', { sessions: [{ a: 1 }] }],
      ['unter data', { data: [{ a: 1 }] }],
      ['unter data.sessions', { data: { sessions: [{ a: 1 }] } }],
    ])('findet die Liste bei: %s', (unused, payload) => {
      expect(MennekesClient.extractSessionArray(payload)).toEqual([{ a: 1 }]);
    });

    it('liefert ein leeres Array bei unbekannter Struktur', () => {
      expect(MennekesClient.extractSessionArray({ irgendwas: 42 })).toEqual([]);
      expect(MennekesClient.extractSessionArray(null)).toEqual([]);
    });
  });

  describe('getLiveStatus', () => {
    it('ruft den konfigurierten Status-Endpunkt ab', async () => {
      const http = fakeHttp({ '/api/v1/status': fixtures.statusCharging });
      const client = new MennekesClient({ httpClient: http });

      const state = await client.getLiveStatus();

      expect(http.get).toHaveBeenCalledWith('/api/v1/status', { params: undefined });
      expect(state.powerKw).toBe(11.04);
    });

    it('packt verschachtelte data-Antworten aus', async () => {
      const http = fakeHttp({ '/api/v1/status': fixtures.statusStandbyNested });
      const client = new MennekesClient({ httpClient: http });

      const state = await client.getLiveStatus();
      expect(state.status).toBe('standby');
      expect(state.powerKw).toBe(0);
      expect(state.meterKwh).toBe(4203.28);
    });

    it('ergänzt Messwerte aus einem separaten Meter-Endpunkt', async () => {
      const http = fakeHttp({
        '/api/v1/status': { status: 'Charging', rfid: 'ABC' },
        '/api/v1/meter': { power: 7.4, current: 10.2, meterReading: 1234.5 },
      });
      const client = new MennekesClient({ httpClient: http, endpoints: { meter: '/api/v1/meter' } });

      const state = await client.getLiveStatus();
      expect(state.powerKw).toBe(7.4);
      expect(state.currentA).toBe(10.2);
      expect(state.meterKwh).toBe(1234.5);
    });

    it('überlebt einen ausgefallenen Meter-Endpunkt', async () => {
      const http = fakeHttp({ '/api/v1/status': { status: 'Charging', power: 5 } });
      const client = new MennekesClient({ httpClient: http, endpoints: { meter: '/api/v1/meter' }, retries: 0 });

      const state = await client.getLiveStatus();
      expect(state.powerKw).toBe(5);
    });
  });

  describe('getChargingSessions', () => {
    const from = new Date('2026-02-28T23:00:00.000Z'); // 01.03.2026 lokal
    const to = new Date('2026-03-31T22:00:00.000Z');   // 01.04.2026 lokal

    it('übergibt den Zeitraum als Query-Parameter', async () => {
      const http = fakeHttp({ '/api/v1/transactions': fixtures.sessionsMarch2026 });
      const client = new MennekesClient({ httpClient: http });

      await client.getChargingSessions(from, to);

      expect(http.calls[0].params).toEqual({
        from: from.toISOString(),
        to: to.toISOString(),
        limit: 1000,
      });
    });

    it('filtert clientseitig nach, falls die Wallbox die Parameter ignoriert', async () => {
      const http = fakeHttp({ '/api/v1/transactions': fixtures.sessionsMarch2026 });
      const client = new MennekesClient({ httpClient: http });

      const sessions = await client.getChargingSessions(from, to);
      const ids = sessions.map((session) => session.id);

      // tx-0999 liegt im Februar, tx-broken hat keinen Start -> beide fliegen raus.
      expect(ids).toEqual(['tx-1001', 'tx-1002', 'tx-1003', 'tx-1004']);
      expect(ids).not.toContain('tx-0999');
      expect(ids).not.toContain('tx-broken');
    });

    it('sortiert aufsteigend nach Startzeit', async () => {
      const http = fakeHttp({ '/api/v1/transactions': fixtures.sessionsMarch2026 });
      const client = new MennekesClient({ httpClient: http });

      const sessions = await client.getChargingSessions(from, to);
      const starts = sessions.map((session) => session.start.getTime());

      expect(starts).toEqual([...starts].sort((a, b) => a - b));
    });

    it('liefert ein leeres Array bei leerer Historie', async () => {
      const http = fakeHttp({ '/api/v1/transactions': { transactions: [] } });
      const client = new MennekesClient({ httpClient: http });

      expect(await client.getChargingSessions(from, to)).toEqual([]);
    });
  });

  describe('Fehlerbehandlung und Retry', () => {
    it('wiederholt bei 5xx und liefert dann das Ergebnis', async () => {
      let attempt = 0;
      const http = {
        get: jest.fn(async () => {
          attempt += 1;
          if (attempt < 3) {
            const error = new Error('Internal Server Error');
            error.response = { status: 503 };
            throw error;
          }
          return { data: fixtures.statusCharging };
        }),
      };
      const client = new MennekesClient({ httpClient: http, retries: 2 });

      const state = await client.getLiveStatus();
      expect(attempt).toBe(3);
      expect(state.status).toBe('charging');
    });

    it('wiederholt NICHT bei 4xx', async () => {
      const error = new Error('Unauthorized');
      error.response = { status: 401 };
      const http = { get: jest.fn(async () => { throw error; }) };
      const client = new MennekesClient({ httpClient: http, retries: 3 });

      await expect(client.getLiveStatus()).rejects.toThrow(MennekesApiError);
      expect(http.get).toHaveBeenCalledTimes(1);
    });

    it('wirft MennekesApiError mit Statuscode', async () => {
      const error = new Error('Forbidden');
      error.response = { status: 403 };
      const http = { get: jest.fn(async () => { throw error; }) };
      const client = new MennekesClient({ httpClient: http, retries: 0 });

      await expect(client.getLiveStatus()).rejects.toMatchObject({
        name: 'MennekesApiError',
        status: 403,
      });
    });

    it('ping() meldet Erreichbarkeit statt zu werfen', async () => {
      const okClient = new MennekesClient({ httpClient: fakeHttp({ '/api/v1/status': fixtures.statusCharging }) });
      await expect(okClient.ping()).resolves.toEqual({ reachable: true });

      const badClient = new MennekesClient({
        httpClient: { get: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) },
        retries: 0,
      });
      const result = await badClient.ping();
      expect(result.reachable).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });
  });
});
