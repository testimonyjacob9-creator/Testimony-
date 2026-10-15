# Deploying OLIVES on Render

Render is the production host. Termux is for local testing only. SQLite is the only database.

## What you need
| Item | Notes |
|---|---|
| Render account, this repo connected | New > Blueprint, pick this repo; Render reads `render.yaml` |
| A **paid** instance type | Persistent disks are not available on free instances. `render.yaml` uses `starter` (about US$7/month) plus a 1 GB disk (about US$0.25/month); check Render's pricing page. Nothing is bought by this repo: you confirm it in Render. |
| `GEMINI_API_KEY` | From Google AI Studio |
| `OWNER_PHONE` | `2347065702702` (digits only) |

## Environment variables: the exact list
Render asks for two values when you create the Blueprint. Enter them in the dashboard only.

| Variable | You enter | Why |
|---|---|---|
| `OWNER_PHONE` | `2347065702702` | Identifies the only person OLIVES obeys. Cannot be defaulted. |
| `GEMINI_API_KEY` | your key | Secret. Without it OLIVES still starts; AI is reported as unavailable. |

`render.yaml` already fixes these (you do not type them): `DATA_DIR=/var/data`, `NODE_VERSION=22.13.0`, `WHATSAPP_PROVIDER=baileys`, `ACCOUNT_MODE=self`.
Defaults in code (set a variable only to override): `TIMEZONE=Africa/Lagos`, `AI_ENABLED=true`, `AI_PROVIDER=gemini`, `GEMINI_MODEL=gemini-3.8-flash`, `AI_DAILY_REQUEST_LIMIT=300`, `AI_TIMEOUT_MS=20000`, `LOG_LEVEL=info`.

`ACCOUNT_MODE=self` means OLIVES is a linked device on **your own** WhatsApp number (you message yourself; Status posts appear on your Status). Risk: if WhatsApp judges the automation abusive it can restrict that number. The alternative is a dedicated second number (`ACCOUNT_MODE=separate` plus `BOT_PHONE`); see ACCOUNT_SETUP.md.

## Service type and disk
* One **background worker**. It needs no HTTP port and no health check: it holds the WhatsApp connection and runs the schedulers. Render restarts it if it exits.
* One **persistent disk** named `olives-data`, mounted at `/var/data`, 1 GB. `DATA_DIR=/var/data` puts everything that must survive on it:
  * `/var/data/assistant.sqlite` (database, schedules, drafts, conversation memory)
  * `/var/data/auth_state/` (the WhatsApp login)
  * `/var/data/media/` (listing photos and videos)
* If the disk is missing, the app logs an error at startup ("DATA_DIR ... is on the ephemeral filesystem") because the data would be lost on the next deploy.
* **Exactly one instance** (`numInstances: 1`). Two instances would fight over one WhatsApp session and one database. The app enforces it too: it takes a renewable lease in SQLite, and a second process waits up to 60 s (a redeploy overlap) then exits. A crashed process's lease expires after 45 s. Services with a disk are stopped before the replacement starts, so a deploy has a short offline gap.
* Build `npm ci --omit=dev`, start `npm start`. On `SIGTERM` it stops schedulers, disconnects WhatsApp, writes an audit row, releases the lease and closes SQLite.

## First-time pairing (you do this yourself)
Deploying does not log in to WhatsApp. The login happens only when **you** type a code on your phone.
1. Deploy. Open the service's **Logs** in Render.
2. Wait for a block like: `WhatsApp pairing code: ABCD-1234`. The code is printed to the console only (never to log files, never sent to WhatsApp). Anyone who can read your Render logs can see it, so keep the dashboard private.
3. On the phone whose number is `2347065702702`: WhatsApp > Settings > **Linked devices** > Link a device > **Link with phone number instead** > enter the code. It expires quickly; if it does, the app reconnects and prints a fresh one (one request per connection attempt, never repeated while an attempt is in progress).
4. The app checks the linked account equals `OWNER_PHONE`. If not, it disconnects (`account_mismatch`) and does not reconnect.
5. You receive "Assistant online" in your own chat. Send `/status`, then `/ai check`.
6. Do the supervised checks in docs/GO_LIVE.md before posting anything to other people. Group posting is OFF until you run `/groups enable`.

The login is stored on the disk, so restarts and deploys do not ask for a new code.

## If WhatsApp logs the session out
Logout, replaced and bad-session states are terminal: the app logs the state and does **not** loop or delete anything. To re-pair: unlink the old session on your phone (Linked devices), open a Render **Shell** for the service, run `rm -rf /var/data/auth_state`, then restart the service and repeat "First-time pairing". Only do this when the logs say the session ended.

## Gemini: checking it really works
"Configured" is not "working". Send `/ai check` in WhatsApp (a real request to Google) or run `npm run ai:check` in a Render shell. A missing or invalid key, a retired model, quota limits and timeouts each give a plain message, and every basic command keeps working. `/ai` alone only shows configuration and usage. Gemini API use can be billed by Google: set a spend limit in your Google project and keep `AI_DAILY_REQUEST_LIMIT` low.

## Backups and recovery
* **Backup:** in a Render shell, `npm run backup` writes a consistent copy of the database and media under `DATA_DIR/backups`. Also enable Render **disk snapshots** in the dashboard. Download a copy before risky changes.
* **Never** delete `assistant.sqlite`. Migrations run automatically at startup, only add or rebuild tables inside a transaction, and keep existing rows.
* **Restore:** stop the service (suspend it in Render), copy the backup's `assistant.sqlite` over `/var/data/assistant.sqlite` and delete any `assistant.sqlite-wal` / `-shm` beside it, then resume. If the disk itself is lost, restore from a Render snapshot or your downloaded backup. The WhatsApp login (`auth_state/`) is separate: if it is gone, re-pair as above.

## What has and has not been verified
Automated tests use mocks. They have not proven a live Gemini request, a real WhatsApp pairing, or a Render deployment; those are yours to confirm using the steps above.
