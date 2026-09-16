'use strict';

/**
 * Datenzugriff fuer Benutzerkonten.
 *
 * Enthaelt bewusst keine HTTP-Logik - die Routen rufen ausschliesslich diese
 * Funktionen auf, wodurch die Regeln (Sperren, letzter Admin, Rollen) an genau
 * einer Stelle stehen und testbar bleiben.
 */

const { db, now } = require('../db');
const config = require('../config');
const logger = require('../utils/logger');
const { hashPassword, verifyPassword, validatePassword } = require('../utils/password');

/** Spalten, die nach aussen gehen duerfen - der Hash gehoert nie dazu. */
const PUBLIC_COLUMNS = `
  id, username, display_name AS displayName, email, role,
  is_active AS isActive, must_change_password AS mustChangePassword,
  failed_attempts AS failedAttempts, locked_until AS lockedUntil,
  last_login_at AS lastLoginAt, created_at AS createdAt, updated_at AS updatedAt
`;

/** Wandelt SQLite-Integer in echte Booleans. */
function toPublic(row) {
  if (!row) return null;
  return {
    ...row,
    isActive: Boolean(row.isActive),
    mustChangePassword: Boolean(row.mustChangePassword),
    isLocked: Boolean(row.lockedUntil && new Date(row.lockedUntil) > new Date()),
  };
}

/** @returns {object[]} alle Konten, Administratoren zuerst */
function list() {
  return db()
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY role = 'admin' DESC, username COLLATE NOCASE`)
    .all()
    .map(toPublic);
}

/** @param {number} id */
function findById(id) {
  return toPublic(db().prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id));
}

/** @param {string} username */
function findByUsername(username) {
  return toPublic(db().prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE username = ?`).get(String(username || '')));
}

/** Interner Zugriff inklusive Hash - nur fuer die Anmeldung. */
function findWithHash(username) {
  return db().prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
}

/** @returns {number} Anzahl aktiver Administratoren */
function countActiveAdmins() {
  return db().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").get().n;
}

/** @returns {number} Gesamtzahl der Konten */
function count() {
  return db().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/** Fehler mit HTTP-Status, damit die Routen ihn unveraendert durchreichen koennen. */
function fail(message, status = 400) {
  return Object.assign(new Error(message), { status, code: 'bad_request' });
}

/**
 * Prueft einen Benutzernamen.
 * @param {string} username
 * @returns {string} normalisierter Name
 */
function normalizeUsername(username) {
  const value = String(username ?? '').trim();
  if (value.length < 3 || value.length > 64) {
    throw fail('Der Benutzername muss zwischen 3 und 64 Zeichen lang sein.');
  }
  if (!/^[a-zA-Z0-9._@-]+$/.test(value)) {
    throw fail('Der Benutzername darf nur Buchstaben, Ziffern und . _ - @ enthalten.');
  }
  return value;
}

/**
 * Legt ein Konto an.
 * @param {{username:string, password:string, role?:string, displayName?:string,
 *          email?:string, mustChangePassword?:boolean}} input
 * @returns {Promise<object>} das angelegte Konto (ohne Hash)
 */
async function create(input) {
  const username = normalizeUsername(input.username);
  const role = input.role === 'admin' ? 'admin' : 'viewer';

  const check = validatePassword(input.password, config.auth.minPasswordLength);
  if (!check.ok) throw fail(check.message);

  if (findByUsername(username)) {
    throw fail(`Der Benutzername "${username}" ist bereits vergeben.`, 409);
  }
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    throw fail('Ungültige E-Mail-Adresse.');
  }

  const timestamp = now();
  const result = db().prepare(`
    INSERT INTO users (username, display_name, email, password_hash, role,
                       is_active, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    username,
    String(input.displayName || '').trim().slice(0, 120),
    String(input.email || '').trim().slice(0, 200),
    await hashPassword(input.password),
    role,
    input.mustChangePassword ? 1 : 0,
    timestamp,
    timestamp
  );

  logger.info(`Benutzer "${username}" (${role}) angelegt.`);
  return findById(result.lastInsertRowid);
}

/**
 * Aendert Stammdaten und Rolle.
 * @param {number} id
 * @param {{displayName?:string, email?:string, role?:string, isActive?:boolean}} patch
 * @returns {object}
 */
function update(id, patch) {
  const user = findById(id);
  if (!user) throw fail('Benutzer nicht gefunden.', 404);

  const role = patch.role === undefined ? user.role : (patch.role === 'admin' ? 'admin' : 'viewer');
  const isActive = patch.isActive === undefined ? user.isActive : Boolean(patch.isActive);

  // Ohne diesen Schutz koennte man sich selbst aussperren und die Anwendung
  // waere nur noch ueber einen manuellen Eingriff in die Datenbank erreichbar.
  const losesAdmin = user.role === 'admin' && user.isActive && (role !== 'admin' || !isActive);
  if (losesAdmin && countActiveAdmins() <= 1) {
    throw fail('Das ist der letzte aktive Administrator - Rolle und Status lassen sich nicht ändern.', 409);
  }
  if (patch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) {
    throw fail('Ungültige E-Mail-Adresse.');
  }

  db().prepare(`
    UPDATE users SET display_name = ?, email = ?, role = ?, is_active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    patch.displayName === undefined ? user.displayName : String(patch.displayName).trim().slice(0, 120),
    patch.email === undefined ? user.email : String(patch.email).trim().slice(0, 200),
    role,
    isActive ? 1 : 0,
    now(),
    id
  );

  // Ein deaktiviertes Konto darf nicht mit einer offenen Sitzung weiterarbeiten.
  if (!isActive) db().prepare('DELETE FROM sessions WHERE user_id = ?').run(id);

  return findById(id);
}

