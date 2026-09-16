'use strict';

/**
 * Datenbank-Helfer für Tests.
 *
 * Jede Testdatei bekommt von Jest eine eigene Modulregistrierung, die
 * In-Memory-Datenbank ist also pro Datei isoliert. `resetDatabase()` stellt
 * zwischen einzelnen Tests wieder einen leeren Ausgangszustand her.
 */

const database = require('../../src/db');
const settingsStore = require('../../src/repositories/settingsRepository');
const users = require('../../src/repositories/userRepository');

/**
 * Verwirft die Datenbank und legt ein frisches, migriertes Schema an.
 * @returns {import('better-sqlite3').Database}
 */
function resetDatabase() {
  database.close();
  settingsStore.reset();
  return database.open(':memory:');
}

/**
 * Legt einen Benutzer an (Standard: Administrator).
 * @param {{username?:string, password?:string, role?:string, mustChangePassword?:boolean}} [options]
 * @returns {Promise<object>}
 */
async function createUser(options = {}) {
  return users.create({
    username: options.username || 'testadmin',
    password: options.password || 'test-passwort-1234',
    role: options.role || 'admin',
    displayName: options.displayName || '',
    mustChangePassword: options.mustChangePassword === true,
  });
}

/**
 * Meldet einen Benutzer über die echte Login-Route an.
 *
 * Gibt einen supertest-Agent zurück, der das Sitzungs-Cookie hält, sowie das
 * CSRF-Token aus der gerenderten Seite - ohne das schlagen alle schreibenden
 * Anfragen fehl.
 *
 * @param {import('supertest')} request supertest-Modul
 * @param {import('express').Express} app
 * @param {{username?:string, password?:string}} [credentials]
 * @returns {Promise<{agent:object, csrfToken:string}>}
 */
async function login(request, app, credentials = {}) {
  const agent = request.agent(app);

  const response = await agent
    .post('/login')
    .type('form')
    .send({
      username: credentials.username || 'testadmin',
      password: credentials.password || 'test-passwort-1234',
    });

  if (response.status !== 302) {
    throw new Error(`Anmeldung fehlgeschlagen: HTTP ${response.status}`);
  }

  // Das CSRF-Token steht im Meta-Tag jeder gerenderten Seite.
  const page = await agent.get(credentials.tokenFrom || '/');
  const match = /<meta name="csrf-token" content="([^"]+)"/.exec(page.text);

  return { agent, csrfToken: match ? match[1] : '' };
}

module.exports = { resetDatabase, createUser, login };
