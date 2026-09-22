'use strict';

const fleet = require('../src/repositories/fleetRepository');
const settingsStore = require('../src/repositories/settingsRepository');
const database = require('../src/db');
const { resetDatabase } = require('./helpers/testDb');

const insertSession = (id, rfid, kwh, startAt) => {
  database.db().prepare(`
    INSERT INTO charging_sessions (id, start_at, end_at, duration_seconds, energy_kwh, rfid, rfid_raw, source, received_at)
    VALUES (?, ?, ?, 3600, ?, ?, ?, 'connector', ?)
  `).run(id, startAt, startAt, kwh, rfid, rfid.toUpperCase(), startAt);
};

beforeEach(() => {
  resetDatabase();
});

describe('Stammdaten', () => {
  it('kennt "privat" als Abwesenheit einer Firma, nicht als eigene Firma', () => {
    // Zwei Schreibweisen fuer denselben Sachverhalt waeren eine Fehlerquelle:
    // ein Auto ohne Firma und ein Auto an einer Firma namens "Privat".
    expect(fleet.listCompanies()).toHaveLength(0);

    const privat = fleet.createVehicle({ plate: 'TUT-PR-1' });
    expect(privat.isPrivate).toBe(true);
    expect(privat.companyId).toBeNull();

    const company = fleet.createCompany({ name: 'Klaiber GmbH' });
    const dienstwagen = fleet.createVehicle({ plate: 'TUT-MK-1', companyId: company.id });
    expect(dienstwagen.isPrivate).toBe(false);
  });

  it('führt ein Fahrzeug mit Firma, Mitarbeiter und mehreren Karten', () => {
    const company = fleet.createCompany({ name: 'Klaiber GmbH', contactEmail: 'buchhaltung@example.net' });
    const vehicle = fleet.createVehicle({
      plate: 'TUT-MK-100', label: 'Kombi', companyId: company.id, employeeName: 'Moritz',
    });

    fleet.assignCardToVehicle('aaaa1111', vehicle.id);
    fleet.assignCardToVehicle('bbbb2222', vehicle.id);

    const loaded = fleet.findVehicle(vehicle.id);
    expect(loaded.companyName).toBe('Klaiber GmbH');
    expect(loaded.employeeName).toBe('Moritz');
    expect(loaded.cards.map((c) => c.rfid).sort()).toEqual(['aaaa1111', 'bbbb2222']);
  });

  it('unterscheidet "eigener Arbeitspreis" von "null Cent"', () => {
    const standard = fleet.createCompany({ name: 'Ohne eigenen Preis' });
    const eigener = fleet.createCompany({ name: 'Mit eigenem Preis', pricePerKwh: 0.42 });

    // null heisst "globale Einstellung benutzen" - 0 waere ein echter Preis.
    expect(standard.pricePerKwh).toBeNull();
    expect(eigener.pricePerKwh).toBe(0.42);
  });
});

describe('Zuordnung einfrieren', () => {
  it('löst eine Karte zu Fahrzeug, Firma und Mitarbeiter auf', () => {
    const company = fleet.createCompany({ name: 'Klaiber GmbH' });
    const vehicle = fleet.createVehicle({
      plate: 'TUT-MK-100', companyId: company.id, employeeName: 'Moritz',
    });
    fleet.assignCardToVehicle('aaaa1111', vehicle.id);

    expect(fleet.resolveAttribution('aaaa1111')).toMatchObject({
      vehicleId: vehicle.id,
      companyId: company.id,
      vehiclePlate: 'TUT-MK-100',
      companyName: 'Klaiber GmbH',
      employeeName: 'Moritz',
    });
  });

  it('liefert für eine unbekannte Karte eine leere Zuordnung statt eines Fehlers', () => {
    expect(fleet.resolveAttribution('gibtesnicht')).toMatchObject({ vehicleId: null, companyName: '' });
    expect(fleet.resolveAttribution('')).toMatchObject({ vehicleId: null });
  });
});

