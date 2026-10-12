'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { WhatsAppProvider } = require('./provider');

/**
 * UNOFFICIAL WhatsApp Web (linked device) provider built on Baileys.
 * Risks: account restriction, protocol breakage, session must be protected. See docs/PROVIDERS.md.
 * Phase 2 scope: connect/pair, reconnect, receive text, send text. Status/groups/media come later
 * and are reported as unsupported via capabilities() until implemented.
 */

const TERMINAL = new Set(['logged_out', 'replaced', 'bad_session', 'account_mismatch']);
const backoffMs = (attempt) => Math.min(60000, 1000 * 2 ** Math.min(attempt, 6));

const stripDevice = (jid) => (jid ? String(jid).replace(/:\d+@/, '@') : jid);
function jidToPhone(jid) {
  const m = String(jid || '').match(/^(\d{5,20})(?::\d+)?@s\.whatsapp\.net$/);
  return m ? m[1] : null;
}
const isLid = (jid) => /@lid$/.test(String(jid || ''));
const toJid = (to) => (/^\d{5,20}$/.test(String(to)) ? `${to}@s.whatsapp.net` : String(to));

function unwrap(message) {
  let m = message || {};
  for (let i = 0; i < 4; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message;
    if (!inner) break; m = inner;
  }
  return m;
}
function extractText(message) {
  const m = unwrap(message);
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '';
}
function mediaTypeOf(message) {
  const m = unwrap(message);
  if (m.imageMessage) return 'image'; if (m.videoMessage) return 'video'; if (m.audioMessage) return 'audio';
  if (m.documentMessage) return 'document'; if (m.stickerMessage) return 'sticker';
  return null;
}

/** Convert a raw Baileys message into the provider-neutral InboundMessage (or null to skip). */
function normalizeMessage(raw, self = {}) {
  const key = raw && raw.key; if (!key || !key.remoteJid || !raw.message) return null;
  const chat = key.remoteJid;
  if (chat === 'status@broadcast' || chat.endsWith('@broadcast') || chat.endsWith('@newsletter')) return null;
  const isGroup = chat.endsWith('@g.us');
  const text = extractText(raw.message);
  const mediaType = mediaTypeOf(raw.message);
  if (!text && !mediaType) return null; // reactions, protocol messages, etc.
  const fromMe = !!key.fromMe;
  const senderJid = isGroup ? key.participant : (fromMe ? (self.jid || null) : chat);
  let from = jidToPhone(senderJid); let fromLid = null;
  if (!from && isLid(senderJid)) {
    fromLid = stripDevice(senderJid);
    from = jidToPhone(key.senderPn || key.participantPn || key.remoteJidAlt || key.participantAlt);
  }
  if (!from && fromMe && self.phone) from = self.phone;
  const chatPhone = jidToPhone(chat);
  const chatIsSelf = !isGroup && ((!!self.phone && chatPhone === self.phone) || (!!self.lid && stripDevice(chat) === self.lid));
  const ts = Number(raw.messageTimestamp && raw.messageTimestamp.toString ? raw.messageTimestamp.toString() : raw.messageTimestamp) * 1000;
  return {
    id: key.id, from, fromLid, chat, chatIsSelf, isGroup, fromMe,
    text: text || undefined, media: mediaType ? { type: mediaType } : undefined,
    timestamp: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
  };
}

