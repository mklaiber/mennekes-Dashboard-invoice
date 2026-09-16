'use strict';

const sessions = require('../src/repositories/sessionRepository');
const users = require('../src/repositories/userRepository');
const database = require('../src/db');
const { hashToken } = require('../src/utils/password');
const { resetDatabase } = require('./helpers/testDb');

let user;

beforeEach(async () => {
  resetDatabase();
  user = await users.create({ username: 'anna', password: 'test-passwort-1234', role: 'admin' });
});

describe('create', () => {
  it('liefert Token, CSRF-Token und Ablaufzeitpunkt', () => {
    const created = sessions.create({ userId: user.id });

    expect(created.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(created.csrfToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('speichert nur den Hash des Tokens, nie das Token selbst', () => {
    const { token } = sessions.create({ userId: user.id });

    const rows = database.db().prepare('SELECT id FROM sessions').all();
    expect(rows[0].id).toBe(hashToken(token));
    expect(rows[0].id).not.toBe(token);
  });

  it('verlängert die Gültigkeit bei "angemeldet bleiben"', () => {
    const normal = sessions.create({ userId: user.id });
    const remembered = sessions.create({ userId: user.id, remember: true });

    expect(remembered.expiresAt.getTime()).toBeGreaterThan(normal.expiresAt.getTime());
  });

  it('merkt sich Gerät und IP für die Kontoübersicht', () => {
    sessions.create({ userId: user.id, userAgent: 'Firefox/1.0', ip: '192.168.1.5' });

    expect(sessions.listForUser(user.id)[0]).toMatchObject({
      userAgent: 'Firefox/1.0', ip: '192.168.1.5',
    });
  });
});

describe('resolve', () => {
  it('löst ein gültiges Token auf', () => {
    const { token, csrfToken } = sessions.create({ userId: user.id });
    const resolved = sessions.resolve(token);

    expect(resolved.user).toMatchObject({ id: user.id, username: 'anna', role: 'admin' });
    expect(resolved.session.csrfToken).toBe(csrfToken);
  });

  it('weist unbekannte und leere Token ab', () => {
    expect(sessions.resolve('gibtesnicht')).toBeNull();
    expect(sessions.resolve('')).toBeNull();
    expect(sessions.resolve(undefined)).toBeNull();
  });

  it('weist abgelaufene Sitzungen ab und räumt sie weg', () => {
    const { token } = sessions.create({ userId: user.id });
    database.db().prepare("UPDATE sessions SET expires_at = datetime('now', '-1 hour')").run();

    expect(sessions.resolve(token)).toBeNull();
    // Der Eintrag wird beim Auflösen gleich mit entfernt.
    expect(database.db().prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
  });

  it('weist Sitzungen deaktivierter Konten ab', async () => {
    await users.create({ username: 'zweiter', password: 'test-passwort-1234', role: 'admin' });
    const { token } = sessions.create({ userId: user.id });

    users.update(user.id, { isActive: false });

    expect(sessions.resolve(token)).toBeNull();
  });

  it('gibt den Passwortwechsel-Zwang durch', async () => {
    const fresh = await users.create({
      username: 'neuling', password: 'test-passwort-1234', mustChangePassword: true,
    });
    const { token } = sessions.create({ userId: fresh.id });

    expect(sessions.resolve(token).user.mustChangePassword).toBe(true);
  });
});

describe('destroy', () => {
  it('beendet eine einzelne Sitzung', () => {
    const { token } = sessions.create({ userId: user.id });
    sessions.destroyByToken(token);

    expect(sessions.resolve(token)).toBeNull();
  });

  it('ist bei unbekanntem Token ein No-Op', () => {
    expect(() => sessions.destroyByToken('gibtesnicht')).not.toThrow();
    expect(() => sessions.destroyByToken(undefined)).not.toThrow();
  });

  it('beendet alle Sitzungen eines Benutzers', async () => {
    sessions.create({ userId: user.id });
    sessions.create({ userId: user.id });
    const other = await users.create({ username: 'bert', password: 'test-passwort-1234' });
    sessions.create({ userId: other.id });

    expect(sessions.destroyAllForUser(user.id)).toBe(2);
    expect(sessions.listForUser(user.id)).toHaveLength(0);
    // Fremde Sitzungen bleiben unberührt.
    expect(sessions.listForUser(other.id)).toHaveLength(1);
  });
});

describe('purgeExpired', () => {
  it('entfernt nur abgelaufene Sitzungen', () => {
    const valid = sessions.create({ userId: user.id });
    sessions.create({ userId: user.id });
    database.db().prepare("UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE id != ?")
      .run(hashToken(valid.token));

    expect(sessions.purgeExpired()).toBe(1);
    expect(sessions.resolve(valid.token)).not.toBeNull();
  });

  it('meldet 0, wenn nichts abgelaufen ist', () => {
    sessions.create({ userId: user.id });
    expect(sessions.purgeExpired()).toBe(0);
  });
});
