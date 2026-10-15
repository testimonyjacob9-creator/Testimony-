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

/** Provider-neutral media descriptor. `open()` streams the file; no URL is ever exposed or stored. */
function describeMedia(message, type, openMedia) {
  const node = unwrap(message)[`${type}Message`] || {};
  const size = Number(node.fileLength && node.fileLength.toString ? node.fileLength.toString() : node.fileLength);
  return {
    type, mime: node.mimetype, size: Number.isFinite(size) && size > 0 ? size : undefined, fileName: node.fileName, seconds: node.seconds,
    open: openMedia && (type === 'image' || type === 'video') ? () => openMedia(node, type) : undefined,
  };
}

/** Convert a raw Baileys message into the provider-neutral InboundMessage (or null to skip). */
function normalizeMessage(raw, self = {}, openMedia = null) {
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
    text: text || undefined, media: mediaType ? describeMedia(raw.message, mediaType, openMedia) : undefined,
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
    this._handler = null; this._stateHandler = () => {}; this._contactsHandler = () => {};
  }

  onMessage(h) { this._handler = h; }
  onConnectionChange(h) { this._stateHandler = h; }
  onContacts(h) { this._contactsHandler = h; }
  connectionState() { return this.state; }
  capabilities() {
    return { sendText: true, sendMedia: false, publishStatus: true, statusVerification: false, groups: true, receiveMedia: true };
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
    // Contacts are only learned from these events (no contact-list API exists in this Baileys version).
    const feed = (list) => { try { if (Array.isArray(list) && list.length) this._contactsHandler(list.filter((c) => c && c.id)); } catch (e) { this.logger?.error({ err: e.message }, 'contacts handler failed'); } };
    sock.ev.on('contacts.upsert', feed);
    sock.ev.on('contacts.update', feed);
    sock.ev.on('messaging-history.set', (h) => feed(h && h.contacts));
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
      const msg = normalizeMessage(raw, this.self, (node, type) => this._chunks(node, type));
      if (!msg) continue;
      if (type === 'append' && Date.now() - msg.timestamp > 30000) continue; // history sync, not live
      try { await this._handler(msg); } catch (e) { this.logger?.error({ err: e.message }, 'message handler failed'); }
    }
  }

  async *_chunks(node, type) {
    const stream = await this.baileys.downloadContentFromMessage(node, type);
    for await (const chunk of stream) yield chunk;
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
  /**
   * Post to WhatsApp Status. `recipients` (phone JIDs) is MANDATORY: the library encrypts the post to exactly that list.
   * Media is read from a local file path. Returns verified:false always: there is no way to read a Status back.
   */
  async publishStatus({ text, imagePath, videoPath, caption, recipients } = {}) {
    if (this.state !== 'connected' || !this.sock) return { ok: false, verified: false, error: 'not connected' };
    if (!Array.isArray(recipients) || !recipients.length) return { ok: false, verified: false, error: 'no recipients' };
    try {
      let content; const options = { statusJidList: recipients };
      if (imagePath) content = { image: { url: imagePath }, ...(caption ? { caption } : {}) };
      else if (videoPath) content = { video: { url: videoPath }, ...(caption ? { caption } : {}) };
      else if (text) { content = { text }; options.backgroundColor = '#1f6f5c'; options.font = 1; }
      else return { ok: false, verified: false, error: 'nothing to post' };
      const res = await this.sock.sendMessage('status@broadcast', content, options);
      return { ok: true, id: res?.key?.id, verified: false };
    } catch (e) { return { ok: false, verified: false, error: e.message }; }
  }
  selfJid() { return this.self.jid || null; }
  /** The privacy MODE only (e.g. "contacts"); WhatsApp does not expose the exception lists through this library. */
  async getStatusPrivacy() {
    if (this.state !== 'connected' || !this.sock) return { ok: false, error: 'not connected' };
    try { const p = await this.sock.fetchPrivacySettings(true); return p && p.status ? { ok: true, mode: String(p.status) } : { ok: false, error: 'setting not reported' }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  async listGroups() {
    if (this.state !== 'connected' || !this.sock) return { ok: false, groups: [], error: 'not connected' };
    try {
      const map = await this.sock.groupFetchAllParticipating();
      const mine = new Set([this.self.jid, this.self.lid].filter(Boolean));
      const groups = Object.values(map || {}).filter((g) => g && g.id).map((g) => {
        const parts = Array.isArray(g.participants) ? g.participants : [];
        const me = parts.find((p) => mine.has(stripDevice(p.id)));
        const isAdmin = !!me && (me.admin === 'admin' || me.admin === 'superadmin');
        const adminsOnly = !!(g.announce || g.isCommunityAnnounce);
        return {
          id: g.id, name: g.subject || '(unnamed group)', size: Number.isFinite(g.size) ? g.size : (parts.length || null),
          canSend: adminsOnly ? (me ? isAdmin : null) : true, isMember: true,
        };
      });
      return { ok: true, groups };
    } catch (e) { return { ok: false, groups: [], error: e.message }; }
  }
}

module.exports = { BaileysProvider, normalizeMessage, extractText, jidToPhone, backoffMs, toJid };
