# Final setup before the FIRST real WhatsApp connection (awaiting your explicit approval)

Nothing in this project has ever connected to real WhatsApp. The connection is made **by you, on your own machine**, with `npm start`. It cannot be made from the development sandbox. Do not start it until you have read this and decided to proceed.

## What "self" mode means for you (your own existing number)
- The assistant is a **linked device** on your WhatsApp. You command it by messaging **yourself** ("Message yourself" chat).
- Status posts appear on **your** Status. Group adverts are sent **as you**, in your own groups, to real people.
- If WhatsApp decides automation looks abusive it can restrict **your main number**. Mitigations built in: owner-only control, drafts + your confirmation for everything, group posting OFF by default, pacing, per-group duplicate protection, no auto-retry on group sends, no group discovery/joining, no evasion of limits.
- Your phone's own messages to yourself are commands, so keep the phone secure. Anything typed in other chats is never a command.
- Safer alternative: first test with a spare number (`ACCOUNT_MODE=separate`); you can switch later.

## Setup (on the always-on machine)
1. Node >= 22.13. Get the code (private repo), `npm ci`, `npm test` (all tests must pass).
2. Create `.env` (never commit it, `chmod 600`):
   ```
   OWNER_PHONE=<your number, digits only, international format>
   WHATSAPP_PROVIDER=baileys
   ACCOUNT_MODE=self
   TIMEZONE=Africa/Lagos
   ```
   Leave every other setting at its default for now (group posting stays OFF).
3. `npm start`. A pairing code prints in the terminal (never in logs). On your phone: WhatsApp > Settings > **Linked devices** > Link a device > "Link with phone number instead" > enter the code. The provider refuses to run if the linked account is not `OWNER_PHONE`.
4. You should receive "Assistant online" in your own chat.

## Supervised verification (do these in order; none posts to other people)
1. Message yourself `/status` -> connected, group posting OFF. If nothing happens, see docs/DEPLOYMENT.md troubleshooting.
2. `/audience` -> note the usable-recipient count. Wait a few minutes after linking, then compare with your real contact count. **Before the first real Status:** `/audience mode manual` then `/audience add <a second number you control>` so the first test goes only to a phone you can check.
3. Send yourself a property description + 1 photo; say `done`; check `/properties` and `show PROP-001`.
4. `Post PROP-001 on my status now` -> read the draft -> `yes`. Check **on the second phone** whether the Status appears. This is the only way to confirm visibility. Then `/audience mode all` if you are happy with the list.
5. `/groups` -> compare with your real groups. Leave group posting OFF until this looks right. Only then consider `/groups enable` and a single test advert to a test group.
6. Create a schedule a few minutes ahead, confirm, watch it run and read the report; then cancel it.
7. `npm run backup` once and keep the backup somewhere safe.

## Things that may behave differently in reality (report them to me)
Commands not recognised in your self-chat (ID/LID handling), fewer contacts than expected, Status not visible to some people (privacy settings), group "admins-only" detection, WhatsApp restricting or logging out the session.

## Stop / undo at any time
`/pause` (holds everything) | `/schedule cancel S-1` | `/groups disable` | `Ctrl+C` / `systemctl stop testimony` | WhatsApp > Linked devices > select the session > Log out, then delete `data/auth_state/`.

## Security reminders
Revoke any GitHub token that was ever pasted into a chat and create a new fine-grained one limited to this repo. Keep the repo private. Never commit `.env` or `data/`.
