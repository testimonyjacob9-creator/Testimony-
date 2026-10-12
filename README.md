# Testimony Business Assistant

An owner-controlled WhatsApp assistant for property marketing, status posting, approved-group campaigns, lead follow-up and scheduled routines. Built modular so the WhatsApp provider is replaceable.

## Current status: Phase 2 + group selection implemented, not yet connected to real WhatsApp

| Tested (mock / fake socket) | Not yet |
|---|---|
| Owner-only commands, reminders, propose -> confirm -> execute, persistent scheduler, **group discovery, paginated selection, persistent marketing allowlist, confirmed + paced + deduplicated group adverts**, restart recovery | **Live WhatsApp connection (unverified)**, properties, media, recurring Status posts, leads, dashboard |

Start with [docs/HANDOVER.md](docs/HANDOVER.md), [docs/ACCOUNT_SETUP.md](docs/ACCOUNT_SETUP.md), [docs/GROUPS.md](docs/GROUPS.md) and [docs/DESTINATIONS.md](docs/DESTINATIONS.md) (what each destination can really do).

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
| GROUP_SEND_DELAY_SECONDS | no | 30 | Pause between groups when sending an advert |
| MAX_GROUPS_PER_CAMPAIGN | no | 10 | Max groups per advert |
| GROUP_DEDUPE_HOURS | no | 24 | Same advert not repeated to a group within this window |
| TIMEZONE | no | Africa/Lagos | IANA timezone for scheduling |
| LOG_LEVEL | no | info | pino level |
| DATA_DIR | no | ./data | SQLite DB and private media (git-ignored) |
| MAX_MEDIA_MB | no | 50 | Media size cap |
| DASHBOARD_ENABLED / DASHBOARD_TOKEN | no | false | Phase 8 dashboard; token 16+ chars if enabled |

## Documentation
- [docs/HANDOVER.md](docs/HANDOVER.md) - current state, what is verified, next steps
- [docs/GROUPS.md](docs/GROUPS.md) - group selection and adverts: commands, safety rules, limits
- [docs/DESTINATIONS.md](docs/DESTINATIONS.md) - audit of groups / Status / Channels / media and deployment needs
- [docs/ACCOUNT_SETUP.md](docs/ACCOUNT_SETUP.md) - own number vs separate number
- [docs/PLAN.md](docs/PLAN.md) - phases, status, next steps
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - modules and provider design
- [docs/PROVIDERS.md](docs/PROVIDERS.md) - WhatsApp capability research and feature support matrix
- [docs/SECURITY.md](docs/SECURITY.md) - safe connect/disconnect, credential revocation

## Known limitations (honest summary)
Status posting and acting inside your existing personal groups are **not available in the official WhatsApp Business Platform**. They require an unofficial WhatsApp Web library (planned: Baileys), which carries account-restriction risk. See docs/PROVIDERS.md before connecting a number you care about.
