'use strict';

/**
 * Aktualisierung einer bestehenden Datenbank.
 *
 * Die uebrigen Tests legen das Schema jedes Mal frisch an. In Produktion liegt
 * dagegen eine Datenbank mit Daten im Stand einer frueheren Version, und die
 * neue Migration laeuft beim Start ueber genau diese. Das spielt dieser Test
 * nach: Datei im Stand von Version 4 mit Inhalten wie in Produktion, dann das
 * echte database.open() - derselbe Weg wie beim Start des Pods.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../src/db');
const { MIGRATIONS } = require('../src/db/schema');
const fleet = require('../src/repositories/fleetRepository');
const cardLearning = require('../src/repositories/cardLearningRepository');

const CARD = '04d3a1b27c5e80';
const FREE = 'aaaabbbbccccddddeeee';
const T = '2026-09-01T08:00:00.000Z';

let dir;
let file;

/** Legt eine Datei im Stand der angegebenen Version an. */
function createAtVersion(version) {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const migration of MIGRATIONS.filter((m) => m.version <= version)) {
    db.exec(migration.up);
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.name, T);
  }
  return db;
}

beforeEach(() => {
  database.close();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallbox-migration-'));
  file = path.join(dir, 'wallbox.sqlite');
});

afterEach(() => {
  database.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Migration 5 (Karten anlernen) auf einer Datenbank im Stand 4', () => {
  beforeEach(() => {
    const db = createAtVersion(4);
    db.prepare(`INSERT INTO companies (id, name, created_at, updated_at) VALUES (1, 'Kapphan & Partner PartG', ?, ?)`)
      .run(T, T);
    db.prepare(`INSERT INTO vehicles (id, plate, company_id, employee_name, created_at, updated_at)
                VALUES (1, 'TUT-MK-100', 1, 'Moritz', ?, ?)`).run(T, T);
    db.prepare(`INSERT INTO rfid_mappings (rfid, rfid_raw, vehicle_id, created_at, updated_at)
                VALUES (?, ?, 1, ?, ?)`).run(CARD, CARD, T, T);
    // Ein Vorgang mit der Karte, eingefroren auf das Auto, und einer im
    // freien Laden - der taucht bisher als Karte ohne Fahrzeug auf.
    db.prepare(`INSERT INTO charging_sessions
                  (id, start_at, end_at, energy_kwh, rfid, received_at, vehicle_id, company_id,
                   vehicle_plate, company_name, employee_name)
                VALUES ('s1', '2026-09-02T18:00:00.000Z', '2026-09-02T20:00:00.000Z', 12.5, ?, ?,
                        1, 1, 'TUT-MK-100', 'Kapphan & Partner PartG', 'Moritz')`).run(CARD, T);
    db.prepare(`INSERT INTO charging_sessions (id, start_at, end_at, energy_kwh, rfid, received_at)
                VALUES ('s2', '2026-09-03T18:00:00.000Z', '2026-09-03T19:00:00.000Z', 4.2, ?, ?)`)
      .run(FREE, T);
    db.close();
  });

  it('laeuft ueber den normalen Start durch und laesst die Datenbank konsistent', () => {
    const db = database.open(file);

    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
      .map((row) => row.version);
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('startet ohne laufendes Anlernen', () => {
    database.open(file);

    expect(cardLearning.status()).toMatchObject({ armed: false, capturedRfid: null });
  });

  it('laesst Zuordnungen und eingefrorene Vorgaenge unangetastet', () => {
    const db = database.open(file);

    expect(fleet.resolveAttribution(CARD).vehiclePlate).toBe('TUT-MK-100');
    expect(db.prepare('SELECT kind FROM rfid_mappings WHERE rfid = ?').get(CARD).kind).toBeNull();
    expect(db.prepare("SELECT vehicle_plate, company_name FROM charging_sessions WHERE id = 's1'").get())
      .toEqual({ vehicle_plate: 'TUT-MK-100', company_name: 'Kapphan & Partner PartG' });
  });

  it('erkennt das freie Laden in den vorhandenen Vorgaengen ohne weiteres Zutun', () => {
    database.open(file);

    const cards = fleet.listCards();
    expect(cards.find((c) => c.rfid === FREE)).toMatchObject({ isFreeCharging: true, assigned: false });
    expect(cards.find((c) => c.rfid === CARD)).toMatchObject({ isFreeCharging: false, assigned: true });
  });

  it('wendet beim naechsten Start nichts erneut an', () => {
    database.open(file);
    database.close();

    const db = database.open(file);
    expect(database.migrate(db)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM card_learning').get().n).toBe(1);
  });
});
