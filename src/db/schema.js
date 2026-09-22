'use strict';

/**
 * Datenbankschema als versionierte Migrationen.
 *
 * Jede Migration laeuft genau einmal und wird in `schema_migrations` vermerkt.
 * Neue Aenderungen kommen als NEUER Eintrag ans Ende - bestehende Migrationen
 * werden nie nachtraeglich veraendert, sonst laufen frische und bestehende
 * Installationen auseinander.
 */

/** @type {{version:number, name:string, up:string}[]} */
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial',
    up: `
      -- ---------------------------------------------------------------- Nutzer
      CREATE TABLE users (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        -- COLLATE NOCASE: "Admin" und "admin" sind derselbe Login.
        username             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        display_name         TEXT    NOT NULL DEFAULT '',
        email                TEXT    NOT NULL DEFAULT '',
        password_hash        TEXT    NOT NULL,
        role                 TEXT    NOT NULL DEFAULT 'viewer'
                                     CHECK (role IN ('admin', 'viewer')),
        is_active            INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        failed_attempts      INTEGER NOT NULL DEFAULT 0,
        locked_until         TEXT,
        last_login_at        TEXT,
        created_at           TEXT    NOT NULL,
        updated_at           TEXT    NOT NULL
      );

      -- -------------------------------------------------------------- Sitzungen
      -- id ist der SHA-256 des Cookie-Tokens: wer die DB liest, kann daraus
      -- kein gueltiges Cookie rekonstruieren.
      CREATE TABLE sessions (
        id           TEXT    PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token   TEXT    NOT NULL,
        user_agent   TEXT    NOT NULL DEFAULT '',
        ip           TEXT    NOT NULL DEFAULT '',
        created_at   TEXT    NOT NULL,
        last_seen_at TEXT    NOT NULL,
        expires_at   TEXT    NOT NULL
      );
      CREATE INDEX idx_sessions_user    ON sessions(user_id);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      -- ----------------------------------------------------------- Einstellungen
      -- Key/Value mit JSON-Werten: ein Zweig je Schluessel ("billing", "mail", ...).
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );

      -- ------------------------------------------------------------ RFID-Karten
      -- Eigene Tabelle statt JSON-Blob: so laesst sich je Karte sauber
      -- nachschlagen und ein UNIQUE auf der normalisierten ID erzwingen.
      CREATE TABLE rfid_mappings (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        rfid       TEXT    NOT NULL UNIQUE,
        rfid_raw   TEXT    NOT NULL DEFAULT '',
        name       TEXT    NOT NULL DEFAULT '',
        plate      TEXT    NOT NULL DEFAULT '',
        billable   INTEGER NOT NULL DEFAULT 1,
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL
      );

      -- --------------------------------------------------------------- Protokoll
      CREATE TABLE audit_log (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       TEXT    NOT NULL,
        user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        username TEXT    NOT NULL DEFAULT '',
        action   TEXT    NOT NULL,
        detail   TEXT    NOT NULL DEFAULT '',
        ip       TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_audit_at ON audit_log(at DESC);

      -- ------------------------------------------------------------ Report-Laeufe
      CREATE TABLE report_runs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        period_key        TEXT    NOT NULL,
        started_at        TEXT    NOT NULL,
        finished_at       TEXT,
        ok                INTEGER NOT NULL DEFAULT 0,
        session_count     INTEGER,
        energy_kwh        REAL,
        cost              REAL,
        pdf_file          TEXT,
        csv_detail_file   TEXT,
        csv_summary_file  TEXT,
        mail_to           TEXT    NOT NULL DEFAULT '',
        message_id        TEXT    NOT NULL DEFAULT '',
        error             TEXT    NOT NULL DEFAULT '',
        triggered_by      TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_runs_period ON report_runs(period_key);
      CREATE INDEX idx_runs_started ON report_runs(started_at DESC);
    `,
  },
  {
    version: 2,
    name: 'connector-ingest',
    up: `
      -- ------------------------------------------------------- Ladevorgänge
      -- Vom Connector aus dem Heimnetz gelieferte, abgeschlossene Ladevorgänge.
      -- Die ID stammt aus der Wallbox; ein erneutes Senden aktualisiert den
      -- Datensatz, statt ihn zu verdoppeln.
      CREATE TABLE charging_sessions (
        id               TEXT    PRIMARY KEY,
        start_at         TEXT    NOT NULL,
        end_at           TEXT,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        energy_kwh       REAL    NOT NULL,
        rfid             TEXT    NOT NULL DEFAULT 'unbekannt',
        rfid_raw         TEXT    NOT NULL DEFAULT '',
        meter_start_kwh  REAL,
        meter_end_kwh    REAL,
        source           TEXT    NOT NULL DEFAULT 'connector',
        received_at      TEXT    NOT NULL,
        -- Rohdatensatz der Wallbox, damit sich eine Abweichung später
        -- nachvollziehen lässt, ohne die Wallbox erneut zu befragen.
        payload          TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_charging_start ON charging_sessions(start_at);
      CREATE INDEX idx_charging_rfid  ON charging_sessions(rfid);

      -- ---------------------------------------------------- Connector-Zustand
      -- Genau eine Zeile: der zuletzt gemeldete Live-Zustand und wann sich der
      -- Connector zuletzt gemeldet hat.
      CREATE TABLE connector_state (
        id                INTEGER PRIMARY KEY CHECK (id = 1),
        last_seen_at      TEXT,
        last_status       TEXT NOT NULL DEFAULT '',
        connector_version TEXT NOT NULL DEFAULT '',
        remote_ip         TEXT NOT NULL DEFAULT '',
        sessions_received INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO connector_state (id) VALUES (1);
    `,
  },
  {
    version: 3,
    name: 'fleet',
    up: `
      -- =====================================================================
      --  Fuhrpark: Firma -> Mitarbeiter -> Fahrzeug -> Karte(n)
      --
      --  Bisher trug die Karte selbst Name und Kennzeichen. Das reicht fuer
      --  ein Auto, bricht aber, sobald mehrere Fahrzeuge, Arbeitgeber und
      --  Mitarbeiter abzurechnen sind: ein Fahrzeug hat oft mehrere Karten,
      --  ein Mitarbeiter wechselt das Fahrzeug, und eine Firma braucht ihre
      --  eigene Rechnung an ihre eigene Anschrift.
      -- =====================================================================

      CREATE TABLE companies (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL,
        -- 'private' ist bewusst eine Firma und kein Sonderfall im Code:
        -- sonst zieht sich eine Fallunterscheidung durch jede Abfrage.
        kind          TEXT    NOT NULL DEFAULT 'company' CHECK (kind IN ('company','private')),
        address       TEXT    NOT NULL DEFAULT '',
        contact_email TEXT    NOT NULL DEFAULT '',
        -- NULL = globaler Arbeitspreis aus den Einstellungen. Arbeitgeber
        -- erstatten unterschiedlich, deshalb je Firma uebersteuerbar.
        price_per_kwh REAL,
        -- Eigener Monatsbericht per Mail an contact_email? Sonst erscheint
        -- die Firma nur in der Gesamtuebersicht.
        own_report    INTEGER NOT NULL DEFAULT 1,
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL
      );
      CREATE UNIQUE INDEX idx_companies_name ON companies(name);

      CREATE TABLE employees (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        company_id   INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        personnel_no TEXT    NOT NULL DEFAULT '',
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
      );
      CREATE INDEX idx_employees_company ON employees(company_id);

      CREATE TABLE vehicles (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        plate       TEXT    NOT NULL,
        label       TEXT    NOT NULL DEFAULT '',
        company_id  INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        notes       TEXT    NOT NULL DEFAULT '',
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
      );
      CREATE UNIQUE INDEX idx_vehicles_plate ON vehicles(plate);
      CREATE INDEX idx_vehicles_company ON vehicles(company_id);

      -- Eine Karte gehoert zu hoechstens einem Fahrzeug, ein Fahrzeug kann
      -- mehrere Karten haben.
      ALTER TABLE rfid_mappings ADD COLUMN vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL;
      CREATE INDEX idx_rfid_vehicle ON rfid_mappings(vehicle_id);

      -- ------------------------------------------------------------------
      --  Zuordnung wird auf dem Ladevorgang EINGEFROREN, nicht spaeter
      --  nachgeschlagen. Sonst aendert jede Umbuchung rueckwirkend bereits
      --  gestellte Rechnungen, und eine geloeschte Firma zerlegt den
      --  Vorjahresbeleg. Die Klartextspalten ueberleben deshalb auch das
      --  Loeschen des jeweiligen Stammdatensatzes.
      -- ------------------------------------------------------------------
      ALTER TABLE charging_sessions ADD COLUMN vehicle_id    INTEGER REFERENCES vehicles(id) ON DELETE SET NULL;
      ALTER TABLE charging_sessions ADD COLUMN company_id    INTEGER REFERENCES companies(id) ON DELETE SET NULL;
      ALTER TABLE charging_sessions ADD COLUMN employee_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL;
      ALTER TABLE charging_sessions ADD COLUMN vehicle_plate TEXT NOT NULL DEFAULT '';
      ALTER TABLE charging_sessions ADD COLUMN company_name  TEXT NOT NULL DEFAULT '';
      ALTER TABLE charging_sessions ADD COLUMN employee_name TEXT NOT NULL DEFAULT '';
      CREATE INDEX idx_charging_company  ON charging_sessions(company_id);
      CREATE INDEX idx_charging_vehicle  ON charging_sessions(vehicle_id);
      CREATE INDEX idx_charging_employee ON charging_sessions(employee_id);

      -- Ein Bericht gilt kuenftig fuer alles, eine Firma, ein Fahrzeug oder
      -- einen Mitarbeiter.
      ALTER TABLE report_runs ADD COLUMN scope_kind  TEXT NOT NULL DEFAULT 'all';
      ALTER TABLE report_runs ADD COLUMN scope_id    INTEGER;
      ALTER TABLE report_runs ADD COLUMN scope_label TEXT NOT NULL DEFAULT '';

      -- =================================================== Bestand uebernehmen
      -- "Privat" gibt es immer; ohne eigenen Bericht, denn an sich selbst
      -- schickt man keine Rechnung.
      INSERT INTO companies (name, kind, own_report, created_at, updated_at)
      VALUES ('Privat', 'private', 0,
              strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

      -- Der bisherige COMPANY_NAME aus den Einstellungen wird zur ersten Firma.
      INSERT INTO companies (name, kind, created_at, updated_at)
      SELECT json_extract(value, '$.companyName'), 'company',
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM settings
      WHERE key = 'billing'
        AND COALESCE(json_extract(value, '$.companyName'), '') <> ''
        AND json_extract(value, '$.companyName') <> 'Privat';

      -- Jeder Kartenname wird ein Mitarbeiter dieser Firma.
      INSERT INTO employees (name, company_id, created_at, updated_at)
      SELECT DISTINCT m.name,
             (SELECT id FROM companies WHERE kind = 'company' ORDER BY id LIMIT 1),
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM rfid_mappings m
      WHERE COALESCE(m.name, '') <> '';

      -- Jedes Kennzeichen wird ein Fahrzeug. Mehrere Karten mit demselben
      -- Kennzeichen ergeben EIN Fahrzeug - genau der Fall, den das alte
      -- Modell nicht ausdruecken konnte.
      INSERT INTO vehicles (plate, label, company_id, employee_id, created_at, updated_at)
      SELECT g.plate, '',
             (SELECT id FROM companies WHERE kind = 'company' ORDER BY id LIMIT 1),
             (SELECT e.id FROM employees e WHERE e.name = g.name),
             strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM (
        SELECT plate, MIN(name) AS name
        FROM rfid_mappings
        WHERE COALESCE(plate, '') <> ''
        GROUP BY plate
      ) g;

      UPDATE rfid_mappings
      SET vehicle_id = (SELECT v.id FROM vehicles v WHERE v.plate = rfid_mappings.plate)
      WHERE COALESCE(plate, '') <> '';

      -- Bereits eingegangene Ladevorgaenge bekommen die Zuordnung nachgetragen.
      UPDATE charging_sessions
      SET vehicle_id = (SELECT m.vehicle_id FROM rfid_mappings m WHERE m.rfid = charging_sessions.rfid)
      WHERE EXISTS (
        SELECT 1 FROM rfid_mappings m
        WHERE m.rfid = charging_sessions.rfid AND m.vehicle_id IS NOT NULL
      );

      UPDATE charging_sessions
      SET company_id    = (SELECT v.company_id  FROM vehicles v WHERE v.id = charging_sessions.vehicle_id),
          employee_id   = (SELECT v.employee_id FROM vehicles v WHERE v.id = charging_sessions.vehicle_id),
          vehicle_plate = COALESCE((SELECT v.plate FROM vehicles v WHERE v.id = charging_sessions.vehicle_id), ''),
          company_name  = COALESCE((SELECT c.name FROM companies c
                                      JOIN vehicles v ON v.company_id = c.id
                                     WHERE v.id = charging_sessions.vehicle_id), ''),
          employee_name = COALESCE((SELECT e.name FROM employees e
                                      JOIN vehicles v ON v.employee_id = e.id
                                     WHERE v.id = charging_sessions.vehicle_id), '')
      WHERE vehicle_id IS NOT NULL;
    `,
  },
];


module.exports = { MIGRATIONS };
