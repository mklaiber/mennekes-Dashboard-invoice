'use strict';

const users = require('../src/repositories/userRepository');
const sessions = require('../src/repositories/sessionRepository');
const database = require('../src/db');
const config = require('../src/config');
const { resetDatabase } = require('./helpers/testDb');

const PASSWORD = 'test-passwort-1234';

beforeEach(() => {
  resetDatabase();
});

describe('create', () => {
  it('legt ein Konto mit Standardrolle "viewer" an', async () => {
    const user = await users.create({ username: 'neuer', password: PASSWORD });

    expect(user).toMatchObject({ username: 'neuer', role: 'viewer', isActive: true });
    expect(user.id).toBeGreaterThan(0);
  });

  it('gibt niemals den Passwort-Hash heraus', async () => {
    const user = await users.create({ username: 'neuer', password: PASSWORD });

    expect(user.password_hash).toBeUndefined();
    expect(user.passwordHash).toBeUndefined();
    expect(JSON.stringify(user)).not.toContain(PASSWORD);
  });

  it('speichert den Hash, nicht das Klartextpasswort', async () => {
    await users.create({ username: 'neuer', password: PASSWORD });

    const row = database.db().prepare('SELECT password_hash FROM users WHERE username = ?').get('neuer');
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain(PASSWORD);
  });

  it('verhindert doppelte Benutzernamen - auch mit anderer Schreibweise', async () => {
    await users.create({ username: 'Anna', password: PASSWORD });

    await expect(users.create({ username: 'Anna', password: PASSWORD })).rejects.toThrow('bereits vergeben');
    await expect(users.create({ username: 'anna', password: PASSWORD })).rejects.toThrow('bereits vergeben');
  });

  it.each([
    ['ab', 'zu kurz'],
    ['a'.repeat(65), 'zu lang'],
    ['mit leerzeichen', 'Leerzeichen'],
    ['mit/schrägstrich', 'Sonderzeichen'],
    ['<script>', 'HTML'],
  ])('weist den Benutzernamen "%s" ab (%s)', async (username) => {
    await expect(users.create({ username, password: PASSWORD })).rejects.toThrow();
  });

  it('erzwingt die Passwort-Mindestlänge', async () => {
    await expect(users.create({ username: 'neuer', password: 'kurz' })).rejects.toThrow('mindestens');
  });

  it('prüft die E-Mail-Adresse', async () => {
    await expect(users.create({ username: 'neuer', password: PASSWORD, email: 'keine-mail' }))
      .rejects.toThrow('E-Mail');
  });

  it('kann einen Passwortwechsel erzwingen', async () => {
    const user = await users.create({ username: 'neuer', password: PASSWORD, mustChangePassword: true });
    expect(user.mustChangePassword).toBe(true);
  });
});

describe('authenticate', () => {
  beforeEach(async () => {
    await users.create({ username: 'anna', password: PASSWORD, role: 'admin' });
  });

  it('bestätigt gültige Zugangsdaten', async () => {
    const result = await users.authenticate('anna', PASSWORD);

    expect(result.ok).toBe(true);
    expect(result.user.username).toBe('anna');
  });

  it('ignoriert die Groß-/Kleinschreibung des Benutzernamens', async () => {
    expect((await users.authenticate('ANNA', PASSWORD)).ok).toBe(true);
  });

  it('weist ein falsches Passwort ab', async () => {
    const result = await users.authenticate('anna', 'falsch');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid');
  });

  it('meldet dieselbe Begründung für unbekannte Konten', async () => {
    // Sonst wäre die Existenz eines Benutzernamens abfragbar.
    expect((await users.authenticate('gibtesnicht', 'egal')).reason).toBe('invalid');
  });

  it('zählt Fehlversuche und setzt sie nach Erfolg zurück', async () => {
    await users.authenticate('anna', 'falsch');
    await users.authenticate('anna', 'falsch');
    expect(users.findByUsername('anna').failedAttempts).toBe(2);

    await users.authenticate('anna', PASSWORD);
    expect(users.findByUsername('anna').failedAttempts).toBe(0);
  });

  it('sperrt nach der konfigurierten Anzahl Fehlversuche', async () => {
    for (let attempt = 0; attempt < config.auth.maxFailedAttempts; attempt += 1) {
      await users.authenticate('anna', 'falsch');
    }

    const result = await users.authenticate('anna', PASSWORD);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('locked');
    expect(users.findByUsername('anna').isLocked).toBe(true);
  });

  it('lässt ein deaktiviertes Konto nicht herein', async () => {
    // Zweiter Administrator, sonst greift der Schutz für den letzten Admin.
    await users.create({ username: 'zweiter', password: PASSWORD, role: 'admin' });
    users.update(users.findByUsername('anna').id, { isActive: false });

    expect((await users.authenticate('anna', PASSWORD)).reason).toBe('disabled');
  });

  it('vermerkt den Zeitpunkt der letzten Anmeldung', async () => {
    expect(users.findByUsername('anna').lastLoginAt).toBeNull();

    await users.authenticate('anna', PASSWORD);
    expect(users.findByUsername('anna').lastLoginAt).not.toBeNull();
  });
});

