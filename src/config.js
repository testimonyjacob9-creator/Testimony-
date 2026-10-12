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

  const rawMode = (env.ACCOUNT_MODE || '').toLowerCase();
  if (rawMode && !['self', 'separate'].includes(rawMode)) errors.push('ACCOUNT_MODE must be "self" or "separate"');
  if (provider === 'baileys' && !rawMode) errors.push('ACCOUNT_MODE ("self" or "separate") is required with WHATSAPP_PROVIDER=baileys - see docs/ACCOUNT_SETUP.md');
  const accountMode = rawMode || 'separate';
  const botPhone = env.BOT_PHONE ? normalizePhone(env.BOT_PHONE) : (accountMode === 'self' ? ownerPhone : null);
  if (env.BOT_PHONE && !botPhone) errors.push('BOT_PHONE is not a valid number');
  if (provider === 'baileys' && accountMode === 'separate' && !botPhone) errors.push('BOT_PHONE is required when ACCOUNT_MODE=separate');
  if (accountMode === 'separate' && botPhone && botPhone === ownerPhone) errors.push('BOT_PHONE must differ from OWNER_PHONE when ACCOUNT_MODE=separate');
  if (accountMode === 'self' && botPhone && botPhone !== ownerPhone) errors.push('BOT_PHONE must equal OWNER_PHONE (or be unset) when ACCOUNT_MODE=self');
  const ownerLid = env.OWNER_LID ? String(env.OWNER_LID).trim() : null;
  if (ownerLid && !/^\d+@lid$/.test(ownerLid)) errors.push('OWNER_LID must look like 123456789@lid');
  const ttl = Number(env.PROPOSAL_TTL_MINUTES || 30);
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 1440) errors.push('PROPOSAL_TTL_MINUTES must be 1-1440');

  const delaySec = Number(env.GROUP_SEND_DELAY_SECONDS ?? 30);
  if (!Number.isFinite(delaySec) || delaySec < 0 || delaySec > 600) errors.push('GROUP_SEND_DELAY_SECONDS must be 0-600');
  const maxGroups = Number(env.MAX_GROUPS_PER_CAMPAIGN || 10);
  if (!Number.isInteger(maxGroups) || maxGroups < 1 || maxGroups > 50) errors.push('MAX_GROUPS_PER_CAMPAIGN must be an integer 1-50');
  const dedupeHours = Number(env.GROUP_DEDUPE_HOURS || 24);
  if (!Number.isFinite(dedupeHours) || dedupeHours < 0 || dedupeHours > 720) errors.push('GROUP_DEDUPE_HOURS must be 0-720');

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
    ownerPhone, provider, timezone, accountMode, botPhone, ownerLid,
    proposalTtlMs: Math.floor(ttl * 60 * 1000),
    groupSendDelayMs: Math.floor(delaySec * 1000), maxGroupsPerCampaign: maxGroups, groupDedupeMs: Math.floor(dedupeHours * 3600 * 1000),
    logLevel: env.LOG_LEVEL || 'info',
    dataDir,
    authDir: path.join(dataDir, 'auth_state'),
    dbPath: path.join(dataDir, 'assistant.sqlite'),
    mediaDir: path.join(dataDir, 'media'),
    maxMediaBytes: Math.floor(maxMediaMb * 1024 * 1024),
    dashboardEnabled,
    dashboardToken: env.DASHBOARD_TOKEN || '',
  });
}

module.exports = { loadConfig, normalizePhone };
