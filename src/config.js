'use strict';
const path = require('node:path');

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

function parsePort(v) {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : false; // false = invalid, reported with the other config errors
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

  const maxAttempts = Number(env.SCHEDULE_MAX_ATTEMPTS ?? 2);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) errors.push('SCHEDULE_MAX_ATTEMPTS must be an integer 1-5');
  const retryDelay = Number(env.SCHEDULE_RETRY_DELAY_SECONDS ?? 120);
  if (!Number.isFinite(retryDelay) || retryDelay < 0 || retryDelay > 3600) errors.push('SCHEDULE_RETRY_DELAY_SECONDS must be 0-3600');
  const grace = Number(env.MISSED_RUN_GRACE_MINUTES ?? 120);
  if (!Number.isFinite(grace) || grace < 0 || grace > 1440) errors.push('MISSED_RUN_GRACE_MINUTES must be 0-1440');
  const ackDelay = Number(env.MEDIA_ACK_DELAY_MS ?? 3000);
  if (!Number.isFinite(ackDelay) || ackDelay < 0 || ackDelay > 60000) errors.push('MEDIA_ACK_DELAY_MS must be 0-60000');

  const timezone = env.TIMEZONE || 'Africa/Lagos';
  if (!validTimezone(timezone)) errors.push(`TIMEZONE "${timezone}" is not a valid IANA timezone`);

  const maxMediaMb = Number(env.MAX_MEDIA_MB || 50);
  if (!Number.isFinite(maxMediaMb) || maxMediaMb <= 0 || maxMediaMb > 500) errors.push('MAX_MEDIA_MB must be a number between 1 and 500');

  const dashboardEnabled = String(env.DASHBOARD_ENABLED || 'false').toLowerCase() === 'true';
  if (dashboardEnabled && (env.DASHBOARD_TOKEN || '').length < 16) errors.push('DASHBOARD_TOKEN (16+ chars) is required when DASHBOARD_ENABLED=true');

  // --- AI (Gemini). Enabled by default when a key is configured; the key itself is never validated for shape here.
  const aiProvider = (env.AI_PROVIDER || 'gemini').toLowerCase();
  if (aiProvider !== 'gemini') errors.push('AI_PROVIDER must be "gemini"');
  const geminiKey = (env.GEMINI_API_KEY || '').trim();
  const aiFlag = env.AI_ENABLED === undefined || env.AI_ENABLED === '' ? null : String(env.AI_ENABLED).toLowerCase();
  if (aiFlag !== null && !['true', 'false'].includes(aiFlag)) errors.push('AI_ENABLED must be "true" or "false"');
  const aiWanted = aiFlag === null ? true : aiFlag === 'true';
  const aiTimeout = Number(env.AI_TIMEOUT_MS ?? 20000);
  if (!Number.isFinite(aiTimeout) || aiTimeout < 1000 || aiTimeout > 120000) errors.push('AI_TIMEOUT_MS must be 1000-120000');
  const aiDailyLimit = Number(env.AI_DAILY_REQUEST_LIMIT ?? 300);
  if (!Number.isInteger(aiDailyLimit) || aiDailyLimit < 1 || aiDailyLimit > 100000) errors.push('AI_DAILY_REQUEST_LIMIT must be an integer 1-100000');

  if (parsePort(env.PORT) === false) errors.push('PORT must be a whole number between 1 and 65535');

  if (errors.length) {
    const err = new Error('Invalid configuration:\n - ' + errors.join('\n - '));
    err.code = 'CONFIG_INVALID';
    err.details = errors;
    throw err;
  }

  // On Render the persistent disk is mounted at /var/data (render.yaml). Default to it there so a missing DATA_DIR can never
  // silently put the database and WhatsApp session on the ephemeral filesystem. Locally the default stays ./data.
  const onRender = String(env.RENDER || '').toLowerCase() === 'true';
  const dataDir = path.resolve(env.DATA_DIR || (onRender ? '/var/data' : './data'));
  return Object.freeze({
    ownerPhone, provider, timezone, accountMode, botPhone, ownerLid,
    proposalTtlMs: Math.floor(ttl * 60 * 1000), mediaAckDelayMs: ackDelay, scheduleMaxAttempts: maxAttempts, scheduleRetryDelayMs: Math.floor(retryDelay * 1000), missedRunGraceMs: Math.floor(grace * 60000),
    groupSendDelayMs: Math.floor(delaySec * 1000), maxGroupsPerCampaign: maxGroups, groupDedupeMs: Math.floor(dedupeHours * 3600 * 1000),
    logLevel: env.LOG_LEVEL || 'info',
    dataDir, onRender,
    // Render Web Services inject PORT; the health listener starts only when it is set (a paid worker has no port).
    port: parsePort(env.PORT) || null,
    // EPHEMERAL_OK=true acknowledges that DATA_DIR is NOT persistent (free hosting). It only changes how loudly this is reported.
    ephemeralOk: String(env.EPHEMERAL_OK || '').toLowerCase() === 'true',
    authDir: path.join(dataDir, 'auth_state'),
    dbPath: path.join(dataDir, 'assistant.sqlite'),
    mediaDir: path.join(dataDir, 'media'),
    maxMediaBytes: Math.floor(maxMediaMb * 1024 * 1024),
    dashboardEnabled,
    dashboardToken: env.DASHBOARD_TOKEN || '',
    ai: Object.freeze({
      requested: aiWanted, provider: aiProvider, apiKey: geminiKey,
      enabled: aiWanted && !!geminiKey,
      disabledReason: !aiWanted ? 'AI_ENABLED=false' : (!geminiKey ? 'GEMINI_API_KEY is not set' : null),
      model: (env.GEMINI_MODEL || 'gemini-3.8-flash').trim(),
      timeoutMs: Math.floor(aiTimeout), dailyLimit: aiDailyLimit,
    }),
  });
}

module.exports = { loadConfig, normalizePhone };
