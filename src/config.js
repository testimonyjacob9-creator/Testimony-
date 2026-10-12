'use strict';
const path = require('node:path');

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

function loadConfig(env = process.env) {
  const errors = [];
  const ownerPhone = normalizePhone(env.OWNER_PHONE);
  if (!ownerPhone) errors.push('OWNER_PHONE is required (digits only, international format, 8-15 digits)');

  const provider = (env.WHATSAPP_PROVIDER || 'mock').toLowerCase();
  if (!['mock', 'baileys'].includes(provider)) errors.push('WHATSAPP_PROVIDER must be "mock" or "baileys"');

  const timezone = env.TIMEZONE || 'Africa/Lagos';
  if (!validTimezone(timezone)) errors.push(`TIMEZONE "${timezone}" is not a valid IANA timezone`);

  const maxMediaMb = Number(env.MAX_MEDIA_MB || 50);
  if (!Number.isFinite(maxMediaMb) || maxMediaMb <= 0 || maxMediaMb > 500) errors.push('MAX_MEDIA_MB must be a number between 1 and 500');

  const dashboardEnabled = String(env.DASHBOARD_ENABLED || 'false').toLowerCase() === 'true';
  if (dashboardEnabled && (env.DASHBOARD_TOKEN || '').length < 16) errors.push('DASHBOARD_TOKEN (16+ chars) is required when DASHBOARD_ENABLED=true');

  if (errors.length) {
    const err = new Error('Invalid configuration:\n - ' + errors.join('\n - '));
    err.code = 'CONFIG_INVALID';
    err.details = errors;
    throw err;
  }

  const dataDir = path.resolve(env.DATA_DIR || './data');
  return Object.freeze({
    ownerPhone, provider, timezone,
    logLevel: env.LOG_LEVEL || 'info',
    dataDir,
    dbPath: path.join(dataDir, 'assistant.sqlite'),
    mediaDir: path.join(dataDir, 'media'),
    maxMediaBytes: Math.floor(maxMediaMb * 1024 * 1024),
    dashboardEnabled,
    dashboardToken: env.DASHBOARD_TOKEN || '',
  });
}

module.exports = { loadConfig, normalizePhone };
