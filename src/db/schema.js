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
];

module.exports = { MIGRATIONS };
