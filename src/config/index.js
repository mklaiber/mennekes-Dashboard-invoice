'use strict';

/**
 * Zentrale Konfiguration.
 *
 * Zwei Ebenen:
 *  1. ENV (.env / Ansible / Docker)  -> Secrets + Infrastruktur. Niemals im Repo, nie über die WebUI änderbar.
 *  2. settings.json (siehe ./settings.js) -> nicht-sensible Laufzeitkonfiguration, über die WebUI pflegbar.
 *
 * Diese Datei kapselt ausschließlich Ebene 1.
 */

const path = require('path');
const dotenv = require('dotenv');

// .env nur laden, wenn vorhanden. In Docker/Ansible kommen die Werte aus der Container-Umgebung.
dotenv.config({ path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '.env') });

/** @returns {string|undefined} getrimmter Wert oder undefined, wenn leer/nicht gesetzt. */
function raw(name) {
  const value = process.env[name];
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

function str(name, fallback) {
  return raw(name) ?? fallback;
}

function int(name, fallback) {
  const value = raw(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Konfigurationsfehler: ${name}="${value}" ist keine ganze Zahl.`);
  }
  return parsed;
}

function bool(name, fallback) {
  const value = raw(name);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function list(name, fallback = []) {
  const value = raw(name);
  if (value === undefined) return fallback;
  return value
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const NODE_ENV = str('NODE_ENV', 'development');

const config = {
  env: NODE_ENV,
  isProduction: NODE_ENV === 'production',
  isTest: NODE_ENV === 'test',

  server: {
    port: int('PORT', 3000),
    host: str('HOST', '0.0.0.0'),
    // Hinter einem Reverse-Proxy (nginx/Traefik) nötig, damit rate-limit & Secure-Cookies korrekt arbeiten.
    trustProxy: bool('TRUST_PROXY', false),
    // Verzeichnis für generierte PDFs/CSVs. Im Container als Volume gemountet.
    outputDir: path.resolve(str('OUTPUT_DIR', path.join(process.cwd(), 'data', 'reports'))),
    // SQLite-Datei: Nutzer, Sitzungen, Einstellungen, RFID-Zuordnung, Protokoll.
    // ':memory:' ist ein Sonderwert von SQLite und darf NICHT aufgelöst werden -
    // path.resolve() machte daraus sonst eine echte Datei namens ":memory:".
    databaseFile: (() => {
      const value = str('DATABASE_FILE', path.join(process.cwd(), 'data', 'wallbox.sqlite'));
      return value === ':memory:' ? value : path.resolve(value);
    })(),
    // Alt-Bestand aus der Dateiversion: wird beim ersten Start einmalig
    // in die Datenbank übernommen und danach nicht mehr gelesen.
    settingsFile: path.resolve(str('SETTINGS_FILE', path.join(process.cwd(), 'data', 'settings.json'))),
    logLevel: str('LOG_LEVEL', NODE_ENV === 'test' ? 'silent' : 'info'),
  },

  auth: {
    // Start-Administrator. Wird nur angelegt, solange die Nutzertabelle leer ist -
    // danach ist die Datenbank fuehrend und eine Aenderung hier bleibt wirkungslos.
    user: str('AUTH_USER', 'admin'),
    // Kein Default-Passwort: Fehlt das Secret, verweigert assertProductionSecrets() den Start.
    password: raw('AUTH_PASSWORD'),
    realm: str('AUTH_REALM', 'Mennekes Wallbox Abrechnung'),
    // Lebensdauer einer angemeldeten Sitzung.
    sessionTtlHours: int('SESSION_TTL_HOURS', 12),
    // "Angemeldet bleiben" verlaengert die Sitzung auf diesen Wert.
    rememberTtlDays: int('SESSION_REMEMBER_DAYS', 30),
    cookieName: str('SESSION_COOKIE_NAME', 'wb_session'),
    // Secure-Flag: nur ueber HTTPS ausliefern. Hinter reinem HTTP im LAN
    // muss das abschaltbar sein, sonst kommt das Cookie nie an.
    cookieSecure: bool('SESSION_COOKIE_SECURE', NODE_ENV === 'production'),
    // Brute-Force-Bremse: nach so vielen Fehlversuchen wird das Konto gesperrt.
    maxFailedAttempts: int('AUTH_MAX_FAILED_ATTEMPTS', 8),
    lockMinutes: int('AUTH_LOCK_MINUTES', 15),
    minPasswordLength: int('AUTH_MIN_PASSWORD_LENGTH', 12),
    // Basic-Auth fuer maschinelle Zugriffe (Healthcheck, Skripte) zulassen.
    allowBasicAuthForApi: bool('AUTH_ALLOW_BASIC_API', true),
  },

  mennekes: {
    baseUrl: str('MENNEKES_BASE_URL', 'http://192.168.1.50'),
    // Auth-Varianten: 'none' | 'basic' | 'bearer' | 'apikey'
    authMode: str('MENNEKES_AUTH_MODE', 'none').toLowerCase(),
    username: raw('MENNEKES_USERNAME'),
    password: raw('MENNEKES_PASSWORD'),
    token: raw('MENNEKES_TOKEN'),
    apiKeyHeader: str('MENNEKES_API_KEY_HEADER', 'X-API-Key'),
    timeoutMs: int('MENNEKES_TIMEOUT_MS', 8000),
    retries: int('MENNEKES_RETRIES', 2),
    // TLS-Verifikation nur abschalten, wenn die Wallbox ein selbstsigniertes Zertifikat nutzt.
    rejectUnauthorized: bool('MENNEKES_TLS_REJECT_UNAUTHORIZED', true),
    // Die konkreten Pfade unterscheiden sich je nach Firmware-Generation und sind deshalb konfigurierbar.
    endpoints: {
      status: str('MENNEKES_ENDPOINT_STATUS', '/api/v1/status'),
      // Optional: manche Firmwares liefern Leistung/Zählerstand getrennt vom Status.
      meter: raw('MENNEKES_ENDPOINT_METER'),
      sessions: str('MENNEKES_ENDPOINT_SESSIONS', '/api/v1/transactions'),
    },
    // Query-Parameternamen für die Zeitraumfilterung der Historie.
    sessionQuery: {
      fromParam: str('MENNEKES_SESSIONS_FROM_PARAM', 'from'),
      toParam: str('MENNEKES_SESSIONS_TO_PARAM', 'to'),
      limitParam: str('MENNEKES_SESSIONS_LIMIT_PARAM', 'limit'),
      limit: int('MENNEKES_SESSIONS_LIMIT', 1000),
    },
  },

  smtp: {
    host: str('SMTP_HOST', 'localhost'),
    port: int('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: raw('SMTP_USER'),
    password: raw('SMTP_PASSWORD'),
    // Für Mailserver mit selbstsigniertem Zertifikat.
    rejectUnauthorized: bool('SMTP_TLS_REJECT_UNAUTHORIZED', true),
  },

  mail: {
    from: str('MAIL_FROM', 'wallbox@example.com'),
    // Empfänger können zusätzlich in der WebUI gepflegt werden; ENV ist der Startwert.
    to: list('MAIL_TO'),
    cc: list('MAIL_CC'),
    subjectPrefix: str('MAIL_SUBJECT_PREFIX', 'Ladestrom-Abrechnung'),
  },

  billing: {
    // Startwerte für settings.json. Danach ist die WebUI führend.
    pricePerKwh: Number.parseFloat(str('PRICE_PER_KWH', '0.30')),
    currency: str('CURRENCY', 'EUR'),
    locale: str('LOCALE', 'de-DE'),
    timezone: str('TZ', 'Europe/Berlin'),
    companyName: str('COMPANY_NAME', ''),
    employeeName: str('EMPLOYEE_NAME', ''),
    vehiclePlate: str('VEHICLE_PLATE', ''),
    logoUrl: raw('LOGO_URL'),
  },

  scheduler: {
    enabled: bool('CRON_ENABLED', true),
    // Standard: letzter Tag des Monats um 23:30 Uhr. node-cron erlaubt 'L' nicht,
    // deshalb läuft der Job täglich und prüft selbst, ob heute der Monatsletzte ist.
    cronExpression: str('CRON_EXPRESSION', '30 23 * * *'),
    // 'last-day-of-month' | 'always' - steuert die Selbstprüfung im Job.
    runPolicy: str('CRON_RUN_POLICY', 'last-day-of-month'),
    timezone: str('TZ', 'Europe/Berlin'),
  },

  live: {
    // Poll-Intervall gegen die Wallbox-API für das Live-Dashboard.
    pollIntervalMs: int('LIVE_POLL_INTERVAL_MS', 5000),
    // Heartbeat-Kommentar, damit Proxies die SSE-Verbindung nicht kappen.
    heartbeatMs: int('LIVE_HEARTBEAT_MS', 25000),
  },

  puppeteer: {
    executablePath: raw('PUPPETEER_EXECUTABLE_PATH'),
    // Im Container ohne eigenen Sandbox-User nötig.
    noSandbox: bool('PUPPETEER_NO_SANDBOX', false),
  },
};

/**
 * Harte Pflichtfelder für den Produktivbetrieb.
 * Bewusst *nicht* beim Import geprüft, damit Tests und `--help`-artige Aufrufe funktionieren.
 *
 * @param {object} [cfg=config]
 * @throws {Error} wenn ein Secret fehlt.
 */
function assertProductionSecrets(cfg = config) {
  const missing = [];
  if (!cfg.auth.password) missing.push('AUTH_PASSWORD');
  if (!cfg.mennekes.baseUrl) missing.push('MENNEKES_BASE_URL');
  if (cfg.mennekes.authMode === 'basic' && !cfg.mennekes.password) missing.push('MENNEKES_PASSWORD');
  if (['bearer', 'apikey'].includes(cfg.mennekes.authMode) && !cfg.mennekes.token) missing.push('MENNEKES_TOKEN');

  if (missing.length > 0) {
    throw new Error(
      `Fehlende Pflicht-Umgebungsvariablen: ${missing.join(', ')}. ` +
        'Bitte .env befüllen (Vorlage: .env.example) oder per Ansible/Docker injizieren.'
    );
  }
}

module.exports = config;
module.exports.assertProductionSecrets = assertProductionSecrets;
