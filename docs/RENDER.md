# Deploying OLIVES on Render

Two blueprints are in the repo. SQLite is the only database; there is no Firebase or any other service.

| | `render.yaml` (default) | `render.paid.yaml` |
|---|---|---|
| Cost | Free | Paid worker plus a disk (check Render's pricing page) |
| Service type | Web Service (free) | Background worker |
| Data survives restarts | **No** | Yes (disk at `/var/data`) |
| WhatsApp login survives restarts | **No** | Yes |

**Read this before using the free option.** A free Render instance has a temporary filesystem, erased whenever the service restarts, redeploys or spins down, and Render can restart it at any time. So on the free option:
* the database (listings, schedules, drafts, chat memory) is **lost on every restart**;
* the WhatsApp login is **lost on every restart**, so you must **re-pair** each time;
* an uptime monitor stops the 15-minute idle spin-down only. It cannot stop deploys, platform restarts or crashes, and it does not make anything persistent.

What reduces the damage: `/backup` sends you a copy of your data in WhatsApp, and sending that file back with the caption `/restore` brings it back (after you confirm). Backups do not contain photos/videos or the WhatsApp login. Make a backup before every deploy and regularly otherwise: Olives cannot do it automatically, because a message to you is an automatic action and the host can restart at any moment.

## Free setup (exact steps)
1. Render dashboard > **New > Blueprint**, pick this repo. It reads `render.yaml`. Confirm the instance type shows **Free**.
2. Enter the two values it asks for: `OWNER_PHONE` (digits only, e.g. `2347065702702`) and `GEMINI_API_KEY`.
3. Deploy. The app opens its web port first, so Render's health check (`/health`) passes while WhatsApp is still starting.
4. Pair WhatsApp (next section). 
5. Set up the uptime monitor (below).

Environment variable names: you enter `OWNER_PHONE` and `GEMINI_API_KEY`. The blueprint sets `NODE_VERSION`, `DATA_DIR=/tmp/olives-data` (temporary on purpose), `EPHEMERAL_OK=true` (acknowledges the temporary storage; it only changes how it is reported), `WHATSAPP_PROVIDER=baileys`, `ACCOUNT_MODE=self`. Render supplies `PORT`. Everything else has a safe default (timezone `Africa/Lagos`, model `gemini-3.8-flash`, daily AI cap 300).

`ACCOUNT_MODE=self` means OLIVES runs as a linked device on your own number. Repeated re-pairing (which the free option forces) is the kind of activity WhatsApp may treat as unusual; I cannot verify how it reacts.

## Health endpoint and uptime monitoring
* `GET` or `HEAD` `/health` returns `200` with the fixed body `{"status":"ok"}`. It shows nothing else: no phone number, no WhatsApp or database state, no configuration. Everything else on the port returns 404.
* A 200 means the process is running. It does **not** mean WhatsApp is connected: send `/status` in WhatsApp for that.
* **UptimeRobot (free):** create an account > **Add New Monitor** > Monitor Type **HTTP(s)** > URL `https://<your-service-name>.onrender.com/health` (your exact address is at the top of the service page in Render; the default name from the blueprint is `olives-assistant`) > interval **5 minutes** (the shortest the free plan offers, as far as I know; check their current terms) > Create.
* Render's free instance hours (750/month) are shared by all your free web services. One service awake 24/7 uses about 744, so a second always-on free service will run you out.

## First-time pairing (you do this yourself)
Deploying does not log in to WhatsApp. It requests a pairing code, and nothing links until **you** type it on your phone. Requesting the code may make WhatsApp show a link prompt on that phone; ignore it until you are ready.
1. Open the service's **Logs** in Render.
2. Wait for `WhatsApp pairing code: ABCD-1234` (console only; anyone who can read your Render logs can see it).
3. On the phone for `OWNER_PHONE`: WhatsApp > Settings > **Linked devices** > Link a device > **Link with phone number instead** > enter the code. If it expires, the app reconnects and prints a fresh one (one request per connection attempt).
4. The app checks the linked account equals `OWNER_PHONE`; if not it disconnects and does not retry.
5. You get "Assistant online". Send `/status` (shows `Storage: TEMPORARY` on the free option), then `/ai check`.

**After every restart on the free option** the login is gone: repeat the steps above, then send your last backup file with the caption `/restore` and answer **yes**. Restoring leaves automation **paused** so old schedules cannot post anything by surprise: check `/schedule` and then send `/resume`. Re-send any photos you need.

## Reconnecting
Brief drops reconnect automatically with a growing delay (up to one minute between tries, never a tight loop). A logged-out, replaced or invalid session is final: the app logs it, stops retrying and deletes nothing. Unlink the device in WhatsApp, restart the service in Render, and pair again.

## Gemini
"Configured" is not "working". Send `/ai check` in WhatsApp for a real test request (Render's free tier has no shell, so `npm run ai:check` is for your own computer). Without a key Olives still runs and says AI is off. Gemini API usage can be billed by Google: set a spend limit in your Google project.

## Paid persistent option
Choose `render.paid.yaml` when creating the Blueprint. It runs a background worker with a 1 GB disk at `/var/data` holding `assistant.sqlite`, `auth_state/` (the WhatsApp login) and `media/`, so restarts keep everything. Keep exactly one instance. Back up with `npm run backup` in a Render shell (it writes under `/var/data/backups`) and enable Render disk snapshots. Never delete `assistant.sqlite`; migrations keep existing rows.

## What has and has not been verified
Automated tests use mocks. They have not proven a live Gemini request, a real WhatsApp pairing or document transfer, or a Render deployment.
