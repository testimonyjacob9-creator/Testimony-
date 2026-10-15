'use strict';
/**
 * WhatsApp provider contract. The rest of the app depends ONLY on this interface,
 * so Baileys can be swapped for the official Cloud API or a gateway later.
 *
 * Methods return honest results: { ok: boolean, id?: string, error?: string, verified: boolean }
 * `verified` is true only when the provider can confirm the outcome (e.g. server ack).
 */
class WhatsAppProvider {
  /** @returns {Promise<void>} */ async connect() { throw new Error('not implemented'); }
  /** @returns {Promise<void>} */ async disconnect() { throw new Error('not implemented'); }
  /** @param {(msg:InboundMessage)=>Promise<void>} handler */ onMessage(handler) { throw new Error('not implemented'); }
  /** @param {(state:string)=>void} handler */ onConnectionChange(handler) { throw new Error('not implemented'); }
  async sendText(jid, text) { throw new Error('not implemented'); }
  async sendMedia(jid, media) { throw new Error('not implemented'); }
  /**
   * @param {{text?:string, imagePath?:string, videoPath?:string, caption?:string, recipients:string[]}} content
   * @returns {Promise<{ok:boolean,id?:string,verified:false,error?:string}>} verified is ALWAYS false for Status.
   */
  async publishStatus(content) { throw new Error('not implemented'); }
  /** The connected account's own JID, if known. */
  selfJid() { return null; }
  /**
   * @returns {Promise<{ok:boolean, groups:{id:string,name:string,size:number|null,canSend:boolean|null,isMember:boolean}[], error?:string}>}
   * Must never fabricate groups: on failure return ok:false with an empty list.
   */
  async listGroups() { throw new Error('not implemented'); }
  /** @param {(contacts:{id:string,jid?:string,lid?:string,name?:string,notify?:string}[])=>void} handler */
  onContacts(handler) { /* optional: providers that can learn contacts call handler */ }
  /** @returns {Promise<{ok:boolean, mode?:string, error?:string}>} the Status privacy MODE WhatsApp reports (not the exception lists) */
  async getStatusPrivacy() { return { ok: false, error: 'not supported' }; }
  connectionState() { return 'disconnected'; }
  /** What this provider genuinely supports; callers must check before offering a feature. */
  capabilities() {
    return { sendText: false, sendMedia: false, publishStatus: false, statusVerification: false, groups: false, receiveMedia: false };
  }
}

/**
 * @typedef {Object} InboundMessage
 * @property {string} id
 * @property {string|null} from  sender phone digits when known
 * @property {string|null} [fromLid] sender LID when the phone is not exposed
 * @property {boolean} [chatIsSelf] chat is the account's own "message yourself" chat
 * @property {string} chat        chat JID
 * @property {boolean} isGroup
 * @property {boolean} fromMe
 * @property {string} [text]
 * @property {{type:string,path?:string,mime?:string,size?:number}} [media]
 * @property {number} timestamp
 */

module.exports = { WhatsAppProvider };
