# Implementation plan

Status legend: [x] done, [ ] todo

## Phase 1 - Foundation [x]
- [x] Repo, config validation, redacting logger, SQLite + migrations, audit log
- [x] Provider interface + mock provider, graceful shutdown, tests

## Phase 2 - WhatsApp connection and owner chat [x] code + tests, [ ] live verification
- [x] Baileys provider (pairing code, auth state outside git, reconnect with backoff, account verification) - fake-socket tests
- [x] Owner authentication (1:1 only, groups ignored, self/separate modes)
- [x] Commands /help /status /tasks /cancel /pause /resume
- [x] Pending-action store, confirm/cancel/modify, persistent scheduler
- [ ] Supervised live connection by the owner

## Phase 3 - Properties [ ]
Intake from text/media, structured records with PROP-### IDs, edit/search/mark sold, caption variants.

## Phase 4 - Status publishing [ ]
Preview/confirm, dedupe, history, honest `verified` reporting. Blocks sold properties.

## Phase 5 - Group campaigns [~] partially done
- [x] Discovery, pagination, allowlist (stable JIDs), enable switch, confirmed adverts, pacing, dedupe, partial-failure reporting, restart safety (docs/GROUPS.md)
- [ ] Property-linked adverts, media adverts, per-group templates (need Phase 3)
- [ ] Scheduled group adverts (Phase 7)
- Channels: intentionally disabled (docs/DESTINATIONS.md)

## Phase 6 - Leads/CRM [ ]
Leads, stages, follow-ups, drafted replies (never auto-sent).

## Phase 7 - Scheduler [ ]
Persistent jobs in SQLite, Africa/Lagos, daily plan, briefings, recurring pre-authorized tasks.

## Phase 8 - Hardening [ ]
Failure-scenario tests, backup/restore, optional dashboard, deployment guide.

## Next exact step
Owner chooses ACCOUNT_MODE and runs the first supervised live connection; then Phase 3 (properties). See docs/HANDOVER.md.
