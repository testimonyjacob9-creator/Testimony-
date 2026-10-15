# Deploying OLIVES on Render

Render is the intended production host. Termux is for testing only.

## What you need
| Item | Notes |
|---|---|
| Render account + this repo connected | New > Blueprint, pick this repo; Render reads `render.yaml` |
| A **paid** instance type | A persistent disk is not available on free instances. As of writing the smallest paid worker ("Starter") is about US$7/month and a 1 GB disk about US$0.25/month; check Render's pricing page. Nothing is purchased by this repo: you confirm it in Render. |
| `OWNER_PHONE` | Digits only, international format, e.g. `2347065702702` |
| `GEMINI_API_KEY` | From Google AI Studio. Enter it only in Render's Environment tab |

## How it is set up
* One **background worker** (no web port needed) runs everything: WhatsApp connection, scheduler, schedule runner, Gemini calls.
* One **persistent disk** mounted at `/var/data`. `DATA_DIR=/var/data` puts SQLite (`assistant.sqlite`), the WhatsApp session (`auth_state/`) and listing media (`media/`) on it. Anything outside the disk is wiped on each deploy.
* **Exactly one instance.** `numInstances: 1` is mandatory. The app also enforces it: on start it takes a short renewable lease inside the database; a second process waits up to 60 s (for a redeploy overlap) and then exits with an explanation. A crashed process's lease expires after 45 s.
* Build: `npm ci --omit=dev`. Start: `npm start`. Node 22.13+ (`NODE_VERSION=22.13.0`).
* `SIGTERM` (Render deploys/restarts) triggers a graceful shutdown: schedulers stop, WhatsApp disconnects, an audit row is written, the lease is released and SQLite is closed.
* Schedules, drafts, conversation context and run history are in SQLite, so a restart resumes them. Duplicate runs are prevented by the database (one run row per schedule per day) and an uncertain send is never repeated.

## Environment variables
| Name | Value |
|---|---|
| `DATA_DIR` | `/var/data` (must equal the disk mount path) |
| `OWNER_PHONE` | your number, digits only |
| `AI_ENABLED` | `true` (default when a key exists) or `false` |
| `AI_PROVIDER` | `gemini` |
| `GEMINI_API_KEY` | secret, dashboard only |
| `GEMINI_MODEL` | default `gemini-3.8-flash`; change here if Google retires it |
| `AI_DAILY_REQUEST_LIMIT` | hard cap on model calls per UTC day (default 300) |
| `AI_TIMEOUT_MS` | default 20000 |
| `WHATSAPP_PROVIDER` | `mock` until you approve going live, then `baileys` |
| `ACCOUNT_MODE` | `self` or `separate` (see ACCOUNT_SETUP.md) |
| `TIMEZONE` | `Africa/Lagos` |

## Gemini: checking it really works
"Configured" is not "working". Two ways to test without exposing the key:
* From WhatsApp: send `/ai check` (a real round trip) or `/ai` (shows config, today's usage, last error).
* From a Render shell or locally: `npm run ai:check`.
Messages that need language understanding go to Gemini; commands like `/help`, `/status`, pause, resume, cancel and list never do. If the key is missing/invalid or Gemini is down, OLIVES says so plainly and every basic command keeps working.

**Costs:** Gemini API use can be billed by Google. Set a spend/quota limit in Google AI Studio / Google Cloud for the key's project, and keep `AI_DAILY_REQUEST_LIMIT` low. Tests use mocks and consume no credits.

## Going live with WhatsApp (needs your explicit approval)
Deploying does **not** connect to WhatsApp: the blueprint ships with `WHATSAPP_PROVIDER=mock`. When you decide to go live, follow docs/GO_LIVE.md; you will change `WHATSAPP_PROVIDER=baileys`, deploy, and scan the QR code shown in the Render logs. Unofficial WhatsApp Web libraries carry account-restriction risk (see PROVIDERS.md).

## Backups
`npm run backup` (run in a Render shell) writes a consistent copy of the database and media under `DATA_DIR`. Also enable Render disk snapshots in the dashboard.
