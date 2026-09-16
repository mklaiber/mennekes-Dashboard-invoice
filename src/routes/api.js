'use strict';

/**
 * REST- und SSE-Endpunkte. Alles unterhalb von /api ist durch die Auth-Middleware
 * geschützt (siehe src/app.js) - hier gibt es keine öffentlichen Routen.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');
const settingsStore = require('../repositories/settingsRepository');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireRole } = require('../middleware/auth');
const audit = require('../repositories/auditRepository');
const { buildReportForMonth, runMonthlyReport, listGeneratedFiles } = require('../services/reportService');
const { enrichWithIdentity } = require('../services/liveFeed');
const { previousMonth } = require('../utils/dates');

/**
 * @param {object} deps
 * @param {import('../services/liveFeed')} deps.liveFeed
 * @param {import('../services/mennekesClient')} deps.mennekesClient
 * @returns {import('express').Router}
 */
function createApiRouter({ liveFeed, mennekesClient }) {
  const router = express.Router();

  /** Fehler mit HTTP-Status erzeugen. */
  const badRequest = (message) => Object.assign(new Error(message), { status: 400, code: 'bad_request' });

  /**
   * Validiert und normalisiert Jahr/Monat aus der Query.
   * Ohne Angabe wird der Vormonat genutzt.
   */
  function parsePeriod(query) {
    const settings = settingsStore.load();
    const timezone = settings.billing.timezone || config.billing.timezone;
    const fallback = previousMonth(new Date(), timezone);

    const year = query.year === undefined ? fallback.year : Number.parseInt(query.year, 10);
    const month = query.month === undefined ? fallback.month : Number.parseInt(query.month, 10);

    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw badRequest(`Ungültiges Jahr: ${query.year}`);
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw badRequest(`Ungültiger Monat: ${query.month}`);
    }
    return { year, month };
  }

  // ---------------------------------------------------------------- Live-Daten

  /**
   * GET /api/live - SSE-Stream mit dem aktuellen Wallbox-Zustand.
   * Events: `status` (Zustandsobjekt) und `error` (Abfrage fehlgeschlagen).
   */
  router.get('/live', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Verhindert Response-Buffering in nginx - sonst kommt nichts beim Client an.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // Kommentarzeile öffnet den Stream sofort.
    res.write(': connected\n\n');

    liveFeed.addSubscriber(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // Verbindung ist weg - der close-Handler raeumt den Rest auf.
        clearInterval(heartbeat);
      }
    }, config.live.heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    req.on('close', () => {
      clearInterval(heartbeat);
      liveFeed.removeSubscriber(res);
    });
  });

  /** GET /api/status - einmaliger Zustandsabruf (Polling-Fallback ohne SSE). */
  router.get('/status', asyncHandler(async (req, res) => {
    const state = await mennekesClient.getLiveStatus();
    res.json(enrichWithIdentity(state));
  }));

  // ---------------------------------------------------------------- Abrechnung

  /** GET /api/report?year=2026&month=3 - Report als JSON (Dashboard-Vorschau). */
  router.get('/report', asyncHandler(async (req, res) => {
    const { year, month } = parsePeriod(req.query);
    const report = await buildReportForMonth({ year, month, client: mennekesClient });
    res.json(report);
  }));

  /**
   * POST /api/report/run - Abrechnung erzeugen.
   * Body: { year?, month?, sendMail?: boolean, to?: string[] }
   */
  router.post('/report/run', requireRole('admin'), asyncHandler(async (req, res) => {
    const { year, month } = parsePeriod(req.body || {});
    const sendMail = req.body?.sendMail !== false;
    const to = Array.isArray(req.body?.to) && req.body.to.length > 0 ? req.body.to : undefined;

    logger.info(`Manueller Report-Lauf angefordert: ${year}-${month} (Mailversand: ${sendMail}).`);
    const result = await runMonthlyReport({
      year, month, sendMail, to,
      client: mennekesClient,
      triggeredBy: `manual:${req.user.username}`,
    });

    audit.log({
      action: audit.ACTIONS.REPORT_RUN,
      user: req.user,
      detail: `${result.report.period.label}: ${result.report.totals.energyKwh} kWh, Versand ${sendMail ? 'ja' : 'nein'}`,
      ip: req.ip,
    });

    res.json({
      ok: true,
      period: result.report.period,
      totals: result.report.totals,
      files: {
        pdf: result.files.pdf.fileName,
        csvDetail: result.files.csvDetail.fileName,
        csvSummary: result.files.csvSummary.fileName,
      },
      mail: result.mail ? { messageId: result.mail.messageId, to: result.mail.to } : null,
    });
  }));

  /** GET /api/report/files - bereits erzeugte Dateien auflisten. */
  router.get('/report/files', asyncHandler(async (req, res) => {
    res.json({ files: await listGeneratedFiles() });
  }));

  /** GET /api/report/files/:name - erzeugte Datei herunterladen. */
  router.get('/report/files/:name', asyncHandler(async (req, res) => {
    const requested = req.params.name;

    // Path-Traversal-Schutz: nur der Basename und nur erwartete Endungen.
    if (path.basename(requested) !== requested || !/^[\w.-]+\.(pdf|csv)$/i.test(requested)) {
      throw badRequest('Ungültiger Dateiname.');
    }

    const filePath = path.join(config.server.outputDir, requested);
    // Zusätzliche Absicherung gegen Symlinks aus dem Ausgabeverzeichnis heraus.
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(config.server.outputDir) + path.sep)) {
      throw badRequest('Ungültiger Pfad.');
    }
    if (!fs.existsSync(resolved)) {
      throw Object.assign(new Error('Datei nicht gefunden.'), { status: 404, code: 'not_found' });
    }

    res.download(resolved, requested);
  }));

  // ------------------------------------------------------------- Einstellungen

  /** GET /api/settings - aktuelle (nicht sensible) Einstellungen. */
  router.get('/settings', (req, res) => {
    res.json(settingsStore.load());
  });

  /**
   * PUT /api/settings - Einstellungen speichern.
   * Es wird gezielt gewhitelistet: unbekannte Felder aus dem Body werden verworfen,
   * damit über die API keine Secrets in settings.json geschmuggelt werden können.
   */
  router.put('/settings', requireRole('admin'), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const patch = {};

    if (body.wallbox) {
      patch.wallbox = {};
      if (typeof body.wallbox.baseUrl === 'string') {
        const url = body.wallbox.baseUrl.trim();
        if (url && !/^https?:\/\//i.test(url)) throw badRequest('Wallbox-URL muss mit http:// oder https:// beginnen.');
        patch.wallbox.baseUrl = url;
      }
      if (typeof body.wallbox.displayName === 'string') {
        patch.wallbox.displayName = body.wallbox.displayName.trim().slice(0, 120);
      }
    }

    if (body.billing) {
      patch.billing = {};
      if (body.billing.pricePerKwh !== undefined) {
        const price = Number.parseFloat(body.billing.pricePerKwh);
        if (!Number.isFinite(price) || price < 0 || price > 10) {
          throw badRequest('Strompreis muss zwischen 0 und 10 liegen.');
        }
        patch.billing.pricePerKwh = price;
      }
      for (const key of ['currency', 'locale', 'timezone', 'companyName', 'employeeName', 'vehiclePlate', 'logoUrl', 'footerNote']) {
        if (typeof body.billing[key] === 'string') patch.billing[key] = body.billing[key].trim().slice(0, 500);
      }
      if (body.billing.margins && typeof body.billing.margins === 'object') {
        // Ränder werden hier geprüft UND beim Rendern noch einmal begrenzt:
        // settings.json lässt sich auch von Hand bearbeiten.
        const margins = {};
        for (const side of ['top', 'right', 'bottom', 'left']) {
          if (body.billing.margins[side] === undefined) continue;
          const value = Number.parseFloat(body.billing.margins[side]);
          if (!Number.isFinite(value) || value < 5 || value > 60) {
            throw badRequest(
              `Seitenrand "${side}" muss zwischen 5 und 60 mm liegen (übliche Drucker `
              + 'können die äußersten 5 mm nicht bedrucken).'
            );
          }
          margins[side] = value;
        }
        if (Object.keys(margins).length > 0) patch.billing.margins = margins;
      }

      if (patch.billing.timezone) {
        // Ungültige Zeitzone würde erst am Monatsende beim Rendern knallen.
        try {
          new Intl.DateTimeFormat('de-DE', { timeZone: patch.billing.timezone });
        } catch {
          throw badRequest(`Unbekannte Zeitzone: ${patch.billing.timezone}`);
        }
      }
    }

    if (body.mail) {
      patch.mail = {};
      if (typeof body.mail.from === 'string') patch.mail.from = body.mail.from.trim();
      if (typeof body.mail.subjectPrefix === 'string') patch.mail.subjectPrefix = body.mail.subjectPrefix.trim().slice(0, 120);
      for (const key of ['to', 'cc']) {
        if (body.mail[key] !== undefined) {
          const list = Array.isArray(body.mail[key])
            ? body.mail[key]
            : String(body.mail[key]).split(/[,;\n]/);
          const cleaned = list.map((entry) => String(entry).trim()).filter(Boolean);
          const invalid = cleaned.filter((entry) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry));
          if (invalid.length > 0) throw badRequest(`Ungültige E-Mail-Adresse(n): ${invalid.join(', ')}`);
          patch.mail[key] = cleaned;
        }
      }
    }

    if (Array.isArray(body.rfidMappings)) {
      patch.rfidMappings = body.rfidMappings
        .filter((entry) => entry && typeof entry.rfid === 'string' && entry.rfid.trim())
        .map((entry) => ({
          rfid: String(entry.rfid).trim().slice(0, 64),
          name: String(entry.name || '').trim().slice(0, 120),
          plate: String(entry.plate || '').trim().slice(0, 32),
          billable: entry.billable !== false,
        }));
    }

    if (body.scheduler) {
      patch.scheduler = {};
      if (body.scheduler.enabled !== undefined) patch.scheduler.enabled = Boolean(body.scheduler.enabled);
      if (typeof body.scheduler.runPolicy === 'string'
          && ['last-day-of-month', 'always'].includes(body.scheduler.runPolicy)) {
        patch.scheduler.runPolicy = body.scheduler.runPolicy;
      }
    }

    const saved = settingsStore.save(patch, { userId: req.user.id });

    audit.log({
      action: Array.isArray(body.rfidMappings) ? audit.ACTIONS.RFID_UPDATED : audit.ACTIONS.SETTINGS_UPDATED,
      user: req.user,
      detail: Object.keys(patch).join(', '),
      ip: req.ip,
    });

    res.json({ ok: true, settings: saved });
  }));

  // -------------------------------------------------------------------- Health

  /**
   * GET /api/health - Zustand von App und Wallbox-Verbindung.
   * Nutzbar als Docker-Healthcheck (benötigt Basic-Auth-Credentials).
   */
  router.get('/health', asyncHandler(async (req, res) => {
    const wallbox = await mennekesClient.ping();
    res.status(wallbox.reachable ? 200 : 503).json({
      status: wallbox.reachable ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      wallbox,
      database: { ok: true, users: require('../repositories/userRepository').count() },
      liveSubscribers: liveFeed.subscriberCount,
      version: require('../../package.json').version,
    });
  }));

  return router;
}

module.exports = { createApiRouter };
