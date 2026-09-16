'use strict';

/**
 * Optionen des Add-ons.
 *
 * run.sh reicht die Home-Assistant-Konfiguration als Umgebungsvariablen
 * weiter. Hier werden sie eingelesen, geprüft und in eine feste Form gebracht -
 * lieber beim Start sauber abbrechen als Stunden später beim ersten Senden.
 */

/** @returns {string|undefined} */
function raw(name) {
  const value = process.env[name];
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  // bashio liefert für leere Optionen den Text "null".
  return trimmed === '' || trimmed === 'null' ? undefined : trimmed;
}

function str(name, fallback) {
  return raw(name) ?? fallback;
}

function int(name, fallback) {
  const value = raw(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name, fallback) {
  const value = raw(name);
  if (value === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
}

/** Entfernt abschließende Schrägstriche, damit URLs nicht doppelt getrennt werden. */
function trimUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

/**
 * Liest und prüft die Konfiguration.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {object}
 * @throws {Error} bei fehlenden oder widersprüchlichen Angaben
 */
function load() {
  const options = {
    wallbox: {
      baseUrl: trimUrl(str('WALLBOX_URL', '')),
      authMode: str('WALLBOX_AUTH_MODE', 'none').toLowerCase(),
      username: raw('WALLBOX_USERNAME'),
      password: raw('WALLBOX_PASSWORD'),
      token: raw('WALLBOX_TOKEN'),
      verifyTls: bool('WALLBOX_VERIFY_TLS', true),
      endpoints: {
        status: str('ENDPOINT_STATUS', '/api/v1/status'),
        sessions: str('ENDPOINT_SESSIONS', '/api/v1/transactions'),
        meter: raw('ENDPOINT_METER'),
      },
      timeoutMs: int('WALLBOX_TIMEOUT_MS', 8000),
    },
    target: {
      baseUrl: trimUrl(str('TARGET_URL', '')),
      token: raw('TARGET_TOKEN'),
      verifyTls: bool('VERIFY_TLS', true),
      timeoutMs: int('TARGET_TIMEOUT_MS', 15000),
    },
    statusIntervalMs: int('STATUS_INTERVAL_SECONDS', 10) * 1000,
    sessionsIntervalMs: int('SESSIONS_INTERVAL_SECONDS', 900) * 1000,
    historyDays: int('HISTORY_DAYS', 45),
    stateDir: str('STATE_DIR', '/data'),
    version: str('CONNECTOR_VERSION', '1.0.0'),
  };

  const problems = [];

  if (!options.wallbox.baseUrl) problems.push('wallbox_url ist nicht gesetzt.');
  else if (!/^https?:\/\//i.test(options.wallbox.baseUrl)) {
    problems.push('wallbox_url muss mit http:// oder https:// beginnen.');
  }

  if (!options.target.baseUrl) problems.push('target_url ist nicht gesetzt.');
  else if (!/^https?:\/\//i.test(options.target.baseUrl)) {
    problems.push('target_url muss mit http:// oder https:// beginnen.');
  }

  if (!options.target.token) {
    problems.push('target_token ist nicht gesetzt - ohne das gemeinsame Geheimnis weist das Online-Tool jede Sendung ab.');
  }

  if (options.wallbox.authMode === 'basic' && !options.wallbox.username) {
    problems.push('wallbox_auth_mode ist "basic", aber wallbox_username fehlt.');
  }
  if (['bearer', 'apikey'].includes(options.wallbox.authMode) && !options.wallbox.token) {
    problems.push(`wallbox_auth_mode ist "${options.wallbox.authMode}", aber wallbox_token fehlt.`);
  }

  // Das Ziel steht im Internet. Unverschlüsselt ginge das gemeinsame Geheimnis
  // im Klartext über die Leitung - dann lieber gar nicht erst starten.
  if (options.target.baseUrl.startsWith('http://')
      && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(options.target.baseUrl)) {
    problems.push(
      'target_url verwendet http:// ohne TLS. Das Token würde im Klartext übertragen. '
      + 'Bitte https:// verwenden.'
    );
  }

  if (problems.length > 0) {
    throw new Error(`Konfiguration unvollständig:\n  - ${problems.join('\n  - ')}`);
  }

  return options;
}

module.exports = { load, trimUrl };
