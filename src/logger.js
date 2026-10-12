'use strict';
const pino = require('pino');

// Message content, captions and secrets are never logged.
const REDACT = ['*.text', '*.body', '*.caption', '*.token', '*.password', '*.authorization', '*.phone', '*.jid',
  'text', 'body', 'caption', 'token', 'password', 'authorization'];

function createLogger(level = 'info', destination) {
  return pino({ level, redact: { paths: REDACT, censor: '[redacted]' }, base: { app: 'assistant' } }, destination);
}

module.exports = { createLogger, REDACT };
