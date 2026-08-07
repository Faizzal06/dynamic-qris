'use strict';

function write(level, message, extra) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}`;
  const stream = level === 'error' ? console.error : console.log;
  if (extra !== undefined) {
    stream(line, extra);
  } else {
    stream(line);
  }
}

module.exports = {
  debug: (m, e) => write('debug', m, e),
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
