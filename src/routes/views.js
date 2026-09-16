'use strict';

/**
 * HTML-Routen der WebUI (EJS-Templates).
 * Die eigentlichen Daten holt das Frontend per fetch/SSE aus /api.
 */

const express = require('express');
const config = require('../config');
const settingsStore = require('../repositories/settingsRepository');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireRole } = require('../middleware/auth');
const { listGeneratedFiles } = require('../services/reportService');
const reportRuns = require('../repositories/reportRunRepository');
const connectorState = require('../repositories/connectorStateRepository');
const sessionSource = require('../services/sessionSource');
const { previousMonth, MONTH_NAMES_DE } = require('../utils/dates');

/**
 * @param {object} deps
 * @param {import('../services/liveFeed')} deps.liveFeed
 * @returns {import('express').Router}
 */
function createViewRouter({ liveFeed }) {
  const router = express.Router();

  /** Ansicht 1: Live-Dashboard. */
  router.get('/', (req, res) => {
    const settings = settingsStore.load();
    res.render('dashboard', {
      title: 'Dashboard',
      active: 'dashboard',
      settings,
      // Startwert, damit die Kacheln nicht leer aufblitzen, bevor SSE greift.
      initialState: liveFeed.lastState,
      pollIntervalMs: config.live.pollIntervalMs,
      // Historie nur für Administratoren: sie nennt Empfängeradressen.
      runs: req.user?.role === 'admin' ? reportRuns.list(8) : [],
      // Im Connector-Betrieb muss sichtbar sein, ob die Brücke ins Heimnetz
      // noch steht - sonst ist ein stilles Dashboard nicht von "lädt gerade
      // nicht" zu unterscheiden.
      connector: sessionSource.isConnectorMode() ? connectorState.health() : null,
    });
  });

  /** Ansicht 2: Einstellungen - nur für Administratoren. */
  router.get('/einstellungen', requireRole('admin'), asyncHandler(async (req, res) => {
    const settings = settingsStore.load();
    const files = await listGeneratedFiles();
    const fallback = previousMonth(new Date(), settings.billing.timezone);

    res.render('settings', {
      title: 'Einstellungen',
      active: 'settings',
      settings,
      files,
      runs: reportRuns.list(15),
      months: MONTH_NAMES_DE.map((name, index) => ({ value: index + 1, name })),
      defaultYear: fallback.year,
      defaultMonth: fallback.month,
      years: Array.from({ length: 6 }, (unused, index) => fallback.year - index),
      // Nur zur Anzeige: aus welchen ENV-Quellen kommen die Secrets?
      envInfo: {
        smtpHost: config.smtp.host,
        smtpPort: config.smtp.port,
        smtpAuth: Boolean(config.smtp.user),
        wallboxAuthMode: config.mennekes.authMode,
        cronExpression: config.scheduler.cronExpression,
        cronEnabled: config.scheduler.enabled,
        outputDir: config.server.outputDir,
      },
    });
  }));

  return router;
}

module.exports = { createViewRouter };
