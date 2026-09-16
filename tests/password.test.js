'use strict';

const { hashPassword, verifyPassword, validatePassword, randomToken, hashToken } = require('../src/utils/password');

describe('hashPassword / verifyPassword', () => {
  it('erzeugt einen Hash im erwarteten Format', async () => {
    const hash = await hashPassword('ein-sicheres-passwort');
    const parts = hash.split('$');

    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBe(16384);
    expect(parts).toHaveLength(6);
  });

  it('erzeugt für dasselbe Passwort unterschiedliche Hashes (Salt)', async () => {
    const a = await hashPassword('gleiches-passwort');
    const b = await hashPassword('gleiches-passwort');

    expect(a).not.toBe(b);
    // Trotzdem passen beide.
    expect(await verifyPassword('gleiches-passwort', a)).toBe(true);
    expect(await verifyPassword('gleiches-passwort', b)).toBe(true);
  });

  it('bestätigt das richtige Passwort', async () => {
    const hash = await hashPassword('korrektes-passwort');
    expect(await verifyPassword('korrektes-passwort', hash)).toBe(true);
  });

  it('weist falsche Passwörter ab', async () => {
    const hash = await hashPassword('korrektes-passwort');

    expect(await verifyPassword('falsches-passwort', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
    expect(await verifyPassword('korrektes-passwor', hash)).toBe(false);
    expect(await verifyPassword('Korrektes-Passwort', hash)).toBe(false);
  });

  it('wirft nicht bei kaputten oder fremden Hashes', async () => {
    for (const stored of ['', 'unsinn', null, undefined, '$1$2$3', 'bcrypt$a$b$c$d$e', 'scrypt$x$y$z$q$r']) {
      await expect(verifyPassword('irgendwas', stored)).resolves.toBe(false);
    }
  });

  it('lehnt ein leeres Passwort beim Hashen ab', async () => {
    await expect(hashPassword('')).rejects.toThrow('darf nicht leer sein');
    await expect(hashPassword(null)).rejects.toThrow();
  });

  it('kommt mit Sonderzeichen und Unicode zurecht', async () => {
    const password = 'Pässwörd-mit-Ümläuten-🔑-und-Leer zeichen';
    const hash = await hashPassword(password);

    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword('Passwort-mit-Umlauten', hash)).toBe(false);
  });
});

describe('validatePassword', () => {
  it('verlangt die Mindestlänge', () => {
    expect(validatePassword('kurz', 12).ok).toBe(false);
    expect(validatePassword('kurz', 12).message).toContain('12 Zeichen');
    expect(validatePassword('genau-zwoelf', 12).ok).toBe(true);
  });

  it('respektiert eine abweichende Mindestlänge', () => {
    expect(validatePassword('achtzeic', 8).ok).toBe(true);
    expect(validatePassword('achtzeic', 20).ok).toBe(false);
  });

  it('begrenzt die Länge nach oben', () => {
    // Ohne Obergrenze liesse sich der scrypt-Aufwand als DoS missbrauchen.
    expect(validatePassword('a'.repeat(201), 12).ok).toBe(false);
    expect(validatePassword('a'.repeat(200), 12).ok).toBe(true);
  });

  it('lehnt führende und abschließende Leerzeichen ab', () => {
    expect(validatePassword(' mit-leerzeichen-vorn', 12).ok).toBe(false);
    expect(validatePassword('mit-leerzeichen-hinten ', 12).ok).toBe(false);
    expect(validatePassword('mit leerzeichen innen', 12).ok).toBe(true);
  });

  it('verlangt keine Zeichenklassen - Länge zählt', () => {
    expect(validatePassword('nur-kleinbuchstaben-aber-lang', 12).ok).toBe(true);
  });

  it('behandelt fehlende Eingaben als zu kurz', () => {
    expect(validatePassword(undefined, 12).ok).toBe(false);
    expect(validatePassword(null, 12).ok).toBe(false);
  });
});

describe('randomToken / hashToken', () => {
  it('erzeugt URL-taugliche Token', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it('erzeugt jedes Mal ein anderes Token', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken(16)));
    expect(tokens.size).toBe(200);
  });

  it('hasht stabil und unumkehrbar', () => {
    const token = randomToken(32);

    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });
});
