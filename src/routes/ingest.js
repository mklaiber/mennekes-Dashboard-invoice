'use strict';

/**
 * Datenannahme vom Home-Assistant-Connector.
 *
 * Die Richtung ist entscheidend: der Connector im Heimnetz baut die Verbindung
 * nach AUSSEN auf. Dadurch braucht es weder eine Portweiterleitung noch eine
 * von außen erreichbare Wallbox.
 *
 * Diese Routen liegen VOR der Benutzeranmeldung - sie haben ihre eigene
 * Authentifizierung über ein gemeinsames Geheimnis.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireConnectorToken } = require('../middleware/connectorAuth');
const chargingSessions = require('../repositories/chargingSessionRepository');
const connectorState = require('../repositories/connectorStateRepository');
const MennekesClient = require('../services/mennekesClient');
const { enrichWithIdentity } = require('../services/liveFeed');

/**
 * @param {{liveFeed: import('../services/liveFeed')}} deps
 * @returns {import('express').Router}
 */
function createIngestRouter({ liveFeed }) {
  const router = express.Router();

  const badRequest = (message) => Object.assign(new Error(message), { status: 400, code: 'bad_request' });

  // Eigenes Limit: der Connector sendet regelmäßig, ein Angreifer mit falschem
  // Token soll aber nicht unbegrenzt probieren dürfen.
  const limiter = config.isTest
    ? (req, res, next) => next()
    : rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'rate_limited', message: 'Zu viele Anfragen vom Connector.' },
    });

  router.use(limiter);
  router.use(requireConnectorToken());

  /**
   * POST /api/ingest/status
   * Aktueller Zustand der Wallbox. Wird nicht dauerhaft gespeichert - nur der
   * letzte Stand, den das Dashboard über SSE ausliefert.
   */
  router.post('/status', asyncHandler(async (req, res) => {
    const payload = req.body?.status;
    if (!payload || typeof payload !== 'object') {
      throw badRequest('Feld "status" fehlt oder ist kein Objekt.');
    }

    // Der Connector schickt Rohdaten der Wallbox; normalisiert wird hier, damit
    // beide Betriebsarten exakt dieselbe Aufbereitung durchlaufen.
    const normalized = payload.normalized === true
      ? payload
      : MennekesClient.normalizeStatus(payload);

    const state = enrichWithIdentity({
      ...normalized,
      // Zeitstempel der Annahme, nicht der Erzeugung: das Dashboard zeigt an,
      // wie aktuell der Wert HIER ist.
      timestamp: new Date().toISOString(),
      viaConnector: true,
    });

    connectorState.touch({ status: state, version: req.connector.version, ip: req.connector.ip });

    // Direkt an alle offenen Dashboards weiterreichen.
    liveFeed.publish(state);

    res.json({ ok: true, subscribers: liveFeed.subscriberCount });
  }));

  /**
   * POST /api/ingest/sessions
   * Abgeschlossene Ladevorgänge. Der Connector darf denselben Vorgang gefahrlos
   * erneut senden; die Ablage entscheidet anhand der ID über Einfügen oder
   * Aktualisieren.
   */
  router.post('/sessions', asyncHandler(async (req, res) => {
    const list = req.body?.sessions;
    if (!Array.isArray(list)) {
      throw badRequest('Feld "sessions" fehlt oder ist kein Array.');
    }
    if (list.length > config.connector.maxSessionsPerRequest) {
      throw badRequest(
        `Zu viele Vorgänge in einer Sendung (${list.length}, erlaubt sind ${config.connector.maxSessionsPerRequest}). `
        + 'Bitte in kleineren Paketen senden.'
      );
    }

    // Auch hier durch die gemeinsame Normalisierung - der Connector soll keine
    // Feldnamen kennen müssen, und Rohdaten bleiben nachvollziehbar.
    const normalized = [];
    const skipped = [];

    for (const entry of list) {
      const session = entry?.normalized === true ? entry : MennekesClient.normalizeSession(entry);
      if (!session) {
        skipped.push({ id: String(entry?.id ?? '?'), reason: 'nicht auswertbar' });
        continue;
      }
      normalized.push({ ...session, payload: entry });
    }

    const result = chargingSessions.upsertMany(normalized, { source: 'connector' });

    connectorState.touch({
      version: req.connector.version,
      ip: req.connector.ip,
      sessionsReceived: result.accepted,
    });

    logger.info(
      `Connector lieferte ${list.length} Vorgang/Vorgänge: `
      + `${result.inserted} neu, ${result.updated} aktualisiert, `
      + `${result.rejected.length + skipped.length} verworfen.`
    );

    res.json({
      ok: true,
      received: list.length,
      inserted: result.inserted,
      updated: result.updated,
      rejected: [...result.rejected, ...skipped],
    });
  }));

  /**
   * GET /api/ingest/health
   * Selbsttest für den Connector: bestätigt Erreichbarkeit und Token, ohne
   * Daten zu senden. Nützlich für den ersten Einrichtungsschritt.
   */
  router.get('/health', (req, res) => {
    const state = connectorState.health();
    res.json({
      ok: true,
      mode: config.connector.mode,
      serverVersion: require('../../package.json').version,
      lastSeenAt: state.lastSeenAt,
      storedSessions: chargingSessions.count(),
      // Damit der Connector weiß, wie groß er seine Pakete schneiden darf.
      maxSessionsPerRequest: config.connector.maxSessionsPerRequest,
    });
  });

  return router;
}

module.exports = { createIngestRouter };
