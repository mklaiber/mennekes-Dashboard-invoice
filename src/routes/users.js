'use strict';

/**
 * Benutzerverwaltung (nur fuer Administratoren).
 *
 * HTML-Ansicht unter /benutzer, die Aktionen laufen ueber /api/users.
 */

const express = require('express');
const config = require('../config');
const users = require('../repositories/userRepository');
const sessions = require('../repositories/sessionRepository');
const audit = require('../repositories/auditRepository');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireRole } = require('../middleware/auth');
const { randomToken } = require('../utils/password');

/** @returns {import('express').Router} */
function createUserRouter() {
  const router = express.Router();

  // WICHTIG: Der Guard hängt an JEDER Route einzeln, nicht per router.use().
  // Der Router ist auf '/' gemountet - ein router.use() hätte den Admin-Zwang
  // auf die gesamte Anwendung gelegt und Betrachter komplett ausgesperrt.
  const adminOnly = requireRole('admin');

  /** Verhindert, dass ein Administrator sich selbst aussperrt. */
  function assertNotSelf(req, id, message) {
    if (req.user.id === Number(id)) {
      throw Object.assign(new Error(message), { status: 409, code: 'conflict' });
    }
  }

  function parseId(value) {
    const id = Number.parseInt(value, 10);
    if (!Number.isInteger(id) || id < 1) {
      throw Object.assign(new Error('Ungültige Benutzer-ID.'), { status: 400, code: 'bad_request' });
    }
    return id;
  }

  // ------------------------------------------------------------ HTML-Ansicht

  router.get('/benutzer', adminOnly, (req, res) => {
    res.render('users', {
      title: 'Benutzer',
      active: 'users',
      users: users.list(),
      minLength: config.auth.minPasswordLength,
      auditEntries: audit.list({ limit: 40 }),
    });
  });

  // ---------------------------------------------------------------- REST-API

  router.get('/api/users', adminOnly, (req, res) => {
    res.json({ users: users.list() });
  });

  /** Anlegen. Ohne Passwort im Body wird eines erzeugt und einmalig zurueckgegeben. */
  router.post('/api/users', adminOnly, asyncHandler(async (req, res) => {
    const body = req.body || {};
    // Ein generiertes Startpasswort ist sicherer als ein vom Admin ausgedachtes
    // und wird beim ersten Login zwingend gewechselt.
    const generated = !body.password ? `${randomToken(9)}-${randomToken(9)}` : null;

    const created = await users.create({
      username: body.username,
      password: body.password || generated,
      role: body.role,
      displayName: body.displayName,
      email: body.email,
      mustChangePassword: body.mustChangePassword !== false,
    });

    audit.log({
      action: audit.ACTIONS.USER_CREATED,
      user: req.user,
      detail: `"${created.username}" als ${created.role}`,
      ip: req.ip,
    });

    res.status(201).json({ ok: true, user: created, generatedPassword: generated });
  }));

  /** Stammdaten, Rolle und Aktivierung aendern. */
  router.put('/api/users/:id', adminOnly, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const body = req.body || {};

    // Die eigene Rolle herabzustufen oder sich zu deaktivieren waere ein
    // Selbst-Aussperren; die Regel "letzter Admin" im Repository greift dafuer nicht.
    if (body.role !== undefined && body.role !== 'admin') {
      assertNotSelf(req, id, 'Die eigene Administratorrolle kann nicht entzogen werden.');
    }
    if (body.isActive === false) {
      assertNotSelf(req, id, 'Das eigene Konto kann nicht deaktiviert werden.');
    }

    const updated = users.update(id, {
      displayName: body.displayName,
      email: body.email,
      role: body.role,
      isActive: body.isActive,
    });

    audit.log({
      action: audit.ACTIONS.USER_UPDATED,
      user: req.user,
      detail: `"${updated.username}": Rolle ${updated.role}, aktiv ${updated.isActive}`,
      ip: req.ip,
    });

    res.json({ ok: true, user: updated });
  }));

  /** Passwort zuruecksetzen. */
  router.post('/api/users/:id/password', adminOnly, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const generated = !req.body?.password ? `${randomToken(9)}-${randomToken(9)}` : null;

    const updated = await users.setPassword(id, req.body?.password || generated, {
      mustChange: req.body?.mustChangePassword !== false,
    });

    audit.log({
      action: audit.ACTIONS.PASSWORD_CHANGED,
      user: req.user,
      detail: `zurückgesetzt für "${updated.username}"`,
      ip: req.ip,
    });

    res.json({ ok: true, user: updated, generatedPassword: generated });
  }));

  /** Konto loeschen. */
  router.delete('/api/users/:id', adminOnly, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    assertNotSelf(req, id, 'Das eigene Konto kann nicht gelöscht werden.');

    const result = users.remove(id);
    audit.log({
      action: audit.ACTIONS.USER_DELETED,
      user: req.user,
      detail: `"${result.username}"`,
      ip: req.ip,
    });

    res.json({ ok: true, ...result });
  }));

  /** Alle Sitzungen eines Kontos beenden. */
  router.post('/api/users/:id/logout-all', adminOnly, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const closed = sessions.destroyAllForUser(id);

    audit.log({
      action: audit.ACTIONS.USER_UPDATED,
      user: req.user,
      detail: `${closed} Sitzung(en) beendet für Benutzer #${id}`,
      ip: req.ip,
    });

    res.json({ ok: true, closed });
  }));

  /** Protokoll lesen. */
  router.get('/api/audit', adminOnly, (req, res) => {
    res.json({ entries: audit.list({ limit: req.query.limit, action: req.query.action }) });
  });

  return router;
}

module.exports = { createUserRouter };
