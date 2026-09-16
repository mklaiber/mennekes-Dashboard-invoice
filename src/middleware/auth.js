'use strict';

/**
 * Authentifizierung und Autorisierung.
 *
 * Zwei Wege, bewusst getrennt:
 *
 *  1. **Sitzungs-Cookie** fuer den Browser. Das Cookie ist httpOnly und
 *     SameSite=Lax; da es der Browser automatisch mitschickt, sind
 *     zustandsaendernde Anfragen zusaetzlich per CSRF-Token abgesichert.
 *
 *  2. **Basic-Auth** fuer maschinelle Zugriffe auf /api (Docker-Healthcheck,
 *     Skripte, Monitoring). Hier gibt es kein Cookie, das ein fremder Ursprung
 *     automatisch mitsenden koennte - deshalb entfaellt der CSRF-Schutz.
 *     Abschaltbar ueber AUTH_ALLOW_BASIC_API=false.
 */

const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const users = require('../repositories/userRepository');
const sessions = require('../repositories/sessionRepository');

/** Fehler mit HTTP-Status. */
function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** Cookie-Optionen an einer Stelle, damit Setzen und Loeschen nicht auseinanderlaufen. */
function cookieOptions(expiresAt) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.auth.cookieSecure,
    path: '/',
    expires: expiresAt,
  };
}

/**
 * Meldet einen Benutzer an und setzt das Sitzungs-Cookie.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} user
 * @param {{remember?:boolean}} [options]
 * @returns {{csrfToken:string, expiresAt:Date}}
 */
function startSession(req, res, user, options = {}) {
  const { token, csrfToken, expiresAt } = sessions.create({
    userId: user.id,
    userAgent: req.get('user-agent') || '',
    ip: req.ip || '',
    remember: Boolean(options.remember),
  });

  res.cookie(config.auth.cookieName, token, cookieOptions(expiresAt));
  return { csrfToken, expiresAt };
}

/**
 * Meldet ab und loescht das Cookie.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function endSession(req, res) {
  sessions.destroyByToken(req.cookies?.[config.auth.cookieName]);
  res.clearCookie(config.auth.cookieName, { path: '/' });
}

/**
 * Prueft Basic-Auth-Header gegen die Benutzertabelle.
 * @param {string} header
 * @returns {Promise<object|null>}
 */
async function authenticateBasic(header) {
  const match = /^Basic\s+(.+)$/i.exec(header || '');
  if (!match) return null;

  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }

  const separator = decoded.indexOf(':');
  if (separator < 0) return null;

  const result = await users.authenticate(decoded.slice(0, separator), decoded.slice(separator + 1));
  return result.ok ? result.user : null;
}

/**
 * Haengt - falls vorhanden - den angemeldeten Benutzer an den Request.
 * Blockiert nichts; das uebernimmt `requireAuth`.
 *
 * @returns {import('express').RequestHandler}
 */
function attachUser() {
  return async (req, res, next) => {
    try {
      const resolved = sessions.resolve(req.cookies?.[config.auth.cookieName]);

      if (resolved) {
        req.user = resolved.user;
        req.session = resolved.session;
        req.authMethod = 'session';
        sessions.touch(resolved.session.id);
      } else if (config.auth.allowBasicAuthForApi && req.headers.authorization) {
        const user = await authenticateBasic(req.headers.authorization);
        if (user) {
          req.user = user;
          req.authMethod = 'basic';
        }
      }

      // Fuer die Templates: Navigation und CSRF-Felder brauchen beides.
      res.locals.currentUser = req.user || null;
      res.locals.csrfToken = req.session?.csrfToken || '';
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Erzwingt eine Anmeldung.
 * HTML-Anfragen werden zur Login-Seite geleitet, API-Anfragen bekommen 401.
 *
 * @returns {import('express').RequestHandler}
 */
function requireAuth() {
  return (req, res, next) => {
    if (req.user) return next();

    if (req.path.startsWith('/api/')) {
      // WWW-Authenticate nur senden, wenn Basic-Auth ueberhaupt erlaubt ist -
      // sonst oeffnet der Browser einen Dialog, der nie zum Ziel fuehrt.
      if (config.auth.allowBasicAuthForApi) {
        res.set('WWW-Authenticate', `Basic realm="${config.auth.realm}", charset="UTF-8"`);
      }
      return next(httpError(401, 'unauthorized', 'Anmeldung erforderlich.'));
    }

    const target = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login?next=${target}`);
  };
}

/**
 * Erzwingt eine Rolle.
 * @param {'admin'|'viewer'} role
 * @returns {import('express').RequestHandler}
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return next(httpError(401, 'unauthorized', 'Anmeldung erforderlich.'));
    // 'admin' schliesst 'viewer' mit ein.
    if (req.user.role === 'admin' || req.user.role === role) return next();
    return next(httpError(403, 'forbidden', 'Für diesen Bereich fehlen die Berechtigungen.'));
  };
}

/**
 * Leitet auf den Passwortwechsel um, solange dieser erzwungen ist.
 * Damit kann ein frisch angelegtes Konto nichts tun, ausser sein Passwort zu setzen.
 *
 * @returns {import('express').RequestHandler}
 */
function requirePasswordChange() {
  const allowed = new Set(['/passwort', '/logout', '/api/account/password', '/api/auth/logout']);

  return (req, res, next) => {
    if (!req.user?.mustChangePassword) return next();
    if (allowed.has(req.path) || req.path.startsWith('/static/')) return next();

    if (req.path.startsWith('/api/')) {
      return next(httpError(403, 'password_change_required', 'Das Passwort muss zuerst geändert werden.'));
    }
    return res.redirect('/passwort');
  };
}

/**
 * CSRF-Schutz fuer cookie-authentifizierte, zustandsaendernde Anfragen.
 *
 * Basic-Auth-Anfragen sind ausgenommen: ohne Cookie kann ein fremder Ursprung
 * keine authentifizierte Anfrage ausloesen.
 *
 * @returns {import('express').RequestHandler}
 */
function csrfProtection() {
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.authMethod !== 'session') return next();
    if (!req.session?.csrfToken) return next(httpError(401, 'unauthorized', 'Sitzung abgelaufen.'));

    const provided = req.get('x-csrf-token') || req.body?._csrf || '';
    const expected = req.session.csrfToken;

    const providedBuffer = Buffer.from(String(provided));
    const expectedBuffer = Buffer.from(String(expected));

    if (providedBuffer.length !== expectedBuffer.length
        || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
      logger.warn(`CSRF-Token fehlt oder passt nicht: ${req.method} ${req.originalUrl}`);
      return next(httpError(403, 'csrf_failed', 'Sicherheitsprüfung fehlgeschlagen. Bitte Seite neu laden.'));
    }

    return next();
  };
}

module.exports = {
  attachUser, requireAuth, requireRole, requirePasswordChange, csrfProtection,
  startSession, endSession, authenticateBasic, cookieOptions,
};