describe('Nicht zugeordnete Karten', () => {
  it('sammelt Karten aus Ladevorgängen, die zu keinem Fahrzeug gehören', () => {
    insertSession('s1', 'zzzz9999', 5, '2026-08-01T10:00:00Z');
    insertSession('s2', 'zzzz9999', 7, '2026-08-02T10:00:00Z');

    const [card] = fleet.listUnassignedCards();
    expect(card.rfid).toBe('zzzz9999');
    expect(card.sessionCount).toBe(2);
    expect(card.energyKwh).toBe(12);
    expect(card.known).toBe(false);
  });

  it('übernimmt auf Wunsch die bisherigen Ladevorgänge rückwirkend', () => {
    insertSession('s1', 'zzzz9999', 5, '2026-08-01T10:00:00Z');
    insertSession('s2', 'zzzz9999', 7, '2026-08-02T10:00:00Z');

    const company = fleet.createCompany({ name: 'Klaiber GmbH' });
    const vehicle = fleet.createVehicle({
      plate: 'TUT-MK-100', companyId: company.id, employeeName: 'Moritz',
    });

    const result = fleet.assignCardToVehicle('zzzz9999', vehicle.id, { backfill: true });

    expect(result.backfilled).toBe(2);
    expect(fleet.listUnassignedCards()).toHaveLength(0);

    const row = database.db().prepare('SELECT * FROM charging_sessions WHERE id = ?').get('s1');
    expect(row.company_name).toBe('Klaiber GmbH');
    expect(row.employee_name).toBe('Moritz');
    expect(row.vehicle_plate).toBe('TUT-MK-100');
  });

  it('schreibt bereits zugeordnete Ladevorgänge NICHT um', () => {
    // Sonst änderte eine Umbuchung rückwirkend eine fertige Rechnung.
    const alt = fleet.createVehicle({ plate: 'ALT-1' });
    const neu = fleet.createVehicle({ plate: 'NEU-1' });

    insertSession('s1', 'aaaa1111', 5, '2026-08-01T10:00:00Z');
    fleet.assignCardToVehicle('aaaa1111', alt.id, { backfill: true });

    const umgebucht = fleet.assignCardToVehicle('aaaa1111', neu.id, { backfill: true });

    expect(umgebucht.backfilled).toBe(0);
    const row = database.db().prepare('SELECT vehicle_plate FROM charging_sessions WHERE id = ?').get('s1');
    expect(row.vehicle_plate).toBe('ALT-1');
    // Kuenftige Ladevorgaenge gehen aber an das neue Fahrzeug.
    expect(fleet.resolveAttribution('aaaa1111').vehiclePlate).toBe('NEU-1');
  });

  it('legt eine bisher gänzlich unbekannte Karte beim Zuordnen an', () => {
    const vehicle = fleet.createVehicle({ plate: 'TUT-MK-100' });
    expect(settingsStore.listRfidMappings()).toHaveLength(0);

    fleet.assignCardToVehicle('neuekarte', vehicle.id);

    const mappings = settingsStore.listRfidMappings();
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({ rfid: 'neuekarte', vehicleId: vehicle.id });
  });
});

describe('Einstellungen speichern', () => {
  it('behält die Fahrzeugzuordnung, wenn das Karten-Formular gespeichert wird', () => {
    // Das Formular kennt kein vehicle_id - ohne Schutz löschte jedes
    // Speichern sämtliche Zuordnungen und alle neuen Ladevorgänge fielen
    // stillschweigend in "nicht zugeordnet".
    const vehicle = fleet.createVehicle({ plate: 'TUT-MK-100' });
    fleet.assignCardToVehicle('aaaa1111', vehicle.id);

    settingsStore.replaceRfidMappings([
      { rfid: 'aaaa1111', name: 'Moritz', plate: 'TUT-MK-100', billable: true },
    ]);

    expect(fleet.resolveAttribution('aaaa1111').vehicleId).toBe(vehicle.id);
  });

  it('löst die Zuordnung nur, wenn ausdrücklich null übergeben wird', () => {
    const vehicle = fleet.createVehicle({ plate: 'TUT-MK-100' });
    fleet.assignCardToVehicle('aaaa1111', vehicle.id);

    settingsStore.replaceRfidMappings([{ rfid: 'aaaa1111', name: 'Moritz', vehicleId: null }]);

    expect(fleet.resolveAttribution('aaaa1111').vehicleId).toBeNull();
  });
});

