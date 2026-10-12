# Implementation plan

Status legend: [x] done, [ ] todo

## Phase 1 - Foundation [x]
- [x] Repo, config validation, redacting logger, SQLite + migrations, audit log
- [x] Provider interface + mock provider, graceful shutdown, tests

## Phase 2 - WhatsApp connection and owner chat [ ]
- [ ] Baileys provider (pairing-code login, persistent auth state outside git, reconnect with backoff)
- [ ] Owner authentication (OWNER_PHONE, 1:1 chat only, groups ignored, self-chat mode)
- [ ] Command router: /help /status /tasks /cancel /properties /schedule /settings /pause /resume
- [ ] Pending-action store (proposed vs completed), confirm/cancel/modify flow

## Phase 3 - Properties [ ]
Intake from text/media, structured records with PROP-### IDs, edit/search/mark sold, caption variants.

## Phase 4 - Status publishing [ ]
Preview/confirm, dedupe, history, honest `verified` reporting. Blocks sold properties.

## Phase 5 - Group campaigns [ ]
Allowlist, templates, per-group dedupe, preview + approval, rate limits.

## Phase 6 - Leads/CRM [ ]
Leads, stages, follow-ups, drafted replies (never auto-sent).

## Phase 7 - Scheduler [ ]
Persistent jobs in SQLite, Africa/Lagos, daily plan, briefings, recurring pre-authorized tasks.

## Phase 8 - Hardening [ ]
Failure-scenario tests, backup/restore, optional dashboard, deployment guide.

## Next exact step
Phase 2: add `baileys` dependency, implement `src/providers/baileys.js` against `WhatsAppProvider`, add `src/security/owner.js` with tests for impersonation/group/unauthorized senders.
