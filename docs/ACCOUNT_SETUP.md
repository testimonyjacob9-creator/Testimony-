# Which WhatsApp account runs the assistant?

You must choose before the first live connection. Set `ACCOUNT_MODE` to `self` or `separate`.
The provider verifies the linked account at connect time and refuses to run if it does not match.

## Option A - `self`: your existing number (+234 xxx xxx xxxx)
The assistant is linked to your own WhatsApp as a "linked device". You command it by sending
messages to yourself ("Message yourself" chat).

| Aspect | Effect |
|---|---|
| WhatsApp Status | Posts appear on YOUR status (what you asked for) |
| Groups | Can use groups you are already in, sending as you |
| Contacts | Buyers see messages from your normal number |
| Risk | WhatsApp can restrict the number if automation looks abusive. That would hit your MAIN business number |
| Security | Anything sent from your own phone/other linked devices to yourself is a command. Keep your phone secure |
| Setup | `OWNER_PHONE` only. Pairing code is requested for the same number |

## Option B - `separate`: a dedicated number for the assistant
A second SIM/WhatsApp (ideally WhatsApp Business app). You message that number from your personal one.

| Aspect | Effect |
|---|---|
| WhatsApp Status | Posts appear on the ASSISTANT number's status, seen only by people who saved that number. NOT your personal status |
| Groups | The assistant number must be added to each group by a member first |
| Risk | A restriction hits only the secondary number |
| Security | Commands accepted only from `OWNER_PHONE` DMs; the bot's own messages are ignored |
| Setup | `OWNER_PHONE` + `BOT_PHONE` (must differ) |

## Recommendation
Start with **`separate`** to test safely (lowest risk to your main number), then move to **`self`** only if you
need posts on your own status and your own groups. Status/group features are Phase 4-5; Phase 2 only
needs the private command chat, which works in both modes.

## What to configure (either mode)
1. `cp .env.example .env`, set `OWNER_PHONE`, `WHATSAPP_PROVIDER=baileys`, `ACCOUNT_MODE`, (and `BOT_PHONE` for separate).
2. `npm install && npm test` (must pass).
3. `npm start`. A pairing code prints in the terminal (never in log files).
4. On the phone of the account being linked: WhatsApp > Linked devices > Link a device > "Link with phone number instead" > enter the code.
5. The assistant messages you "Assistant online". Send `/status`.
6. Back up `data/auth_state/` privately. Anyone who has it controls the account. Never commit it.

## Not verified live
The Baileys provider is tested against a fake socket only. It has not yet connected to real WhatsApp. The first
live run should be supervised, on a number you can afford to have restricted.

## Disconnect
WhatsApp > Linked devices > select session > Log out, then delete `data/auth_state/`.
