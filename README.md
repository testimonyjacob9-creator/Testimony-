# Testimony Business Assistant

An owner-controlled WhatsApp assistant for property marketing, status posting, approved-group campaigns, lead follow-up and scheduled routines. Built modular so the WhatsApp provider is replaceable.

## Current status: all planned features implemented and tested with mocks; NOT yet connected to real WhatsApp

| Tested (mock provider / fake Baileys socket / mocked Gemini, 222 tests) | Not built / not verified |
|---|---|
| Owner-only chat commands, **Gemini-powered natural-language understanding and advert writing (validated, confirmation-gated)**, universal listings (statuses incl. reserved/withdrawn), single-instance guard, Render blueprint, reminders, drafts -> confirm -> execute, property intake and records, safe media storage, captions, Status audience capture, **recurring Status schedules** (daily / selected days / one-time / now), morning routine + briefing, group selection and confirmed group adverts, scheduled group adverts, pause/resume/cancel/edit, missed-run and restart recovery, duplicate prevention, retries, honest reports, backup script | **Any live WhatsApp connection**, **any live Gemini call (needs your key; run `/ai check`)**, Status visibility (cannot be verified at all), Channels (deliberately disabled), photos/videos to groups, leads/follow-ups, dashboard |

Read first: [docs/HANDOVER.md](docs/HANDOVER.md), then [docs/GO_LIVE.md](docs/GO_LIVE.md) (final setup; waiting for your approval).

## Quick start
```bash
npm install
cp .env.example .env     # set OWNER_PHONE
npm test
npm run backup           # consistent backup of records + media
npm run ai:check         # real Gemini round trip (needs GEMINI_API_KEY)
npm run dev:chat         # talk to the assistant in your terminal (mock, sends nothing)
npm start                # mock by default; real WhatsApp needs docs/ACCOUNT_SETUP.md
```
Requires Node >= 22.13 (uses built-in `node:sqlite`, no native build needed).

## Environment variables
| Name | Required | Default | Purpose |
|---|---|---|---|
| OWNER_PHONE | yes | - | Your number, digits only, international format |
| WHATSAPP_PROVIDER | no | mock | `mock` or `baileys` |
| ACCOUNT_MODE | with baileys | - | `self` or `separate` (docs/ACCOUNT_SETUP.md) |
| BOT_PHONE | separate mode | - | Number of the assistant account |
| OWNER_LID | no | - | Only if WhatsApp hides your number behind an ID |
| PROPOSAL_TTL_MINUTES | no | 30 | How long an unconfirmed draft lasts |
| GROUP_SEND_DELAY_SECONDS | no | 30 | Pause between groups when sending an advert |
| MAX_GROUPS_PER_CAMPAIGN | no | 10 | Max groups per advert |
| GROUP_DEDUPE_HOURS | no | 24 | Same advert not repeated to a group within this window |
| SCHEDULE_MAX_ATTEMPTS | no | 2 | Attempts per scheduled Status run |
| SCHEDULE_RETRY_DELAY_SECONDS | no | 120 | Wait between attempts |
| MISSED_RUN_GRACE_MINUTES | no | 120 | Later than this = skipped and reported, never posted late |
| MEDIA_ACK_DELAY_MS | no | 3000 | One summary message per burst of uploads |
| TIMEZONE | no | Africa/Lagos | IANA timezone for scheduling |
| LOG_LEVEL | no | info | pino level |
| DATA_DIR | no | ./data | SQLite DB and private media (git-ignored) |
| MAX_MEDIA_MB | no | 50 | Media size cap |
| AI_ENABLED | no | true if key set | `false` forces the AI helper off |
| AI_PROVIDER | no | gemini | only `gemini` |
| GEMINI_API_KEY | for AI | - | secret: .env (ignored) or Render dashboard only |
| GEMINI_MODEL | no | gemini-3.8-flash | any supported Gemini model id |
| AI_DAILY_REQUEST_LIMIT / AI_TIMEOUT_MS | no | 300 / 20000 | spend safety cap / per-call timeout |
| DASHBOARD_ENABLED / DASHBOARD_TOKEN | no | false | Phase 8 dashboard; token 16+ chars if enabled |

## Documentation
- [docs/HANDOVER.md](docs/HANDOVER.md) - current state, what is verified, next steps
- [docs/GO_LIVE.md](docs/GO_LIVE.md) - final setup and supervised first-run checklist (needs your approval)
- [docs/SCHEDULING.md](docs/SCHEDULING.md) - recurring posts, morning routine, guarantees
- [docs/PROPERTIES.md](docs/PROPERTIES.md) - property intake, captions, media storage
- [docs/STATUS_AUDIENCE.md](docs/STATUS_AUDIENCE.md) - how Status recipients are obtained and the limits
- [docs/RENDER.md](docs/RENDER.md) - **production deployment on Render** (persistent disk, one instance, Gemini key, costs)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) - always-on hosting, backups, recovery
- [docs/GROUPS.md](docs/GROUPS.md) - group selection and adverts: commands, safety rules, limits
- [docs/DESTINATIONS.md](docs/DESTINATIONS.md) - audit of groups / Status / Channels / media and deployment needs
- [docs/ACCOUNT_SETUP.md](docs/ACCOUNT_SETUP.md) - own number vs separate number
- [docs/PLAN.md](docs/PLAN.md) - phases, status, next steps
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - modules and provider design
- [docs/PROVIDERS.md](docs/PROVIDERS.md) - WhatsApp capability research and feature support matrix
- [docs/SECURITY.md](docs/SECURITY.md) - safe connect/disconnect, credential revocation

## Known limitations (honest summary)
Status posting and acting inside your existing personal groups are **not available in the official WhatsApp Business Platform**. They require an unofficial WhatsApp Web library (planned: Baileys), which carries account-restriction risk. See docs/PROVIDERS.md before connecting a number you care about.