describe('Eingang neuer Ladevorgänge', () => {
  const chargingSessions = require('../src/repositories/chargingSessionRepository');

  const incoming = (id, rfid, kwh) => ({
    id, rfid, rfidRaw: rfid.toUpperCase(), energyKwh: kwh,
    start: new Date('2026-09-01T10:00:00Z'), end: new Date('2026-09-01T11:00:00Z'),
    durationSeconds: 3600,
  });

  it('friert Fahrzeug, Firma und Mitarbeiter auf dem Datensatz ein', () => {
    const company = fleet.createCompany({ name: 'Klaiber GmbH' });
    const vehicle = fleet.createVehicle({
      plate: 'TUT-MK-100', companyId: company.id, employeeName: 'Moritz',
    });
    fleet.assignCardToVehicle('aaaa1111', vehicle.id);

    chargingSessions.upsertMany([incoming('neu-1', 'aaaa1111', 20)]);

    const row = database.db().prepare('SELECT * FROM charging_sessions WHERE id = ?').get('neu-1');
    expect(row.vehicle_id).toBe(vehicle.id);
    expect(row.company_name).toBe('Klaiber GmbH');
    expect(row.employee_name).toBe('Moritz');
    expect(row.vehicle_plate).toBe('TUT-MK-100');
  });

  it('überschreibt eine bestehende Zuordnung beim erneuten Senden NICHT', () => {
    const alt = fleet.createVehicle({ plate: 'ALT-1' });
    fleet.assignCardToVehicle('aaaa1111', alt.id);
    chargingSessions.upsertMany([incoming('neu-1', 'aaaa1111', 20)]);

    // Karte wird umgebucht, dann liefert der Connector denselben Vorgang erneut.
    const neu = fleet.createVehicle({ plate: 'NEU-1' });
    fleet.assignCardToVehicle('aaaa1111', neu.id);
    chargingSessions.upsertMany([incoming('neu-1', 'aaaa1111', 21)]);

    const row = database.db().prepare('SELECT * FROM charging_sessions WHERE id = ?').get('neu-1');
    expect(row.vehicle_plate).toBe('ALT-1');   // Rechnung bleibt stabil
    expect(row.energy_kwh).toBe(21);           // Messwert wird trotzdem aktualisiert
  });

  it('trägt eine noch leere Zuordnung beim erneuten Senden nach', () => {
    chargingSessions.upsertMany([incoming('neu-1', 'aaaa1111', 20)]);
    expect(database.db().prepare('SELECT vehicle_id FROM charging_sessions WHERE id = ?').get('neu-1').vehicle_id).toBeNull();

    const vehicle = fleet.createVehicle({ plate: 'TUT-MK-100' });
    fleet.assignCardToVehicle('aaaa1111', vehicle.id);
    chargingSessions.upsertMany([incoming('neu-1', 'aaaa1111', 20)]);

    const row = database.db().prepare('SELECT * FROM charging_sessions WHERE id = ?').get('neu-1');
    expect(row.vehicle_id).toBe(vehicle.id);
    expect(row.vehicle_plate).toBe('TUT-MK-100');
  });
});

