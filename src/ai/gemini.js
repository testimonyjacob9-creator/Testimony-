'use strict';
/**
 * Thin wrapper around Google's official @google/genai SDK. Responsibilities:
 *  - never leak the API key (errors are scrubbed, the key is never logged or returned)
 *  - classify failures (AI_AUTH, AI_RATE, AI_TIMEOUT, AI_UNAVAILABLE, AI_BAD_OUTPUT)
 *  - enforce a per-day request budget so a bug cannot burn credits
 * The SDK is injectable so tests never touch the network.
 */
class AiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function scrub(text, key) {
  let s = String(text || '');
  if (key) s = s.split(key).join('[redacted]');
  return s.replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[redacted]').slice(0, 300);
}

function classify(err, key) {
  const status = Number(err && (err.status || err.code || (err.error && err.error.code))) || 0;
  const msg = scrub(err && err.message, key);
  const low = msg.toLowerCase();
  if (err && err.name === 'AbortError' || /timed? ?out|timeout|aborted/.test(low)) return new AiError('AI_TIMEOUT', 'Gemini did not answer in time');
  if (status === 401 || status === 403 || /api key|permission denied|unauthenticated|api_key_invalid/.test(low)) return new AiError('AI_AUTH', 'Gemini rejected the API key (missing, invalid, or not allowed for this model)');
  if (status === 404 || /not found|is not supported/.test(low) && /model/.test(low)) return new AiError('AI_MODEL', 'Gemini does not recognise the configured model name');
  if (status === 429 || /quota|rate limit|resource_exhausted/.test(low)) return new AiError('AI_RATE', 'Gemini quota or rate limit reached');
  return new AiError('AI_UNAVAILABLE', `Gemini is unavailable right now (${msg || 'unknown error'})`);
}

function extractText(resp) {
  if (!resp) return '';
  if (typeof resp.text === 'string') return resp.text;
  const parts = resp.candidates && resp.candidates[0] && resp.candidates[0].content && resp.candidates[0].content.parts;
  return Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
}

class GeminiClient {
  /**
   * @param {{apiKey:string, model:string, timeoutMs:number, dailyLimit:number}} cfg
   * @param {{sdk?:object, clock?:()=>Date, logger?:object}} deps  sdk = { GoogleGenAI } (injected in tests)
   */
  constructor(cfg, { sdk, clock = () => new Date(), logger } = {}) {
    this.cfg = cfg; this.clock = clock; this.logger = logger;
    this._sdk = sdk || null; this._client = null;
    this.usage = { day: null, count: 0 };
    this.lastOk = null; this.lastError = null;
  }
  get model() { return this.cfg.model; }

  _ai() {
    if (!this._client) {
      const sdk = this._sdk || require('@google/genai');
      this._client = new sdk.GoogleGenAI({ apiKey: this.cfg.apiKey });
    }
    return this._client;
  }
  _budget() {
    const day = this.clock().toISOString().slice(0, 10);
    if (this.usage.day !== day) this.usage = { day, count: 0 };
    if (this.usage.count >= this.cfg.dailyLimit) throw new AiError('AI_BUDGET', `Daily AI request limit (${this.cfg.dailyLimit}) reached`);
    this.usage.count += 1;
  }

  async _call({ system, prompt, json, maxTokens = 700, temperature = 0.3 }) {
    this._budget();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const config = { temperature, maxOutputTokens: maxTokens, abortSignal: controller.signal, httpOptions: { timeout: this.cfg.timeoutMs } };
      if (system) config.systemInstruction = system;
      if (json) config.responseMimeType = 'application/json';
      const resp = await this._ai().models.generateContent({ model: this.cfg.model, contents: prompt, config });
      const text = extractText(resp).trim();
      if (!text) throw new AiError('AI_BAD_OUTPUT', 'Gemini returned an empty answer');
      this.lastOk = this.clock().toISOString(); this.lastError = null;
      return text;
    } catch (e) {
      const err = e instanceof AiError ? e : classify(e, this.cfg.apiKey);
      this.lastError = { code: err.code, at: this.clock().toISOString() };
      this.logger?.warn({ code: err.code }, 'gemini call failed');
      throw err;
    } finally { clearTimeout(timer); }
  }

  async generateText(opts) { return this._call({ ...opts, json: false }); }
  async generateJson(opts) {
    const text = await this._call({ ...opts, json: true });
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(cleaned); } catch { throw new AiError('AI_BAD_OUTPUT', 'Gemini returned something that is not valid JSON'); }
  }

  /** Real round trip with a tiny prompt. Never returns or logs the key. */
  async health() {
    const started = Date.now();
    try {
      const out = await this.generateJson({ system: 'Reply with JSON only.', prompt: 'Return {"ok":true}', maxTokens: 30, temperature: 0 });
      if (!out || out.ok !== true) return { ok: false, code: 'AI_BAD_OUTPUT', message: 'Gemini answered, but not in the expected format', model: this.model };
      return { ok: true, model: this.model, latencyMs: Date.now() - started };
    } catch (e) { return { ok: false, code: e.code || 'AI_UNAVAILABLE', message: e.message, model: this.model }; }
  }
  status() { return { model: this.model, requestsToday: this.usage.count, dailyLimit: this.cfg.dailyLimit, lastOk: this.lastOk, lastError: this.lastError }; }
}

module.exports = { GeminiClient, AiError, scrub, classify };
