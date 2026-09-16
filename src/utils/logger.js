'use strict';

/**
 * Minimalistischer, abhängigkeitsfreier Logger mit Level-Filter.
 * Ausgabe als eine Zeile pro Eintrag (docker logs / journalctl freundlich).
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function currentLevel() {
  // Direkt aus der ENV lesen statt aus config/index -> vermeidet Zirkel-Import.
  const configured = (process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info')).toLowerCase();
  return LEVELS[configured] ?? LEVELS.info;
}

function emit(level, stream, args) {
  if (currentLevel() < LEVELS[level]) return;
  const timestamp = new Date().toISOString();
  // eslint-disable-next-line no-console
  console[stream](`${timestamp} [${level.toUpperCase()}]`, ...args);
}

module.exports = {
  error: (...args) => emit('error', 'error', args),
  warn: (...args) => emit('warn', 'warn', args),
  info: (...args) => emit('info', 'log', args),
  debug: (...args) => emit('debug', 'log', args),
  LEVELS,
};
