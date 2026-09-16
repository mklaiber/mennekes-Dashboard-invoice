'use strict';

/**
 * Jest-Setup: läuft VOR den Testmodulen und damit vor dem ersten
 * `require('../src/config')`. Die Konfiguration liest die ENV beim Import,
 * deshalb müssen die Werte hier bereits stehen.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.TZ = 'Europe/Berlin';

process.env.AUTH_USER = 'testadmin';
process.env.AUTH_PASSWORD = 'test-passwort-1234';
process.env.AUTH_MIN_PASSWORD_LENGTH = '12';
// Secure-Cookies würden über HTTP im Test nie gesetzt.
process.env.SESSION_COOKIE_SECURE = 'false';

process.env.MENNEKES_BASE_URL = 'http://wallbox.test';
process.env.MENNEKES_AUTH_MODE = 'none';

process.env.PRICE_PER_KWH = '0.30';
process.env.CURRENCY = 'EUR';
process.env.MAIL_FROM = 'wallbox@example.com';
process.env.MAIL_TO = 'buchhaltung@example.com';

process.env.CRON_ENABLED = 'false';

// Jede Testdatei bekommt ein eigenes Arbeitsverzeichnis - keine Kollisionen,
// keine Reste im Projektordner. Die Datenbank läuft im Speicher.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallbox-test-'));
process.env.OUTPUT_DIR = path.join(tempRoot, 'reports');
process.env.SETTINGS_FILE = path.join(tempRoot, 'settings.json');
process.env.DATABASE_FILE = ':memory:';
process.env.DOTENV_PATH = path.join(tempRoot, '.env.absent');

global.__TEST_TEMP_ROOT__ = tempRoot;
