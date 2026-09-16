'use strict';

/**
 * SQLite-Anbindung.
 *
 * better-sqlite3 statt node:sqlite: letzteres ist in Node 22 als experimentell
 * markiert ("might change at any time") und auf Node 20 gar nicht vorhanden.
 * better-sqlite3 arbeitet synchron - bei einer Single-User-Appliance mit
 * Millisekunden-Queries ist das einfacher und schneller als ein Async-Treiber,
 * weil kein Verbindungspool und keine Transaktionsverschachtelung noetig sind.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../utils/logger');
const { MIGRATIONS } = require('./schema');

/** @type {import('better-sqlite3').Database|null} */
let connection = null;

/**
 * Oeffnet die Datenbank (idempotent) und fuehrt ausstehende Migrationen aus.
 * @param {string} [file] Pfad zur Datei, ':memory:' fuer Tests
 * @returns {import('better-sqlite3').Database}
 */
function open(file = config.server.databaseFile) {
  if (connection) return connection;

  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  connection = new Database(file);

  // WAL: Leser blockieren den Schreiber nicht. Das Dashboard liest waehrend
  // eines laufenden Reports - ohne WAL gaebe es SQLITE_BUSY.
  if (file !== ':memory:') connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  // Bei parallelem Zugriff lieber kurz warten als sofort scheitern.
  connection.pragma('busy_timeout = 5000');
  // NORMAL statt FULL: mit WAL weiterhin crash-sicher, aber deutlich weniger fsync.
  connection.pragma('synchronous = NORMAL');

  migrate(connection);
  return connection;
}

/**
 * Fuehrt alle noch nicht angewandten Migrationen in einer Transaktion aus.
 * @param {import('better-sqlite3').Database} db
 * @returns {number} Anzahl angewandter Migrationen
 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version)
  );

  const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version));
  if (pending.length === 0) return 0;

  const runAll = db.transaction((migrations) => {
    for (const migration of migrations) {
      db.exec(migration.up);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      logger.info(`Migration ${migration.version} (${migration.name}) angewendet.`);
    }
  });

  runAll(pending);
  return pending.length;
}

/**
 * Liefert die offene Verbindung; oeffnet sie bei Bedarf.
 * @returns {import('better-sqlite3').Database}
 */
function db() {
  return connection || open();
}

/** Schliesst die Verbindung (Shutdown, Tests). */
function close() {
  if (!connection) return;
  try {
    connection.close();
  } catch (error) {
    logger.warn(`Datenbank konnte nicht sauber geschlossen werden: ${error.message}`);
  } finally {
    connection = null;
  }
}

/**
 * Fuehrt eine Funktion in einer Transaktion aus.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function transaction(fn) {
  return db().transaction(fn)();
}

/** ISO-Zeitstempel - einheitliches Format fuer alle TEXT-Datumsspalten. */
function now() {
  return new Date().toISOString();
}

module.exports = { open, close, db, migrate, transaction, now };