class BaileysProvider extends WhatsAppProvider {
  constructor({ config, logger, baileys, timers } = {}) {
    super();
    this.config = config; this.logger = logger;
    this.baileys = baileys || require('baileys');
    this.timers = timers || { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
    this.state = 'disconnected'; this.sock = null; this.attempt = 0; this.closing = false;
    this.pairingRequested = false; this.reconnectTimer = null; this.self = {};
    this._handler = null; this._stateHandler = () => {};
  }

  onMessage(h) { this._handler = h; }
  onConnectionChange(h) { this._stateHandler = h; }
  connectionState() { return this.state; }
  capabilities() {
    return { sendText: true, sendMedia: false, publishStatus: false, statusVerification: false, groups: false, receiveMedia: false };
  }
  _set(s) { if (this.state !== s) { this.state = s; try { this._stateHandler(s); } catch (e) { this.logger?.error({ err: e.message }, 'state handler failed'); } } }

  _hardenAuthDir() {
    const dir = this.config.authDir;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
      for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o600);
    } catch (e) { this.logger?.warn({ err: e.message }, 'could not tighten auth dir permissions'); }
  }

  async connect() { this.closing = false; this._hardenAuthDir(); await this._start(); }

  async disconnect() {
    this.closing = true;
    if (this.reconnectTimer) { this.timers.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.sock?.end?.(undefined); } catch { /* ignore */ }
    this.sock = null; this._set('disconnected');
  }

  /** Unlink this session from the phone and delete local credentials. */
  async logout() {
    this.closing = true;
    try { await this.sock?.logout?.(); } catch (e) { this.logger?.warn({ err: e.message }, 'logout request failed; remove the linked device from your phone manually'); }
    try { fs.rmSync(this.config.authDir, { recursive: true, force: true }); } catch { /* ignore */ }
    this.sock = null; this._set('logged_out');
  }

  async _start() {
    const b = this.baileys;
    const makeSocket = b.default || b.makeWASocket;
    const { state, saveCreds } = await b.useMultiFileAuthState(this.config.authDir);
    let version; try { ({ version } = await b.fetchLatestBaileysVersion()); } catch { /* use bundled default */ }
    this._set('connecting');
    const sock = makeSocket({
      auth: state, ...(version ? { version } : {}), printQRInTerminal: false,
      browser: b.Browsers?.ubuntu ? b.Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4'],
      logger: this.baileysLogger(), markOnlineOnConnect: false, syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', async () => { try { await saveCreds(); this._hardenAuthDir(); } catch (e) { this.logger?.error({ err: e.message }, 'saving credentials failed'); } });
    sock.ev.on('connection.update', (u) => this._onConnectionUpdate(sock, state, u));
    sock.ev.on('messages.upsert', (ev) => this._onUpsert(ev));
  }

  baileysLogger() {
    const noop = () => {}; const l = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
    l.child = () => l; return l; // never let the library log credentials/messages
  }

  async _onConnectionUpdate(sock, authState, u) {
    if (sock !== this.sock) return; // stale socket
    if (u.qr && !authState.creds.registered && !this.pairingRequested) {
      this.pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(this.config.botPhone);
        const pretty = String(code).replace(/(.{4})(?=.)/, '$1-');
        // Printed to the console ONLY (never to log files). Valid for a short time.
        console.log(`\nWhatsApp pairing code: ${pretty}\nOn the phone for ${this.config.botPhone}: WhatsApp > Linked devices > Link a device > Link with phone number instead.\n`);
        this._set('awaiting_pairing');
      } catch (e) { this.pairingRequested = false; this.logger?.error({ err: e.message }, 'pairing code request failed'); }
    }
    if (u.connection === 'open') {
      const me = sock.user || {};
      this.self = { jid: stripDevice(me.id), phone: jidToPhone(me.id), lid: stripDevice(me.lid) };
      const owner = this.config.ownerPhone;
      const ok = this.config.accountMode === 'self' ? this.self.phone === owner : (this.self.phone && this.self.phone !== owner);
      if (!ok) {
        this.logger?.error({ mode: this.config.accountMode }, 'linked account does not match ACCOUNT_MODE/OWNER_PHONE; disconnecting');
        this.closing = true; try { sock.end?.(undefined); } catch { /* ignore */ }
        this._set('account_mismatch'); return;
      }
      this.attempt = 0; this._set('connected');
    }
    if (u.connection === 'close') {
      if (this.closing && this.state === 'account_mismatch') return;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const D = this.baileys.DisconnectReason || {};
      if (code === D.loggedOut) return this._terminal('logged_out');
      if (code === D.connectionReplaced) return this._terminal('replaced');
      if (code === D.badSession) return this._terminal('bad_session');
      if (this.closing) return this._set('disconnected');
      this._set('reconnecting');
      const delay = code === D.restartRequired ? 0 : backoffMs(this.attempt++);
      this.reconnectTimer = this.timers.setTimeout(() => { this.reconnectTimer = null; this._start().catch((e) => { this.logger?.error({ err: e.message }, 'reconnect failed'); this._scheduleRetry(); }); }, delay);
    }
  }
  _scheduleRetry() {
    if (this.closing || TERMINAL.has(this.state)) return;
    this.reconnectTimer = this.timers.setTimeout(() => { this.reconnectTimer = null; this._start().catch(() => this._scheduleRetry()); }, backoffMs(this.attempt++));
  }
  _terminal(state) {
    this.closing = true; this._set(state);
    this.logger?.error({ state }, 'connection ended and will NOT auto-reconnect (re-pair: see docs/SECURITY.md)');
  }

  async _onUpsert({ messages, type }) {
    if (!this._handler || !Array.isArray(messages)) return;
    if (type !== 'notify' && type !== 'append') return;
    for (const raw of messages) {
      const msg = normalizeMessage(raw, this.self);
      if (!msg) continue;
      if (type === 'append' && Date.now() - msg.timestamp > 30000) continue; // history sync, not live
      try { await this._handler(msg); } catch (e) { this.logger?.error({ err: e.message }, 'message handler failed'); }
    }
  }

  async sendText(to, text) {
    if (this.state !== 'connected' || !this.sock) return { ok: false, verified: false, error: 'not connected' };
    try {
      const res = await this.sock.sendMessage(toJid(to), { text });
      // verified = WhatsApp's server accepted the message. Delivery/read is NOT confirmed.
      return { ok: true, id: res?.key?.id, verified: true };
    } catch (e) { return { ok: false, verified: false, error: e.message }; }
  }
  async sendMedia() { return { ok: false, verified: false, error: 'media sending is not implemented yet (Phase 3/4)' }; }
  async publishStatus() { return { ok: false, verified: false, error: 'status publishing is not implemented yet (Phase 4)' }; }
  async listGroups() { return []; }
}

module.exports = { BaileysProvider, normalizeMessage, extractText, jidToPhone, backoffMs, toJid };
