'use strict';
const { WhatsAppProvider } = require('./provider');

/** Development/test provider. Sends nothing to the real world; records everything. */
class MockProvider extends WhatsAppProvider {
  constructor() {
    super();
    this.state = 'disconnected';
    this.sent = [];
    this.statuses = [];
    this.failNext = null;
    this._handler = null;
    this._stateHandler = () => {};
  }
  async connect() { this._set('connected'); }
  async disconnect() { this._set('disconnected'); }
  onMessage(h) { this._handler = h; }
  onConnectionChange(h) { this._stateHandler = h; }
  connectionState() { return this.state; }
  _set(s) { this.state = s; this._stateHandler(s); }
  _guard() {
    if (this.state !== 'connected') return { ok: false, verified: false, error: 'not connected' };
    if (this.failNext) { const error = this.failNext; this.failNext = null; return { ok: false, verified: false, error }; }
    return null;
  }
  async sendText(jid, text) {
    const bad = this._guard(); if (bad) return bad;
    const id = `mock-${this.sent.length + 1}`;
    this.sent.push({ id, jid, text });
    return { ok: true, id, verified: true };
  }
  async sendMedia(jid, media) {
    const bad = this._guard(); if (bad) return bad;
    const id = `mock-${this.sent.length + 1}`;
    this.sent.push({ id, jid, media });
    return { ok: true, id, verified: true };
  }
  async publishStatus(content) {
    const bad = this._guard(); if (bad) return bad;
    const id = `mock-status-${this.statuses.length + 1}`;
    this.statuses.push({ id, content });
    return { ok: true, id, verified: false }; // mock cannot truly verify, mirrors real limits
  }
  async listGroups() { return []; }
  capabilities() {
    return { sendText: true, sendMedia: true, publishStatus: true, statusVerification: false, groups: true, receiveMedia: true };
  }
  /** Test helper: simulate an incoming message. */
  async simulateInbound(msg) {
    if (!this._handler) throw new Error('no handler registered');
    await this._handler({ id: `in-${Date.now()}`, isGroup: false, fromMe: false, timestamp: Date.now(), ...msg });
  }
}

module.exports = { MockProvider };
