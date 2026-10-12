'use strict';
const { normalizePhone } = require('../config');

const PRIVATE_CHAT = /@(s\.whatsapp\.net|lid)$/;

/**
 * Decide whether an inbound message may control the assistant.
 * Identity comes only from protocol-level JIDs (never display names or message text).
 *
 * mode "self":     assistant runs on the owner's own account. Commands are messages the
 *                  owner sends in their own "Message yourself" chat (fromMe + chatIsSelf).
 * mode "separate": assistant runs on its own number. Commands are messages RECEIVED
 *                  from OWNER_PHONE (or OWNER_LID) in a private chat; fromMe is ignored.
 * Groups, broadcasts, newsletters and everyone else are denied.
 */
function authorizeOwner(msg, config) {
  if (!msg || typeof msg !== 'object') return deny('invalid_message');
  if (msg.isGroup) return deny('group');
  if (typeof msg.chat !== 'string' || !PRIVATE_CHAT.test(msg.chat)) return deny('not_private_chat');

  const owner = normalizePhone(config.ownerPhone);
  if (!owner) return deny('owner_not_configured');

  if (config.accountMode === 'self') {
    if (!msg.fromMe) return deny('not_from_owner_device');
    const chatPhone = msg.chat.endsWith('@s.whatsapp.net') ? normalizePhone(msg.chat.split('@')[0].split(':')[0]) : null;
    if (msg.chatIsSelf === true || chatPhone === owner) return allow('self_chat');
    return deny('not_self_chat');
  }

  if (msg.fromMe) return deny('own_message');
  if (msg.from && normalizePhone(msg.from) === owner) return allow('owner_phone');
  if (config.ownerLid && msg.fromLid && msg.fromLid === config.ownerLid) return allow('owner_lid');
  return deny('not_owner');
}

const allow = (reason) => ({ allowed: true, reason });
const deny = (reason) => ({ allowed: false, reason });

module.exports = { authorizeOwner };
