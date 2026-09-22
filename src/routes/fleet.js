'use strict';

/**
 * Firmen, Fahrzeuge und Kartenzuordnung eines Privathaushalts.
 *
 * HTML-Ansicht unter /fuhrpark, die Aktionen laufen ueber /api/fleet/*.
 */

const express = require('express');
const fleet = require('../repositories/fleetRepository');
const audit = require('../repositories/auditRepository');
const settingsStore = require('../repositories/settingsRepository');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireRole } = require('../middleware/auth');

/** @returns {import('express').Router} */
function createFleetRouter() {
  const router = express.Router();

  // Wie in der Benutzerverwaltung haengt der Guard an JEDER Route einzeln:
  // der Router ist auf '/' gemountet, ein router.use() legte den Admin-Zwang
  // ueber die gesamte Anwendung.
  const adminOnly = requireRole('admin');

  const badRequest = (message) =>
    Object.assign(new Error(message), { status: 400, code: 'bad_request' });

  function parseId(value, what) {
    const id = Number.parseInt(value, 10);
    if (!Number.isInteger(id) || id < 1) throw badRequest(`Ungültige ${what}-ID.`);
    return id;
  }

  /** Leerer Preis heisst "globale Einstellung", nicht "null Cent". */
  function parsePrice(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const price = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(price) || price < 0) throw badRequest('Ungültiger Arbeitspreis.');
    return price;
  }

  /**
   * Loest eine Firmen-ID auf und weist sie ab, wenn es sie nicht gibt.
   *
   * Ohne das schlaegt erst die Fremdschluesselbedingung in SQLite zu, und der
   * Aufrufer bekommt einen 500 statt einer verstaendlichen Meldung - etwa
   * wenn die Firma inzwischen in einem anderen Tab geloescht wurde und die
   * Auswahlliste noch die alte ID traegt.
   *
   * @param {*} value
   * @returns {number|null} null heisst ausdruecklich "privat"
   */
  function resolveCompanyId(value) {
    if (value === undefined || value === null || value === '') return null;
    const id = parseId(value, 'Firmen');
    if (!fleet.findCompany(id)) {
      throw Object.assign(new Error(`Es gibt keine Firma mit der ID ${id}.`), {
        status: 400, code: 'bad_request',
      });
    }
    return id;
  }

  // --------------------------------------------------------------- Ansicht

  router.get('/fuhrpark', adminOnly, (req, res) => {
    res.render('fleet', {
      title: 'Fuhrpark',
      active: 'fleet',
      companies: fleet.listCompanies({ includeInactive: true }),
      vehicles: fleet.listVehicles({ includeInactive: true }),
      unassignedCards: fleet.listUnassignedCards(),
      knownCards: settingsStore.listRfidMappings(),
    });
  });

  // ---------------------------------------------------------------- Daten

  router.get('/api/fleet', adminOnly, (req, res) => {
    res.json({
      companies: fleet.listCompanies({ includeInactive: true }),
      vehicles: fleet.listVehicles({ includeInactive: true }),
      unassignedCards: fleet.listUnassignedCards(),
    });
  });

  // --------------------------------------------------------------- Firmen

  router.post('/api/fleet/companies', adminOnly, asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) throw badRequest('Der Name der Firma fehlt.');

    const company = fleet.createCompany({
      name,
      address: req.body.address,
      contactEmail: req.body.contactEmail,
      pricePerKwh: parsePrice(req.body.pricePerKwh),
      ownReport: req.body.ownReport !== false && req.body.ownReport !== 'false',
    });

    audit.log({ action: audit.ACTIONS.FLEET_COMPANY_CREATED, user: req.user, detail: name, ip: req.ip });
    res.status(201).json({ company });
  }));

  router.put('/api/fleet/companies/:id', adminOnly, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id, 'Firmen');
    const patch = { ...req.body };
    if ('pricePerKwh' in patch) patch.pricePerKwh = parsePrice(patch.pricePerKwh);
    if ('ownReport' in patch) patch.ownReport = patch.ownReport === true || patch.ownReport === 'true';
    if ('active' in patch) patch.active = patch.active === true || patch.active === 'true';

    const company = fleet.updateCompany(id, patch);
    if (!company) throw Object.assign(new Error('Firma nicht gefunden.'), { status: 404, code: 'not_found' });

    audit.log({ action: audit.ACTIONS.FLEET_COMPANY_UPDATED, user: req.user, detail: company.name, ip: req.ip });
    res.json({ company });
  }));

  // ------------------------------------------------------------- Fahrzeuge

  router.post('/api/fleet/vehicles', adminOnly, asyncHandler(async (req, res) => {
    const plate = String(req.body?.plate || '').trim();
    if (!plate) throw badRequest('Das Kennzeichen fehlt.');

    const vehicle = fleet.createVehicle({
      plate,
      label: req.body.label,
      companyId: resolveCompanyId(req.body.companyId),
      employeeName: req.body.employeeName,
      notes: req.body.notes,
    });

    audit.log({ action: audit.ACTIONS.FLEET_VEHICLE_CREATED, user: req.user, detail: plate, ip: req.ip });
    res.status(201).json({ vehicle });
  }));

  router.put('/api/fleet/vehicles/:id', adminOnly, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id, 'Fahrzeug');
    const patch = { ...req.body };
    if ('companyId' in patch) patch.companyId = resolveCompanyId(patch.companyId);
    if ('active' in patch) patch.active = patch.active === true || patch.active === 'true';

    const vehicle = fleet.updateVehicle(id, patch);
    if (!vehicle) throw Object.assign(new Error('Fahrzeug nicht gefunden.'), { status: 404, code: 'not_found' });

    audit.log({ action: audit.ACTIONS.FLEET_VEHICLE_UPDATED, user: req.user, detail: vehicle.plate, ip: req.ip });
    res.json({ vehicle });
  }));

  // -------------------------------------------------------- Kartenzuordnung

  router.post('/api/fleet/cards/:rfid/assign', adminOnly, asyncHandler(async (req, res) => {
    const rfid = settingsStore.normalizeRfid(String(req.params.rfid || ''));
    if (!rfid) throw badRequest('Karten-ID fehlt.');

    const vehicleId = req.body?.vehicleId ? parseId(req.body.vehicleId, 'Fahrzeug') : null;
    // Rueckwirkend uebernehmen ist eine ausdrueckliche Entscheidung und
    // beruehrt nur Vorgaenge, die noch KEINER Zuordnung haben.
    const backfill = req.body?.backfill === true || req.body?.backfill === 'true';

    const result = fleet.assignCardToVehicle(rfid, vehicleId, { backfill });
    if (!result.assigned) {
      throw Object.assign(new Error('Fahrzeug nicht gefunden.'), { status: 404, code: 'not_found' });
    }

    audit.log({
      action: audit.ACTIONS.FLEET_CARD_ASSIGNED,
      user: req.user,
      detail: `${rfid} -> ${vehicleId ?? 'gelöst'}${result.backfilled ? ` (${result.backfilled} rückwirkend)` : ''}`,
      ip: req.ip,
    });
    res.json({ ...result, unassignedCards: fleet.listUnassignedCards() });
  }));

  return router;
}

module.exports = { createFleetRouter };
