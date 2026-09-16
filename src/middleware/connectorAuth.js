'use strict';

/**
 * Authentifizierung des Home-Assistant-Connectors.
 *
 * Bewusst getrennt von der Benutzeranmeldung: Der Connector ist kein Mensch,
 * hat keine Sitzung und keine Rolle. Er darf ausschließlich Daten liefern -
 * nichts lesen, nichts ändern.
 *
 * Verfahren: Bearer-Token über HTTPS. Das genügt hier, weil TLS bereits
 * Vertraulichkeit, Integrität und Schutz vor Wiedereinspielung liefert; eine
 * zusätzliche HMAC-Signatur brächte keinen Zugewinn, aber Zündstoff für
 * Uhrzeit- und Kodierungsfehler auf einem Gerät, an das niemand herankommt.
 */

const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

/** Zeitkonstanter Vergleich; unterschiedliche Längen gelten als ungleich. */
function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * @returns {import('express').RequestHandler}
 */
function requireConnectorToken() {
  return (req, res, next) => {
    if (config.connector.mode !== 'connector') {
      return next(Object.assign(
        new Error('Die Datenannahme ist nicht aktiviert (DATA_SOURCE=connector setzen).'),
        { status: 404, code: 'ingest_disabled' }
      ));
    }

    if (!config.connector.token) {
      // Sollte durch assertProductionSecrets beim Start verhindert worden sein.
      return next(Object.assign(
        new Error('Kein CONNECTOR_TOKEN konfiguriert.'),
        { status: 503, code: 'ingest_unconfigured' }
      ));
    }

    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);

    if (!match || !tokenMatches(match[1].trim(), config.connector.token)) {
      logger.warn(`Connector-Zugriff abgewiesen von ${req.ip} (${req.method} ${req.originalUrl})`);
      return next(Object.assign(
        new Error('Ungültiges Connector-Token.'),
        { status: 401, code: 'unauthorized' }
      ));
    }

    // Für die Protokollierung des Kontakts.
    req.connector = {
      version: String(req.get('x-connector-version') || '').slice(0, 32),
      ip: req.ip,
    };
    return next();
  };
}

module.exports = { requireConnectorToken, tokenMatches };
