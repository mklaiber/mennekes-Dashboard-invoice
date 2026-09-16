'use strict';

/**
 * Express-App-Factory.
 *
 * Als Factory gebaut (und nicht als Singleton), damit `supertest` in den Tests
 * eine frische App mit gemockten Abhängigkeiten erzeugen kann.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { createAuthMiddleware } = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { createApiRouter } = require('./routes/api');
const { createViewRouter } = require('./routes/views');
const MennekesClient = require('./services/mennekesClient');
const LiveFeed = require('./services/liveFeed');

/**
 * @param {object} [deps]
 * @param {MennekesClient} [deps.mennekesClient]
 * @param {LiveFeed} [deps.liveFeed]
 * @param {object} [deps.auth] {user, password} - überschreibt config.auth
 * @returns {{app: import('express').Express, liveFeed: LiveFeed, mennekesClient: MennekesClient}}
 */
function createApp(deps = {}) {
  const mennekesClient = deps.mennekesClient || new MennekesClient();
  const liveFeed = deps.liveFeed || new LiveFeed({ client: mennekesClient });

  const app = express();

  // Hinter einem Reverse-Proxy: echte Client-IP für Rate-Limit und Logging.
  if (config.server.trustProxy) app.set('trust proxy', 1);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  // Kein "X-Powered-By: Express" - unnötige Information über den Stack.
  app.disable('x-powered-by');

  // --------------------------------------------------------------- Sicherheit

  // Pro Request ein CSP-Nonce. Damit können die Views die wenigen nötigen
  // Inline-Skripte (Bootstrap-Daten aus dem Server-Rendering) ausliefern,
  // ohne 'unsafe-inline' für Skripte global freizugeben.
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Tailwind wird per CDN geladen (Play-CDN erzeugt Styles zur Laufzeit,
        // deshalb sind 'unsafe-inline' für Styles und der CDN-Host nötig).
        scriptSrc: [
          "'self'",
          'https://cdn.tailwindcss.com',
          (req, res) => `'nonce-${res.locals.cspNonce}'`,
        ],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // HSTS nur sinnvoll, wenn die App tatsächlich per TLS ausgeliefert wird.
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

  // Brute-Force-Bremse vor der Auth. Im Testbetrieb deaktiviert, sonst
  // laufen parallele Testfälle in das Limit.
  if (!config.isTest) {
    app.use(rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'rate_limited', message: 'Zu viele Anfragen. Bitte später erneut versuchen.' },
    }));
  }

  // ------------------------------------------------ Auth: schützt ALLES ------
  // Bewusst vor allen Routen und vor dem Static-Handler registriert.
  app.use(createAuthMiddleware(deps.auth));

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.isProduction ? '7d' : 0,
    // Keine Verzeichnislistings.
    index: false,
    dotfiles: 'ignore',
  }));

  // ------------------------------------------------------------------ Routen
  app.use('/api', createApiRouter({ liveFeed, mennekesClient }));
  app.use('/', createViewRouter({ liveFeed }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, liveFeed, mennekesClient };
}

module.exports = { createApp };
