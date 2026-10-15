# Handover - current state (read this first when resuming)

## Verified by 183 automated tests (mock provider and a FAKE Baileys socket only; nothing real was ever sent)
- Owner-only control (self and separate modes); groups, strangers and impersonation ignored; bot echo not re-processed; duplicate/stale messages ignored
- Commands: /help /status /tasks /cancel /pause /resume /groups /advert /audience /properties /property /caption /schedule /routine /reminders via plain English
- Drafts -> confirm -> execute for reminders, group changes, adverts, property deletion, schedules; drafts expire; one pending draft at a time
- Properties: rule-based intake (never invents fields), references PROP-001 (never reused), edit/search/sold/available/delete, captions
- Media: streamed to private disk with size caps, SHA-256 dedupe, temp cleanup, path-traversal guard, re-checked before posting
- Status audience: learned only from real provider events or entered manually; empty = no posting; counts only, never numbers in chat
- Recurring Status schedules (daily / selected days / once / now), Africa/Lagos, start/end dates, pause/resume/cancel/edit, global pause
- Safety: one run per schedule per date (DB UNIQUE), per-item claims, interrupted -> "unknown" never re-sent, limited retries that skip already-sent items, missed runs skipped not posted late, availability + media re-checked, sold pauses schedules
- Morning briefing (opt-in) and batched private reports with honest wording ("accepted by WhatsApp", never "published")
- Groups: discovery, pagination, allowlist by stable JID, enable switch (OFF by default), paced/deduplicated adverts, property-linked and scheduled adverts, partial failures, restart safety
- Baileys provider against a fake socket: pairing, account check, reconnect/backoff, terminal states, auth dir 0700/0600, contacts events, media streaming, group listing, Status call shape
- Backup script (consistent SQLite copy + media, credentials excluded by default)

## Verified LIVE (first supervised run, owner's personal number, ACCOUNT_MODE=self, Termux, Baileys 7.0.0-rc14)
- Pairing by phone-number code; self-chat commands recognised (/help, /status, /audience, /groups)
- Contact sync: 8582 usable recipients, 1665 contacts WhatsApp identifies only by an anonymous ID (not targetable)
- Group listing works (118 groups, admins-only flag shown); group posting stayed OFF, nothing sent to any group
- Property intake from a real photo + text (PROP-001, fields parsed correctly), then a one-time Status post to ONE manually added recipient; the owner confirmed that person SAW it. The assistant reported "accepted by WhatsApp" (it can never confirm visibility itself)

## NOT verified / not built
- Group sending, group admin-only accuracy, Status to large audiences (mode all), rate limits, long-running stability, reconnects over days, scheduled/recurring runs live, morning briefing live, backup restore.
- Known cosmetic issue: a one-time "now" post is reported as "Good morning! Your 9:27 AM routine has finished."
- Status visibility can never be verified by the assistant (library limit).
- WhatsApp Channels: deliberately disabled (docs/DESTINATIONS.md). Photos/videos to groups: not built. Leads/follow-ups (CRM), dashboard: not built.
- Voice notes/documents: refused.

## Run
`npm test` | `npm run dev:chat` (terminal chat, mock) | `npm run backup` | `npm start` (see docs/GO_LIVE.md; owner approval required before first live connection)

## Code map
src/assistant.js (command layer, provider-independent) | src/nlp/{intent,time,schedule}.js | src/tasks/{store,registry*,pause}.js (draft/confirm actions)
src/properties/{parse,caption,store,commands}.js | src/media/store.js | src/status/{audience,commands}.js | src/groups/{store,campaigns,commands}.js
src/schedule/{store,runner,commands}.js | src/providers/{provider,mock,baileys}.js | src/storage/{db,settings}.js (migrations 1-6) | scripts/{backup,dev-chat}.js
Add a new confirmed action by registering it in src/tasks/registry-*.js (`describe`, `onConfirm`, optional `pausable`).

## Behaviours to know
- Numbering: `/groups select` uses the last /groups list; remove, adverts and draft edits use /groups selected. Drafts print names so mistakes are visible.
- "this property" means the one you touched in the last 2 hours; otherwise name it (PROP-001).
- AM/PM or time-of-day guesses are shown in the draft as notes. Reminders are at-least-once.
- Messages older than 10 min on arrival (offline backlog) are ignored. Baileys is pinned to 7.0.0-rc14 (a release candidate). 6.7.24 connected and could send, but every incoming message failed to decrypt (Bad MAC) on the first live run, so commands were never received.
- Marking a property sold/rented/unavailable pauses its schedules; making it available does NOT resume them.

## Next exact steps
1. Owner reads docs/GO_LIVE.md, decides, and runs the supervised first connection (self mode). Report anything that differs from the tests.
2. Fix whatever the real connection reveals (likely: LID handling, contact sync volume, Status behaviour).
3. Only after step 1 works: consider photos/videos to groups, leads/follow-ups (Phase 6), dashboard (Phase 8).
