'use strict';

/**
 * Serverseitige Sitzungen.
 *
 * Bewusst keine JWTs: eine Sitzung muss sich sofort widerrufen lassen
 * (Benutzer deaktivieren, Passwort geaendert, "überall abmelden"). Mit einem
 * signierten Token ginge das nur ueber eine zusaetzliche Sperrliste - also
 * genau die Tabelle, die man damit sparen wollte.
 *
 * In der Datenbank liegt nur der SHA-256 des Cookie-Tokens.
 */

const { db, now } = require('../db');
const config = require('../config');
const logger = require('../utils/logger');
const { randomToken, hashToken } = require('../utils/password');

/**
 * Erzeugt eine Sitzung.
 * @param {object} params
 * @param {number} params.userId
 * @param {string} [params.userAgent]
 * @param {string} [params.ip]
 * @param {boolean} [params.remember] laengere Lebensdauer
 * @returns {{token:string, csrfToken:string, expiresAt:Date}}
 */
function create({ userId, userAgent = '', ip = '', remember = false }) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);

  const ttlMs = remember
    ? config.auth.rememberTtlDays * 24 * 60 * 60 * 1000
    : config.auth.sessionTtlHours * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);

  db().prepare(`
    INSERT INTO sessions (id, user_id, csrf_token, user_agent, ip, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    hashToken(token), userId, csrfToken,
    String(userAgent).slice(0, 255), String(ip).slice(0, 64),
    now(), now(), expiresAt.toISOString()
  );

  return { token, csrfToken, expiresAt };
}

/**
 * Loest ein Cookie-Token auf und liefert Sitzung samt Benutzer.
 * Abgelaufene oder zu deaktivierten Konten gehoerende Sitzungen gelten als ungueltig.
 *
 * @param {string} token
 * @returns {{session:object, user:object}|null}
 */
function resolve(token) {
  if (!token) return null;

  const row = db().prepare(`
    SELECT s.id, s.user_id AS userId, s.csrf_token AS csrfToken, s.expires_at AS expiresAt,
           u.username, u.display_name AS displayName, u.email, u.role,
           u.is_active AS isActive, u.must_change_password AS mustChangePassword
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.id = ?
  `).get(hashToken(token));

  if (!row) return null;

  if (new Date(row.expiresAt) <= new Date()) {
    // Abgelaufenes direkt entfernen statt nur zu ignorieren.
    db().prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }
  if (!row.isActive) {
    db().prepare('DELETE FROM sessions WHERE user_id = ?').run(row.userId);
    return null;
  }

  return {
    session: { id: row.id, csrfToken: row.csrfToken, expiresAt: row.expiresAt },
    user: {
      id: row.userId,
      username: row.username,
      displayName: row.displayName,
      email: row.email,
      role: row.role,
      isActive: true,
      mustChangePassword: Boolean(row.mustChangePassword),
    },
  };
}

/**
 * Aktualisiert den Zeitstempel des letzten Zugriffs.
 * Nur einmal pro Minute, damit nicht jeder SSE-Frame einen Schreibvorgang ausloest.
 * @param {string} sessionId
 */
function touch(sessionId) {
  db().prepare(`
    UPDATE sessions SET last_seen_at = ?
     WHERE id = ? AND last_seen_at < datetime('now', '-1 minute')
  `).run(now(), sessionId);
}

/** @param {string} token */
function destroyByToken(token) {
  if (!token) return;
  db().prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
}

/** Alle Sitzungen eines Benutzers beenden. @param {number} userId */
function destroyAllForUser(userId) {
  const info = db().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return info.changes;
}

/**
 * Offene Sitzungen eines Benutzers (fuer die Kontoansicht).
 * @param {number} userId
 */
function listForUser(userId) {
  return db().prepare(`
    SELECT id, user_agent AS userAgent, ip, created_at AS createdAt,
           last_seen_at AS lastSeenAt, expires_at AS expiresAt
      FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC
  `).all(userId);
}

/**
 * Entfernt abgelaufene Sitzungen.
 * @returns {number} Anzahl entfernter Eintraege
 */
function purgeExpired() {
  const info = db().prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  if (info.changes > 0) logger.debug(`${info.changes} abgelaufene Sitzung(en) entfernt.`);
  return info.changes;
}

module.exports = {
  create, resolve, touch, destroyByToken, destroyAllForUser, listForUser, purgeExpired,
};
