> **Production = Render. See [RENDER.md](RENDER.md).** The notes below are general always-on hosting background; Termux is for testing only.

# Deployment

## What it needs
A process that is **always running** and keeps the WhatsApp session. Not suitable: Netlify/Vercel/serverless, or free tiers that sleep (the 8 AM post would not run).
Suitable: an always-on PC or Raspberry Pi at home, or a small Linux VPS. Requirements: Node >= 22.13, a persistent folder (`data/`), correct system clock (NTP), outbound internet.
Costs: your own hardware = electricity only; a small VPS is typically a few US dollars a month (check current prices). No paid service is used by the code. Nothing is purchased for you.

## Simplest setup (Linux, systemd)
```
git clone <your private repo> /opt/testimony && cd /opt/testimony && npm ci
cp .env.example .env && chmod 600 .env     # fill in; see docs/GO_LIVE.md
sudo useradd -r -s /usr/sbin/nologin assistant && sudo chown -R assistant /opt/testimony
```
`/etc/systemd/system/testimony.service`:
```
[Unit]
Description=Testimony business assistant
After=network-online.target
Wants=network-online.target
[Service]
User=assistant
WorkingDirectory=/opt/testimony
EnvironmentFile=/opt/testimony/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now testimony` | logs: `journalctl -u testimony -f`. (pm2 works too: `pm2 start src/index.js --name testimony`.) First run needs a terminal to show the pairing code: run `node src/index.js` once by hand, link, stop it, then start the service.

## Restart safety
Schedules, runs, drafts, approvals, campaigns and media references are in SQLite and survive restarts. Overdue work is handled by the missed-run rules (docs/SCHEDULING.md). Shutdown (SIGTERM) is graceful.

## Backups and recovery
`npm run backup` writes `backups/backup-<time>/` with a consistent copy of the database and media (safe while running). It excludes WhatsApp credentials unless you add `--with-session` (treat such a backup like a password).
Restore: stop the service, copy `assistant.sqlite` and `media/` back into `data/`, start it. If the WhatsApp session is lost: remove `data/auth_state`, start, re-link with a new pairing code (your records are unaffected).
Schedule the backup (e.g. a daily cron job) and copy it off the machine.

## Updating
`git pull && npm ci && npm test && sudo systemctl restart testimony`. Database migrations apply automatically and are append-only. If WhatsApp changes its protocol the pinned Baileys version may stop connecting: that needs a library upgrade and a re-test.

## Troubleshooting
- No reply to your commands: check `/status` logs for the connection state; in `self` mode message **yourself**; if WhatsApp hides your number behind an ID set `OWNER_LID`.
- "not connected" at post time: the run waits (inside the grace window) and posts after reconnecting.
- `/audience` count far below your contact count: see docs/STATUS_AUDIENCE.md.
- Logged out / replaced: the assistant stops reconnecting on purpose; re-link (docs/SECURITY.md).
