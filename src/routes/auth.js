'use strict';

/**
 * Anmeldung, Abmeldung und Passwortwechsel.
 *
 * Diese Routen sind die einzigen, die OHNE Anmeldung erreichbar sind -
 * entsprechend eng ist das Rate-Limit.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const logger = require('../utils/logger');
const users = require('../repositories/userRepository');
const sessions = require('../repositories/sessionRepository');
const audit = require('../repositories/auditRepository');
const { asyncHandler } = require('../middleware/errorHandler');
const { startSession, endSession } = require('../middleware/auth');
const { validatePassword } = require('../utils/password');

/**
 * Öffentliche Routen: Anmeldung und Abmeldung.
 *
 * Bewusst getrennt vom Passwortwechsel - der setzt eine Anmeldung voraus und
 * gehört deshalb hinter `requireAuth`, damit die Umleitung dort das ursprünglich
 * gewünschte Ziel behält.
 *
 * @param {{loginLimiter?: import('express').RequestHandler}} [deps]
 * @returns {import('express').Router}
 */
function createAuthRouter(deps = {}) {
  const router = express.Router();

  // Zusaetzlich zur Kontosperre: bremst das Durchprobieren VIELER Konten
  // von derselben Adresse, was der kontobezogene Zaehler nicht erfasst.
  const loginLimiter = deps.loginLimiter || (config.isTest
    ? (req, res, next) => next()
    : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      message: { error: 'rate_limited', message: 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.' },
    }));

  /** Nur pfadrelative Weiterleitungen zulassen - sonst Open Redirect. */
  function safeNext(value) {
    const target = String(value || '/');
    if (!target.startsWith('/') || target.startsWith('//')) return '/';
    return target;
  }

  // ------------------------------------------------------------------ Login

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next));
    res.render('login', {
      title: 'Anmeldung',
      error: null,
      username: '',
      next: safeNext(req.query.next),
      // Hinweis beim allerersten Start, wenn nur der ENV-Administrator existiert.
      firstRun: users.count() <= 1,
    });
  });

  router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const remember = req.body?.remember === 'on' || req.body?.remember === true;
    const target = safeNext(req.body?.next);

    const result = await users.authenticate(username, password);

    if (!result.ok) {
      audit.log({
        action: audit.ACTIONS.LOGIN_FAILED,
        user: { username },
        detail: `Grund: ${result.reason}`,
        ip: req.ip,
      });
      logger.warn(`Fehlgeschlagene Anmeldung für "${username}" (${result.reason}) von ${req.ip}`);

      // Bewusst dieselbe Meldung für falsches Passwort und unbekanntes Konto -
      // sonst liesse sich die Existenz von Benutzernamen abfragen.
      const messages = {
        locked: 'Das Konto ist vorübergehend gesperrt. Bitte später erneut versuchen.',
        disabled: 'Dieses Konto ist deaktiviert.',
        invalid: 'Benutzername oder Passwort ist falsch.',
      };

      return res.status(401).render('login', {
        title: 'Anmeldung',
        error: messages[result.reason] || messages.invalid,
        username,
        next: target,
        firstRun: false,
      });
    }

    startSession(req, res, result.user, { remember });
    audit.log({ action: audit.ACTIONS.LOGIN_OK, user: result.user, ip: req.ip });
    logger.info(`Anmeldung: "${result.user.username}" (${result.user.role})`);

    return res.redirect(result.user.mustChangePassword ? '/passwort' : target);
  }));

  // ----------------------------------------------------------------- Logout

  router.post('/logout', (req, res) => {
    if (req.user) audit.log({ action: audit.ACTIONS.LOGOUT, user: req.user, ip: req.ip });
    endSession(req, res);
    res.redirect('/login');
  });

  return router;
}

/**
 * Geschützte Routen rund um das eigene Konto.
 * Wird NACH `requireAuth` gemountet - `req.user` ist hier immer gesetzt.
 *
 * @returns {import('express').Router}
 */
function createAccountRouter() {
  const router = express.Router();

  // --------------------------------------------------------- Passwortwechsel

  router.get('/passwort', (req, res) => {
    res.render('password', {
      title: 'Passwort ändern',
      active: 'account',
      error: null,
      success: false,
      forced: Boolean(req.user.mustChangePassword),
      minLength: config.auth.minPasswordLength,
      sessions: sessions.listForUser(req.user.id),
    });
  });

  router.post('/passwort', asyncHandler(async (req, res) => {
    const current = String(req.body?.currentPassword || '');
    const next = String(req.body?.newPassword || '');
    const repeat = String(req.body?.repeatPassword || '');

    const render = (error) => res.status(400).render('password', {
      title: 'Passwort ändern',
      active: 'account',
      error,
      success: false,
      forced: Boolean(req.user.mustChangePassword),
      minLength: config.auth.minPasswordLength,
      sessions: sessions.listForUser(req.user.id),
    });

    // Auch beim erzwungenen Wechsel wird das alte Passwort verlangt: sonst
    // koennte ein fremder Zugriff auf eine offene Sitzung das Konto uebernehmen.
    const check = await users.authenticate(req.user.username, current);
    if (!check.ok) return render('Das aktuelle Passwort ist falsch.');

    if (next !== repeat) return render('Die beiden neuen Passwörter stimmen nicht überein.');

    const policy = validatePassword(next, config.auth.minPasswordLength);
    if (!policy.ok) return render(policy.message);

    if (next === current) return render('Das neue Passwort muss sich vom bisherigen unterscheiden.');

    // keepSessions: der eigene Login soll nicht mitten im Vorgang abbrechen.
    await users.setPassword(req.user.id, next, { mustChange: false, keepSessions: true });
    // Alle ANDEREN Sitzungen beenden und fuer diese eine neue anlegen.
    sessions.destroyAllForUser(req.user.id);
    startSession(req, res, req.user);

    audit.log({ action: audit.ACTIONS.PASSWORD_CHANGED, user: req.user, detail: 'selbst geändert', ip: req.ip });

    return res.render('password', {
      title: 'Passwort ändern',
      active: 'account',
      error: null,
      success: true,
      forced: false,
      minLength: config.auth.minPasswordLength,
      sessions: sessions.listForUser(req.user.id),
    });
  }));

  return router;
}

module.exports = { createAuthRouter, createAccountRouter };
