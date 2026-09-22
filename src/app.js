'use strict';

/**
 * Express-App-Factory.
 *
 * Als Factory gebaut (und nicht als Singleton), damit `supertest` in den Tests
 * eine frische App mit gemockten Abhängigkeiten erzeugen kann.
 *
 * Reihenfolge der Middleware ist hier sicherheitsrelevant:
 *   Header -> Body -> Cookies -> Benutzer anhängen -> CSRF -> öffentliche
 *   Routen (Login) -> Anmeldezwang -> Passwortzwang -> geschützte Routen.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const settingsStore = require('./repositories/settingsRepository');
const {
  attachUser, requireAuth, requireRole, requirePasswordChange, csrfProtection,
} = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { createApiRouter } = require('./routes/api');
const { createViewRouter } = require('./routes/views');
const { createAuthRouter, createAccountRouter } = require('./routes/auth');
const { createUserRouter } = require('./routes/users');
const { createFleetRouter } = require('./routes/fleet');
const { createIngestRouter } = require('./routes/ingest');
const MennekesClient = require('./services/mennekesClient');
const MennekesModbusClient = require('./services/mennekesModbusClient');
const LiveFeed = require('./services/liveFeed');

/**
 * @param {object} [deps]
 * @param {MennekesClient|MennekesModbusClient} [deps.mennekesClient]
 * @param {LiveFeed} [deps.liveFeed]
 * @returns {{app: import('express').Express, liveFeed: LiveFeed, mennekesClient: MennekesClient|MennekesModbusClient}}
 */
function createApp(deps = {}) {
  // AMTRON Professional/ChargeControl & Co. haben keine REST-Schnittstelle,
  // nur Modbus TCP - siehe mennekesModbusClient.js.
  const mennekesClient = deps.mennekesClient
    || (config.mennekes.protocol === 'modbus' ? new MennekesModbusClient() : new MennekesClient());
  const liveFeed = deps.liveFeed || new LiveFeed({ client: mennekesClient });

  const app = express();

  // Hinter einem Reverse-Proxy: echte Client-IP für Rate-Limit und Protokoll.
  if (config.server.trustProxy) app.set('trust proxy', 1);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');

  // --------------------------------------------------------------- Sicherheit

  // Pro Request ein CSP-Nonce für die wenigen nötigen Inline-Skripte
  // (Bootstrap-Daten aus dem Server-Rendering).
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Kein Fremd-Host mehr: das Material-Stylesheet liegt lokal.
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        // 'unsafe-inline' nur für Styles: die Sparkline setzt Attribute per style.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  }));

  app.use(compression({
    // SSE darf nicht komprimiert werden - der Kompressionspuffer würde
    // die Events zurückhalten, bis er voll ist.
    filter: (req, res) => {
      if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  }));

  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());

  if (!config.isTest) {
    app.use(rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
      // Die Datenannahme zaehlt hier NICHT mit. Sie wird im Sekundentakt
      // bedient, waehrend dieses Budget pro IP gilt - und der Connector teilt
      // sich die oeffentliche IP mit den Menschen im selben Heimnetz. Bei 2s
      // Takt verbraeuchte er allein 450 der 600 Anfragen pro Fenster; wer von
      // zu Hause das Dashboard oeffnet, liefe in ein 429, und schlimmer: der
      // Connector selbst auch, womit stillschweigend Messwerte verloren
      // gingen. /api/ingest bringt seinen eigenen, passend bemessenen Limiter
      // mit (siehe routes/ingest.js) und ist ohnehin token-authentifiziert.
      skip: (req) => req.path.startsWith('/api/ingest'),
      message: { error: 'rate_limited', message: 'Zu viele Anfragen. Bitte später erneut versuchen.' },
    }));
  }

  // Statische Dateien vor der Anmeldung: die Login-Seite braucht CSS und Schrift.
  // Hier liegen ausschliesslich öffentliche Assets, keine Daten.
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.isProduction ? '7d' : 0,
    index: false,
    dotfiles: 'ignore',
  }));

  // Einstellungen für JEDE View bereitstellen: die Navigation zeigt den
  // Wallbox-Namen, die Fußzeile den Arbeitspreis. Ohne das müsste jede Route
  // daran denken - und eine vergessene Zuweisung endet in einem 500er.
  app.use((req, res, next) => {
    try {
      res.locals.settings = settingsStore.load();
    } catch {
      // Vor der ersten Migration kann die Tabelle noch leer sein.
      res.locals.settings = settingsStore.defaultSettings();
    }
    res.locals.active = '';
    next();
  });

  // Datenannahme vom Connector: eigene Authentifizierung über ein gemeinsames
  // Geheimnis, deshalb VOR der Benutzeranmeldung. Der Connector ist kein Nutzer
  // und bekommt weder Sitzung noch Rolle.
  app.use('/api/ingest', createIngestRouter({ liveFeed }));

  // ------------------------------------------------- Authentifizierungskette
  app.use(attachUser());
  app.use(csrfProtection());

  // Öffentlich: nur Anmeldung und Abmeldung.
  app.use('/', createAuthRouter());

  // Ab hier ist eine Anmeldung Pflicht.
  app.use(requireAuth());

  // Der Passwortwechsel muss VOR requirePasswordChange stehen, sonst wäre die
  // Seite, auf die dieser Zwang umleitet, selbst gesperrt.
  app.use('/', createAccountRouter());
  app.use(requirePasswordChange());

  // ------------------------------------------------------------------ Routen
  app.use('/', createUserRouter());
  app.use('/', createFleetRouter());
  app.use('/api', createApiRouter({ liveFeed, mennekesClient }));
  app.use('/', createViewRouter({ liveFeed }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, liveFeed, mennekesClient };
}

module.exports = { createApp };
module.exports.requireRole = requireRole;
