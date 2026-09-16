'use strict';

/**
 * Absicherung der kompletten WebUI und aller REST-Endpunkte.
 *
 * express-basic-auth mit `challenge: true` -> der Browser zeigt den Login-Dialog.
 * Der Passwortvergleich läuft über `safeCompare` (timing-safe) statt `===`.
 */

const basicAuth = require('express-basic-auth');
const config = require('../config');

/**
 * @param {object} [options]
 * @param {string} [options.user]
 * @param {string} [options.password]
 * @param {string} [options.realm]
 * @returns {import('express').RequestHandler}
 */
function createAuthMiddleware(options = {}) {
  const user = options.user || config.auth.user;
  const password = options.password || config.auth.password;
  const realm = options.realm || config.auth.realm;

  if (!password) {
    // Ein Start ohne Passwort würde die WebUI offen ins Netz stellen.
    throw new Error(
      'AUTH_PASSWORD ist nicht gesetzt. Die WebUI darf nicht ohne Authentifizierung starten.'
    );
  }

  return basicAuth({
    users: { [user]: password },
    challenge: true,
    realm,
    // Timing-safe: verhindert das Erraten des Passworts über Laufzeitunterschiede.
    safeCompare: true,
    unauthorizedResponse: () => 'Zugriff verweigert - Anmeldung erforderlich.',
  });
}

module.exports = { createAuthMiddleware };
