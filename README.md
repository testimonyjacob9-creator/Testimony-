# Testimony Business Assistant

An owner-controlled WhatsApp assistant for property marketing, status posting, approved-group campaigns, lead follow-up and scheduled routines. Built modular so the WhatsApp provider is replaceable.

## Current status: Phase 2 (owner chat) implemented, not yet connected to real WhatsApp

| Tested (mock / fake socket) | Not yet |
|---|---|
| Owner-only commands, /help /status /tasks /cancel /pause /resume, natural-language reminders, propose -> confirm -> execute, persistent scheduler, restart recovery, Baileys provider logic | **Live WhatsApp connection (unverified)**, properties, status posting, groups, leads, dashboard |

Start with [docs/HANDOVER.md](docs/HANDOVER.md) and [docs/ACCOUNT_SETUP.md](docs/ACCOUNT_SETUP.md).

## Quick start
```bash
npm install
cp .env.example .env     # set OWNER_PHONE
npm test
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
| TIMEZONE | no | Africa/Lagos | IANA timezone for scheduling |
| LOG_LEVEL | no | info | pino level |
| DATA_DIR | no | ./data | SQLite DB and private media (git-ignored) |
| MAX_MEDIA_MB | no | 50 | Media size cap |
| DASHBOARD_ENABLED / DASHBOARD_TOKEN | no | false | Phase 8 dashboard; token 16+ chars if enabled |

## Documentation
- [docs/HANDOVER.md](docs/HANDOVER.md) - current state, what is verified, next steps
- [docs/ACCOUNT_SETUP.md](docs/ACCOUNT_SETUP.md) - own number vs separate number
- [docs/PLAN.md](docs/PLAN.md) - phases, status, next steps
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - modules and provider design
- [docs/PROVIDERS.md](docs/PROVIDERS.md) - WhatsApp capability research and feature support matrix
- [docs/SECURITY.md](docs/SECURITY.md) - safe connect/disconnect, credential revocation

## Known limitations (honest summary)
Status posting and acting inside your existing personal groups are **not available in the official WhatsApp Business Platform**. They require an unofficial WhatsApp Web library (planned: Baileys), which carries account-restriction risk. See docs/PROVIDERS.md before connecting a number you care about.