describe('update', () => {
  it('ändert Stammdaten und Rolle', async () => {
    const user = await users.create({ username: 'anna', password: PASSWORD });
    const updated = users.update(user.id, { displayName: 'Anna A.', role: 'admin' });

    expect(updated).toMatchObject({ displayName: 'Anna A.', role: 'admin' });
  });

  it('schützt den letzten aktiven Administrator vor Rollenverlust', async () => {
    const admin = await users.create({ username: 'chef', password: PASSWORD, role: 'admin' });

    expect(() => users.update(admin.id, { role: 'viewer' })).toThrow('letzte aktive Administrator');
    expect(() => users.update(admin.id, { isActive: false })).toThrow('letzte aktive Administrator');
  });

  it('erlaubt die Herabstufung, sobald ein zweiter Administrator existiert', async () => {
    const first = await users.create({ username: 'chef', password: PASSWORD, role: 'admin' });
    await users.create({ username: 'chefin', password: PASSWORD, role: 'admin' });

    expect(users.update(first.id, { role: 'viewer' }).role).toBe('viewer');
  });

  it('beendet die Sitzungen eines deaktivierten Kontos', async () => {
    const admin = await users.create({ username: 'chef', password: PASSWORD, role: 'admin' });
    const user = await users.create({ username: 'anna', password: PASSWORD });
    sessions.create({ userId: user.id });
    expect(sessions.listForUser(user.id)).toHaveLength(1);

    users.update(user.id, { isActive: false });

    expect(sessions.listForUser(user.id)).toHaveLength(0);
    // Die Sitzung des Administrators bleibt unberührt.
    expect(users.findById(admin.id).isActive).toBe(true);
  });
});

describe('setPassword', () => {
  it('setzt ein neues Passwort und beendet offene Sitzungen', async () => {
    const user = await users.create({ username: 'anna', password: PASSWORD });
    sessions.create({ userId: user.id });

    await users.setPassword(user.id, 'ganz-neues-passwort');

    expect((await users.authenticate('anna', 'ganz-neues-passwort')).ok).toBe(true);
    expect((await users.authenticate('anna', PASSWORD)).ok).toBe(false);
    expect(sessions.listForUser(user.id)).toHaveLength(0);
  });

  it('kann die eigene Sitzung erhalten', async () => {
    const user = await users.create({ username: 'anna', password: PASSWORD });
    sessions.create({ userId: user.id });

    await users.setPassword(user.id, 'ganz-neues-passwort', { keepSessions: true });

    expect(sessions.listForUser(user.id)).toHaveLength(1);
  });

  it('hebt eine Sperre auf', async () => {
    const user = await users.create({ username: 'anna', password: PASSWORD });
    for (let attempt = 0; attempt < config.auth.maxFailedAttempts; attempt += 1) {
      await users.authenticate('anna', 'falsch');
    }
    expect(users.findById(user.id).isLocked).toBe(true);

    await users.setPassword(user.id, 'ganz-neues-passwort');

    expect(users.findById(user.id).isLocked).toBe(false);
    expect(users.findById(user.id).failedAttempts).toBe(0);
  });

  it('erzwingt die Mindestlänge', async () => {
    const user = await users.create({ username: 'anna', password: PASSWORD });
    await expect(users.setPassword(user.id, 'kurz')).rejects.toThrow('mindestens');
  });
});

describe('remove', () => {
  it('löscht ein Konto samt Sitzungen', async () => {
    await users.create({ username: 'chef', password: PASSWORD, role: 'admin' });
    const user = await users.create({ username: 'anna', password: PASSWORD });
    sessions.create({ userId: user.id });

    users.remove(user.id);

    expect(users.findById(user.id)).toBeNull();
    // ON DELETE CASCADE räumt die Sitzungen mit ab.
    expect(sessions.listForUser(user.id)).toHaveLength(0);
  });

  it('schützt den letzten aktiven Administrator', async () => {
    const admin = await users.create({ username: 'chef', password: PASSWORD, role: 'admin' });
    expect(() => users.remove(admin.id)).toThrow('letzte aktive Administrator');
  });

  it('meldet ein unbekanntes Konto', () => {
    expect(() => users.remove(9999)).toThrow('nicht gefunden');
  });
});

describe('ensureBootstrapAdmin', () => {
  it('legt beim ersten Start den Administrator aus der ENV an', async () => {
    const created = await users.ensureBootstrapAdmin();

    expect(created).toMatchObject({ username: config.auth.user, role: 'admin' });
    expect((await users.authenticate(config.auth.user, config.auth.password)).ok).toBe(true);
  });

  it('läuft kein zweites Mal', async () => {
    await users.ensureBootstrapAdmin();
    expect(await users.ensureBootstrapAdmin()).toBeNull();
    expect(users.count()).toBe(1);
  });

  it('greift nicht mehr, sobald ein beliebiges Konto existiert', async () => {
    // Wichtig: sonst käme nach dem Löschen des ENV-Admins bei jedem Neustart
    // ein Konto mit dem alten Passwort zurück.
    await users.create({ username: 'anna', password: PASSWORD, role: 'admin' });

    expect(await users.ensureBootstrapAdmin()).toBeNull();
    expect(users.findByUsername(config.auth.user)).toBeNull();
  });

  it('bricht ab, wenn AUTH_PASSWORD fehlt', async () => {
    const original = config.auth.password;
    config.auth.password = undefined;
    try {
      await expect(users.ensureBootstrapAdmin()).rejects.toThrow('AUTH_PASSWORD');
    } finally {
      config.auth.password = original;
    }
  });

  it('bricht ab, wenn AUTH_PASSWORD zu schwach ist', async () => {
    const original = config.auth.password;
    config.auth.password = 'kurz';
    try {
      await expect(users.ensureBootstrapAdmin()).rejects.toThrow('ungeeignet');
    } finally {
      config.auth.password = original;
    }
  });
});
