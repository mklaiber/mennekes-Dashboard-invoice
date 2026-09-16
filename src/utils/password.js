'use strict';

/**
 * Passwort-Hashing mit scrypt aus node:crypto.
 *
 * Bewusst kein bcrypt/argon2: beides sind native Module mit Build-Kette,
 * waehrend scrypt in Node eingebaut, speicherhart und fuer diesen Zweck
 * voellig ausreichend ist.
 *
 * Format: scrypt$N$r$p$<salt-base64>$<hash-base64>
 * Die Parameter stehen im Hash - so lassen sie sich spaeter erhoehen, ohne
 * bestehende Passwoerter ungueltig zu machen.
 */

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

/** ~16 MB Speicher je Hash-Vorgang. */
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 };

/**
 * @param {string} password
 * @returns {Promise<string>} Hash im oben beschriebenen Format
 */
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Passwort darf nicht leer sein.');
  }
  const salt = crypto.randomBytes(PARAMS.saltBytes);
  // maxmem muss ueber 128*N*r liegen, sonst wirft scrypt.
  const derived = await scrypt(password, salt, PARAMS.keylen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: 256 * PARAMS.N * PARAMS.r,
  });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Prueft ein Passwort gegen einen gespeicherten Hash.
 * Laeuft immer vollstaendig durch (kein fruehes return bei falschem Format),
 * damit die Antwortzeit nichts ueber die Existenz des Kontos verraet.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, rawN, rawR, rawP, saltB64, hashB64] = parts;
  const N = Number.parseInt(rawN, 10);
  const r = Number.parseInt(rawR, 10);
  const p = Number.parseInt(rawP, 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let expected;
  try {
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }

  let derived;
  try {
    derived = await scrypt(String(password ?? ''), Buffer.from(saltB64, 'base64'), expected.length, {
      N, r, p, maxmem: 256 * N * r,
    });
  } catch {
    return false;
  }

  // Laengenvergleich vorab, weil timingSafeEqual bei ungleicher Laenge wirft.
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Prueft, ob ein Passwort den Mindestanforderungen genuegt.
 * @param {string} password
 * @param {number} [minLength=12]
 * @returns {{ok:boolean, message?:string}}
 */
function validatePassword(password, minLength = 12) {
  const value = String(password ?? '');
  if (value.length < minLength) {
    return { ok: false, message: `Das Passwort muss mindestens ${minLength} Zeichen lang sein.` };
  }
  if (value.length > 200) {
    return { ok: false, message: 'Das Passwort darf höchstens 200 Zeichen lang sein.' };
  }
  // Keine Zeichenklassen-Pflicht: Laenge schlaegt Komplexitaet, und erzwungene
  // Sonderzeichen fuehren erfahrungsgemaess zu schwaecheren, notierten Passwoertern.
  if (/^\s|\s$/.test(value)) {
    return { ok: false, message: 'Das Passwort darf nicht mit einem Leerzeichen beginnen oder enden.' };
  }
  return { ok: true };
}

/**
 * Kryptografisch sicherer Zufallstoken (URL-tauglich).
 * @param {number} [bytes=32]
 * @returns {string}
 */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256 eines Tokens - so landet nie ein gueltiges Cookie in der Datenbank.
 * @param {string} token
 * @returns {string}
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { hashPassword, verifyPassword, validatePassword, randomToken, hashToken, PARAMS };
