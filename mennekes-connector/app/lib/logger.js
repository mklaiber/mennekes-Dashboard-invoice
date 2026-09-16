'use strict';

/**
 * Logger im Format, das Home Assistant in der Add-on-Ansicht erwartet.
 * Bewusst ohne Abhängigkeit - das Image soll klein bleiben.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold() {
  return LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
}

function emit(level, stream, args) {
  if (LEVELS[level] < threshold()) return;
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console[stream](`[${time}] ${level.toUpperCase().padEnd(5)}: ${args.join(' ')}`);
}

module.exports = {
  debug: (...args) => emit('debug', 'log', args),
  info: (...args) => emit('info', 'log', args),
  warn: (...args) => emit('warn', 'warn', args),
  error: (...args) => emit('error', 'error', args),
};
