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

## Phase 3 - Properties and media [x] tested with mocks
## Phase 4 - Status publishing [x] tested with mocks (visibility can never be verified)
## Phase 5 - Group campaigns [x] text adverts, property-linked, scheduled; [ ] media to groups
## Phase 6 - Leads / CRM [ ] not started
## Phase 7 - Scheduler, routine, briefing [x] tested with mocks
## Phase 8 - Hardening [~] backup script, deployment guide done; [ ] dashboard; [ ] live verification

## Next exact step
Owner approves and supervises the first live connection (docs/GO_LIVE.md); then fix what reality shows. See docs/HANDOVER.md.