/**
 * Setzt ein neues Passwort.
 * @param {number} id
 * @param {string} password
 * @param {{mustChange?:boolean, keepSessions?:boolean}} [options]
 * @returns {Promise<object>}
 */
async function setPassword(id, password, options = {}) {
  const user = findById(id);
  if (!user) throw fail('Benutzer nicht gefunden.', 404);

  const check = validatePassword(password, config.auth.minPasswordLength);
  if (!check.ok) throw fail(check.message);

  db().prepare(`
    UPDATE users
       SET password_hash = ?, must_change_password = ?, failed_attempts = 0,
           locked_until = NULL, updated_at = ?
     WHERE id = ?
  `).run(await hashPassword(password), options.mustChange ? 1 : 0, now(), id);

  // Ein Passwortwechsel beendet standardmaessig alle anderen Sitzungen -
  // genau das erwartet man, wenn das alte Passwort kompromittiert war.
  if (!options.keepSessions) db().prepare('DELETE FROM sessions WHERE user_id = ?').run(id);

  logger.info(`Passwort für "${user.username}" geändert.`);
  return findById(id);
}

/**
 * Loescht ein Konto.
 * @param {number} id
 * @returns {{deleted:boolean, username:string}}
 */
function remove(id) {
  const user = findById(id);
  if (!user) throw fail('Benutzer nicht gefunden.', 404);
  if (user.role === 'admin' && user.isActive && countActiveAdmins() <= 1) {
    throw fail('Der letzte aktive Administrator kann nicht gelöscht werden.', 409);
  }

  // Sitzungen haengen per ON DELETE CASCADE mit dran.
  db().prepare('DELETE FROM users WHERE id = ?').run(id);
  logger.info(`Benutzer "${user.username}" gelöscht.`);
  return { deleted: true, username: user.username };
}

/**
 * Prueft Zugangsdaten und pflegt Fehlversuchszaehler und Sperre.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ok:boolean, user?:object, reason?:'invalid'|'locked'|'disabled'}>}
 */
async function authenticate(username, password) {
  const row = findWithHash(username);

  // Auch ohne Treffer wird gehasht: sonst waere an der Antwortzeit ablesbar,
  // welche Benutzernamen existieren.
  if (!row) {
    await verifyPassword(String(password ?? ''), 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    return { ok: false, reason: 'invalid' };
  }

  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    return { ok: false, reason: 'locked', lockedUntil: row.locked_until };
  }
  if (!row.is_active) {
    return { ok: false, reason: 'disabled' };
  }

  if (!await verifyPassword(password, row.password_hash)) {
    const attempts = row.failed_attempts + 1;
    const lock = attempts >= config.auth.maxFailedAttempts
      ? new Date(Date.now() + config.auth.lockMinutes * 60_000).toISOString()
      : null;

    db().prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
      .run(attempts, lock, now(), row.id);

    if (lock) logger.warn(`Konto "${row.username}" nach ${attempts} Fehlversuchen bis ${lock} gesperrt.`);
    return { ok: false, reason: lock ? 'locked' : 'invalid', lockedUntil: lock };
  }

  db().prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?')
    .run(now(), now(), row.id);

  return { ok: true, user: findById(row.id) };
}

/**
 * Legt beim allerersten Start den Administrator aus der ENV an.
 * Laeuft nur, solange die Tabelle leer ist - danach ist die Datenbank fuehrend.
 *
 * @returns {Promise<object|null>} der angelegte Benutzer oder null
 */
async function ensureBootstrapAdmin() {
  if (count() > 0) return null;

  if (!config.auth.password) {
    throw new Error(
      'Die Benutzertabelle ist leer und AUTH_PASSWORD ist nicht gesetzt. ' +
      'Ohne Start-Administrator kann sich niemand anmelden.'
    );
  }

  const check = validatePassword(config.auth.password, config.auth.minPasswordLength);
  if (!check.ok) {
    throw new Error(`AUTH_PASSWORD ist als Start-Passwort ungeeignet: ${check.message}`);
  }

  const user = await create({
    username: config.auth.user,
    password: config.auth.password,
    role: 'admin',
    displayName: 'Administrator',
  });

  logger.info(`Start-Administrator "${user.username}" aus der ENV angelegt.`);
  return user;
}

module.exports = {
  list, findById, findByUsername, count, countActiveAdmins,
  create, update, setPassword, remove, authenticate, ensureBootstrapAdmin,
  normalizeUsername,
};