describe('Abrechnung nach Fahrzeug, Firma und Mitarbeiter', () => {
  const { buildMonthlyReport } = require('../src/services/billing');

  const session = (id, attrs) => ({
    id,
    start: new Date('2026-08-05T10:00:00Z'),
    end: new Date('2026-08-05T11:00:00Z'),
    durationSeconds: 3600,
    rfid: 'x', rfidRaw: 'X',
    vehicleId: null, companyId: null,
    vehiclePlate: '', companyName: '', employeeName: '',
    ...attrs,
  });

  const sessions = [
    session('a', { energyKwh: 10, vehicleId: 1, companyId: 1, vehiclePlate: 'TUT-MK-100', companyName: 'Klaiber GmbH', employeeName: 'Moritz' }),
    session('b', { energyKwh: 20, vehicleId: 1, companyId: 1, vehiclePlate: 'TUT-MK-100', companyName: 'Klaiber GmbH', employeeName: 'Moritz' }),
    session('c', { energyKwh: 30, vehicleId: 2, companyId: 1, vehiclePlate: 'TUT-SK-200', companyName: 'Klaiber GmbH', employeeName: 'Sabine' }),
    session('d', { energyKwh: 40, vehicleId: 3, companyId: 2, vehiclePlate: 'TUT-PR-300', companyName: 'Andere AG', employeeName: 'Chris' }),
    session('e', { energyKwh: 5 }), // keiner Karte zugeordnet
  ];

  const build = (scope) => buildMonthlyReport({
    sessions, year: 2026, month: 8, pricePerKwh: 0.5, scope,
  });

  it('fasst je Fahrzeug zusammen', () => {
    const report = build();
    const tut100 = report.byVehicle.find((g) => g.plate === 'TUT-MK-100');

    expect(tut100.sessionCount).toBe(2);
    expect(tut100.energyKwh).toBe(30);
    expect(tut100.cost).toBe(15);
    expect(report.byVehicle.find((g) => !g.assigned).label).toBe('Nicht zugeordnet');
  });

  it('fasst je Firma und je Mitarbeiter zusammen', () => {
    const report = build();

    expect(report.byCompany.find((g) => g.label === 'Klaiber GmbH').energyKwh).toBe(60);
    expect(report.byCompany.find((g) => g.label === 'Andere AG').energyKwh).toBe(40);
    expect(report.byEmployee.find((g) => g.label === 'Moritz').energyKwh).toBe(30);
    expect(report.byEmployee.find((g) => g.label === 'Sabine').energyKwh).toBe(30);
  });

  it('grenzt auf eine Firma ein — andere Firmen tauchen gar nicht auf', () => {
    const report = build({ kind: 'company', id: 2 });

    expect(report.totals.energyKwh).toBe(40);
    expect(report.byCompany).toHaveLength(1);
    expect(report.byCompany[0].label).toBe('Andere AG');
    expect(report.scope).toEqual({ kind: 'company', id: 2 });
  });

  it('grenzt auf ein Fahrzeug ein', () => {
    expect(build({ kind: 'vehicle', id: 1 }).totals.energyKwh).toBe(30);
  });

  it('listet nicht zugeordnete Ladevorgänge als eigene Arbeitsliste', () => {
    const report = build({ kind: 'unassigned' });

    expect(report.totals.sessionCount).toBe(1);
    expect(report.totals.energyKwh).toBe(5);
  });

  it('weist nicht zugeordnete Energie auch im Gesamtbericht aus', () => {
    const report = build();

    expect(report.totals.unassignedSessionCount).toBe(1);
    expect(report.totals.unassignedEnergyKwh).toBe(5);
    expect(report.totals.companyCount).toBe(2);
  });

  it('rechnet die Kosten auf der Gruppensumme, nicht als Summe gerundeter Einzelposten', () => {
    const drei = [
      session('x', { energyKwh: 0.333, vehicleId: 1, vehiclePlate: 'P' }),
      session('y', { energyKwh: 0.333, vehicleId: 1, vehiclePlate: 'P' }),
      session('z', { energyKwh: 0.333, vehicleId: 1, vehiclePlate: 'P' }),
    ];
    const report = buildMonthlyReport({ sessions: drei, year: 2026, month: 8, pricePerKwh: 0.37 });

    const group = report.byVehicle[0];
    expect(group.energyKwh).toBe(0.999);
    expect(group.cost).toBe(Number((0.999 * 0.37).toFixed(2)));
  });
});
