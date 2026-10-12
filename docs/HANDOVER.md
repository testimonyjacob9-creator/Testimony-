# Handover - current state (read this first when resuming)

## Verified by automated tests (mock/fake provider only; nothing real was sent)
- Owner-only control (both account modes), groups/strangers/impersonation ignored, bot echo not re-processed
- /help /status /tasks /cancel /pause /resume (+ /properties /schedule /settings honest stubs)
- Natural language: reminders, show tasks (incl. "tomorrow", "awaiting approval"), pause/resume, cancel
- Propose -> confirm -> execute, modify draft time, discard, drafts expire, one pending draft at a time
- Persistence across restart (drafts, scheduled tasks, pause), overdue tasks sent with delay note
- Scheduler: no double execution, limited retries then FAILED + owner notified, waits while disconnected
- Baileys provider against a FAKE socket: pairing, account verification, reconnect/backoff, terminal states, auth dir 0700/0600

## NOT verified
- Any real WhatsApp connection. LID/phone resolution on real traffic. Real pairing flow.
- Status posting, groups, media, properties, leads: NOT implemented (reported to the owner as unavailable).

## Run
`npm test` | `npm run dev:chat` (terminal chat, mock provider) | `npm start` (see docs/ACCOUNT_SETUP.md)

## Code map
src/assistant.js command layer (provider-independent) | src/nlp/{intent,time}.js | src/tasks/{store,registry,pause}.js
src/scheduler.js | src/security/owner.js | src/providers/{provider,mock,baileys}.js | src/storage/{db,settings}.js
Add a new action kind by registering it in src/tasks/registry.js (`pausable`, `onConfirm`, `execute` that THROWS on failure).

## Behaviours to know
- /pause only blocks tasks marked `pausable` (future posts/campaigns). Owner reminders always run.
- Reminders are at-least-once: a crash during send can repeat one reminder.
- "at 4" without AM/PM is guessed and shown in the draft; the owner can correct it before confirming.
- Messages older than 10 min on arrival (offline backlog) are ignored, not executed.
- Baileys pinned to 6.7.24 (legacy tag). WhatsApp protocol changes may require upgrading it.

## Next exact steps
1. Owner picks ACCOUNT_MODE and does a supervised first live connection (docs/ACCOUNT_SETUP.md).
2. Fix whatever the real connection reveals (LID handling is the likeliest).
3. Phase 3: property tables (migration 3), intake, PROP-### IDs, captions.
