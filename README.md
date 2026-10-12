# Testimony Business Assistant

An owner-controlled WhatsApp assistant for property marketing, status posting, approved-group campaigns, lead follow-up and scheduled routines. Built modular so the WhatsApp provider is replaceable.

## Current status: Phase 1 (foundation) complete

| Done | Not yet |
|---|---|
| Config validation, secret-safe logging, SQLite storage with migrations, audit log, provider interface, mock provider, graceful shutdown, 9 passing tests | Real WhatsApp connection, owner commands, properties, status, groups, leads, scheduler, dashboard |

See [docs/PLAN.md](docs/PLAN.md) for phases and exact next steps.

## Quick start
```bash
npm install
cp .env.example .env     # set OWNER_PHONE
npm test
npm start                # runs with the mock provider; sends nothing
```
Requires Node >= 22.13 (uses built-in `node:sqlite`, no native build needed).

## Environment variables
| Name | Required | Default | Purpose |
|---|---|---|---|
| OWNER_PHONE | yes | - | Your number, digits only, international format |
| WHATSAPP_PROVIDER | no | mock | `mock` or `baileys` (Phase 2) |
| TIMEZONE | no | Africa/Lagos | IANA timezone for scheduling |
| LOG_LEVEL | no | info | pino level |
| DATA_DIR | no | ./data | SQLite DB and private media (git-ignored) |
| MAX_MEDIA_MB | no | 50 | Media size cap |
| DASHBOARD_ENABLED / DASHBOARD_TOKEN | no | false | Phase 8 dashboard; token 16+ chars if enabled |

## Documentation
- [docs/PLAN.md](docs/PLAN.md) - phases, status, next steps
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - modules and provider design
- [docs/PROVIDERS.md](docs/PROVIDERS.md) - WhatsApp capability research and feature support matrix
- [docs/SECURITY.md](docs/SECURITY.md) - safe connect/disconnect, credential revocation

## Known limitations (honest summary)
Status posting and acting inside your existing personal groups are **not available in the official WhatsApp Business Platform**. They require an unofficial WhatsApp Web library (planned: Baileys), which carries account-restriction risk. See docs/PROVIDERS.md before connecting a number you care about.
