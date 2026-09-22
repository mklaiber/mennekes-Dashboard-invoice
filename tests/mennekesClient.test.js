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

      // #get() merged jetzt immer (ggf. leere) Auth-Query-Parameter ein - ein
      // no-op ausserhalb des 'query'-Auth-Modus, aber kein `undefined` mehr.
      expect(http.get).toHaveBeenCalledWith('/api/v1/status', { params: {} });
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

  // ==========================================================================
  // MENNEKES AMTRON (MHCP/1.0) - reverse-engineerte, aber konkrete Ziel-API
  // dieses Projekts. Siehe https://github.com/orlopau/amtron und
  // https://github.com/lephisto/amtron.
  // ==========================================================================

  describe('AMTRON: DevKey als Query-Parameter ("query"-Auth-Modus)', () => {
    it('hängt den Token als Query-Parameter an jede Anfrage', async () => {
      const http = fakeHttp({ '/ChargeData': { ChgState: 'Idle' } });
      const client = new MennekesClient({
        httpClient: http, authMode: 'query', authQueryParam: 'DevKey', token: '1234',
        endpoints: { status: '/ChargeData' },
      });

      await client.getLiveStatus();

      expect(http.calls[0].params).toEqual({ DevKey: '1234' });
    });

    it('mischt Auth-Parameter und fachliche Parameter', async () => {
      const http = fakeHttp({ '/ChargeRecords': { RemEntries: 0 } });
      const client = new MennekesClient({
        httpClient: http, authMode: 'query', authQueryParam: 'DevKey', token: '1234',
        sessionsProtocol: 'amtron-stateful', endpoints: { sessions: '/ChargeRecords' },
      });

      await client.getChargingSessions(new Date('2026-03-01'), new Date('2026-04-01'));

      expect(http.calls[0].params).toMatchObject({ DevKey: '1234', State: 'Open' });
    });

    it('sendet ohne Token keinen Query-Parameter (kein leerer Wert)', async () => {
      const http = fakeHttp({ '/ChargeData': { ChgState: 'Idle' } });
      const client = new MennekesClient({
        httpClient: http, authMode: 'query', authQueryParam: 'DevKey', token: undefined,
        endpoints: { status: '/ChargeData' },
      });

      await client.getLiveStatus();

      expect(http.calls[0].params).toEqual({});
    });

    it('bleibt außerhalb des query-Modus wirkungslos, auch mit gesetztem Token', async () => {
      const http = fakeHttp({ '/ChargeData': { ChgState: 'Idle' } });
      const client = new MennekesClient({
        httpClient: http, authMode: 'bearer', authQueryParam: 'DevKey', token: '1234',
        endpoints: { status: '/ChargeData' },
      });

      await client.getLiveStatus();

      expect(http.calls[0].params).toEqual({});
    });
  });

  describe('AMTRON: /ChargeData-Feldnamen', () => {
    it('erkennt ChgState, ActPwr, ChgNrg und Uid', () => {
      const state = MennekesClient.normalizeStatus({
        ChgState: 'Charging', ActPwr: 11040, ChgNrg: 8420, Uid: '04A1B2C3',
      });

      expect(state.status).toBe('charging');
      expect(state.powerKw).toBe(11.04);
      expect(state.energySessionKwh).toBe(8.42);
      expect(state.rfidRaw).toBe('04A1B2C3');
      expect(state.rfid).toBe('04a1b2c3');
    });

    it('versteht die AMTRON-spezifischen Zwischenzustände', () => {
      expect(MennekesClient.normalizeStatus({ ChgState: 'Paused' }).status).toBe('connected');
      expect(MennekesClient.normalizeStatus({ ChgState: 'StandbyConnect' }).status).toBe('connected');
      expect(MennekesClient.normalizeStatus({ ChgState: 'StandbyAuthorize' }).status).toBe('connected');
      expect(MennekesClient.normalizeStatus({ ChgState: 'Idle' }).status).toBe('standby');
    });

    it('interpretiert ChgNrg als Wattstunden ohne separates Einheitenfeld', () => {
      // Ohne die AMTRON-Sonderbehandlung würde die generische Erkennung
      // ChgNrg faelschlich als bereits-kWh lesen (8420 kWh statt 8.42 kWh).
      const state = MennekesClient.normalizeStatus({ ChgState: 'Charging', ChgNrg: 8420 });
      expect(state.energySessionKwh).toBe(8.42);
    });

    it('bildet keine Messwerte für Strom/Spannung, die AMTRON nicht liefert', () => {
      // ActCurr ist laut Dokumentation eine konfigurierte Obergrenze, kein
      // Messwert - sie darf nicht faelschlich als "Strom" angezeigt werden.
      const state = MennekesClient.normalizeStatus({ ChgState: 'Charging', ActPwr: 1000, ActCurr: 16 });
      expect(state.currentA).toBeNull();
      expect(state.voltageV).toBeNull();
    });
  });

  describe('AMTRON: /ChargeRecords-Feldnamen', () => {
    it('erkennt Start, Stop, ChrNr und Uid', () => {
      const session = MennekesClient.normalizeSession({
        Start: 1772688600, Stop: 1772700300, ChrNr: 24500, Uid: '04A1B2C3',
      });

      expect(session.start.toISOString()).toBe(new Date(1772688600 * 1000).toISOString());
      expect(session.end.toISOString()).toBe(new Date(1772700300 * 1000).toISOString());
      expect(session.energyKwh).toBe(24.5);
      expect(session.durationSeconds).toBe(11700);
      expect(session.rfidRaw).toBe('04A1B2C3');
    });

    it('interpretiert ChrNr als Wattstunden ohne separates Einheitenfeld', () => {
      const session = MennekesClient.normalizeSession({ Start: 1772688600, ChrNr: 24500, Uid: 'X' });
      expect(session.energyKwh).toBe(24.5);
    });

    it('synthetisiert eine ID, da AMTRON keine mitliefert', () => {
      const session = MennekesClient.normalizeSession({ Start: 1772688600, ChrNr: 100, Uid: 'AABB' });
      expect(session.id).toContain('AABB');
    });
  });

  describe('AMTRON: zustandsbehaftetes Historienprotokoll (Open/Read/Close)', () => {
    /** Simuliert die Open/Read/Close-Zustandsmaschine von /ChargeRecords. */
    function fakeAmtronHistory(batches) {
      const calls = [];
      let readIndex = 0;
      return {
        calls,
        get: jest.fn(async (path, opts) => {
          calls.push({ path, params: opts.params });
          const state = opts.params.State;
          if (state === 'Open') {
            const total = batches.reduce((sum, batch) => sum + batch.length, 0);
            return { data: { RemEntries: total } };
          }
          if (state === 'Read') {
            const batch = batches[readIndex] || [];
            readIndex += 1;
            const remaining = batches.slice(readIndex).reduce((sum, b) => sum + b.length, 0);
            return { data: { RemEntries: remaining, Records: batch } };
          }
          if (state === 'Close') return { data: {} };
          throw new Error(`unerwarteter State: ${state}`);
        }),
      };
    }

    it('durchläuft Open, mehrere Read-Schritte und Close', async () => {
      const http = fakeAmtronHistory([
        [{ Start: 1772688600, Stop: 1772700300, ChrNr: 24500, Uid: 'AABB' }],
        [{ Start: 1772775000, Stop: 1772786700, ChrNr: 32250, Uid: 'CCDD' }],
      ]);
      const client = new MennekesClient({
        httpClient: http, sessionsProtocol: 'amtron-stateful',
        endpoints: { sessions: '/ChargeRecords' },
      });

      const sessions = await client.getChargingSessions(new Date('2026-03-01'), new Date('2026-04-01'));

      expect(sessions).toHaveLength(2);
      expect(http.calls.map((call) => call.params.State)).toEqual(['Open', 'Read', 'Read', 'Close']);
    });

    it('sendet Start/End als Unix-Sekunden, unabhängig von sessionQuery', async () => {
      const http = fakeAmtronHistory([]);
      const client = new MennekesClient({
        httpClient: http, sessionsProtocol: 'amtron-stateful',
        endpoints: { sessions: '/ChargeRecords' },
        // Absichtlich andere Parameternamen konfiguriert - amtron-stateful
        // muss sie ignorieren und fest 'Start'/'End' verwenden.
        sessionQuery: { fromParam: 'from', toParam: 'to' },
      });

      await client.getChargingSessions(new Date('2026-03-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'));

      expect(http.calls[0].params).toMatchObject({
        Start: Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000),
        End: Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000),
      });
    });

    it('schließt die Sitzung auch, wenn Read fehlschlägt', async () => {
      const calls = [];
      const http = {
        get: jest.fn(async (path, opts) => {
          calls.push(opts.params.State);
          if (opts.params.State === 'Open') return { data: { RemEntries: 5 } };
          if (opts.params.State === 'Read') throw new Error('ECONNRESET');
          return { data: {} };
        }),
      };
      const client = new MennekesClient({
        httpClient: http, sessionsProtocol: 'amtron-stateful', retries: 0,
        endpoints: { sessions: '/ChargeRecords' },
      });

      await expect(client.getChargingSessions(new Date('2026-03-01'), new Date('2026-04-01')))
        .rejects.toThrow();

      // Close muss trotz des Fehlers gesendet worden sein - sonst bleibt die
      // Sitzung auf dem Gerät belegt.
      expect(calls).toContain('Close');
    });

    it('bricht ab, wenn eine Read-Antwort leer ist, obwohl RemEntries > 0 bleibt', async () => {
      // Schutz gegen eine Endlosschleife bei abweichendem Firmware-Verhalten.
      const http = {
        get: jest.fn(async (path, opts) => {
          if (opts.params.State === 'Open') return { data: { RemEntries: 999 } };
          if (opts.params.State === 'Read') return { data: { RemEntries: 999, Records: [] } };
          return { data: {} };
        }),
      };
      const client = new MennekesClient({
        httpClient: http, sessionsProtocol: 'amtron-stateful',
        endpoints: { sessions: '/ChargeRecords' },
      });

      const sessions = await client.getChargingSessions(new Date('2026-03-01'), new Date('2026-04-01'));

      expect(sessions).toEqual([]);
      // Genau EIN Read-Versuch, kein endloses Nachfragen.
      expect(http.get.mock.calls.filter((call) => call[1].params.State === 'Read')).toHaveLength(1);
    });

    it('verwirft Datensätze außerhalb des angefragten Zeitraums client-seitig', async () => {
      // Selbst wenn die Wallbox Start/End nicht exakt beachtet.
      const http = fakeAmtronHistory([[
        { Start: 1772688600, Stop: 1772700300, ChrNr: 24500, Uid: 'IN-RANGE' },
        { Start: 1700000000, Stop: 1700003600, ChrNr: 5000, Uid: 'TOO-OLD' },
      ]]);
      const client = new MennekesClient({
        httpClient: http, sessionsProtocol: 'amtron-stateful',
        endpoints: { sessions: '/ChargeRecords' },
      });

      const sessions = await client.getChargingSessions(new Date('2026-03-01'), new Date('2026-04-01'));

      expect(sessions).toHaveLength(1);
      expect(sessions[0].rfidRaw).toBe('IN-RANGE');
    });

    it('verwendet weiterhin das einfache Protokoll, wenn nicht "amtron-stateful" konfiguriert ist', async () => {
      const http = fakeHttp({ '/api/v1/transactions': { transactions: [] } });
      const client = new MennekesClient({ httpClient: http });

      await client.getChargingSessions(new Date('2026-03-01'), new Date('2026-04-01'));

      // Kein State=Open/Read/Close - ein einzelner GET wie bisher.
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0].params.State).toBeUndefined();
    });
  });

  describe('AMTRON: extractSessionArray-Fallbacks', () => {
    it('findet Datensätze unter "Records" (Großschreibung)', () => {
      const result = MennekesClient.extractSessionArray({
        RemEntries: 0, Records: [{ Start: 1, ChrNr: 100, Uid: 'X' }],
      });
      expect(result).toHaveLength(1);
    });

    it('erkennt flach abgelegte Datensätze ohne Array-Hülle', () => {
      // Die Community-Dokumentation zeigt für /ChargeRecords keine eindeutige
      // JSON-Struktur - dieser Fallback fängt eine index-artige Ablage ab.
      const result = MennekesClient.extractSessionArray({
        RemEntries: 0,
        first: { Start: 1, ChrNr: 100, Uid: 'A' },
        second: { Start: 2, ChrNr: 200, Uid: 'B' },
      });
      expect(result).toHaveLength(2);
    });

    it('ignoriert RemEntries selbst als Datensatz-Kandidat', () => {
      const result = MennekesClient.extractSessionArray({ RemEntries: 5 });
      expect(result).toEqual([]);
    });
  });
});
