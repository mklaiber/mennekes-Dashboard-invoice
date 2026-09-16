'use strict';

/**
 * Zentrale Fehlerbehandlung.
 *
 * Nach außen wird nur eine generische Meldung ausgegeben - Stacktraces und
 * interne Pfade gehören ins Log, nicht in die HTTP-Antwort.
 */

const logger = require('../utils/logger');
const config = require('../config');

/** 404-Handler - muss NACH allen Routen registriert werden. */
function notFoundHandler(req, res) {
  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    return res.status(404).render('error', {
      title: 'Nicht gefunden',
      status: 404,
      message: 'Diese Seite existiert nicht.',
    });
  }
  return res.status(404).json({ error: 'not_found', message: 'Endpunkt nicht gefunden.' });
}

/**
 * Express-Fehlerhandler (4 Parameter sind zwingend, sonst erkennt Express ihn nicht).
 * @type {import('express').ErrorRequestHandler}
 */
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  if (status >= 500) logger.error(`${req.method} ${req.originalUrl} ->`, err.stack || err.message);
  else logger.warn(`${req.method} ${req.originalUrl} -> ${status}: ${err.message}`);

  // Antwort läuft bereits -> an Express delegieren, der die Verbindung schließt.
  if (res.headersSent) return next(err);

  const payload = {
    error: err.code || (status >= 500 ? 'internal_error' : 'request_error'),
    message: status >= 500 && config.isProduction
      ? 'Interner Serverfehler. Details siehe Server-Log.'
      : err.message,
  };

  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    return res.status(status).render('error', {
      title: 'Fehler',
      status,
      message: payload.message,
    });
  }
  return res.status(status).json(payload);
}

/**
 * Wrapper für async-Routen: fängt Promise-Rejections und leitet sie an next().
 * Ohne das würde ein abgelehntes Promise als unhandledRejection verpuffen.
 * @param {Function} handler
 * @returns {import('express').RequestHandler}
 */
function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { errorHandler, notFoundHandler, asyncHandler };
