# Group selection and adverts

Discovery, approval and sending are three separate things. **Seeing a group never authorises sending to it.**

## Commands (owner only; ignored from groups and other people)
| Command | What it does |
|---|---|
| `/groups` | Lists the groups the connected account is in (name, member count, 10 per page) |
| `/groups page 2` or "next page" | Next page; numbers continue and stay valid |
| `/groups select 1 3 5` or "Select groups 1, 3 and 5." | Drafts adding those groups (numbers from the last `/groups` list) |
| `/groups selected` or "Show my approved marketing groups" | Approved list, with a live accessibility check |
| `/groups remove 2` or "Remove the Ekpoma Properties group." | Drafts removal (numbers from `/groups selected`, or by name) |
| `/groups clear` | Drafts removing all approvals |
| `/groups enable` / `/groups disable` | Group posting master switch (OFF by default; enabling needs your yes) |
| `/advert <text>` / `/advert 2,4: <text>` / "Send this advertisement only to groups 2 and 4: ..." | Drafts an advert (numbers = `/groups selected`) |
| "send this to my approved groups" | Uses the last long message you sent (kept 30 min) |
| `/advert status`, "stop the advert" | Progress / cancel what has not been sent |

Every change is a draft first. Reply **yes** to apply or **no** to leave everything unchanged. While an advert draft is open:
"only groups 2 and 4", "add group 3", "remove group 3".

## Safety rules enforced in code
- Allowlist keyed by the stable group JID, never by name. A renamed group is still targeted by its id; a new id with the same name is NOT messaged.
- Re-checked immediately before each send: still approved, still accessible (fresh listing), admins-only restriction, duplicate protection. Any failure -> that group is skipped and reported; the rest continue.
- If the live group list cannot be fetched, nothing is sent (destinations cannot be verified).
- Pacing: one group every `GROUP_SEND_DELAY_SECONDS` (default 30); at most `MAX_GROUPS_PER_CAMPAIGN` (default 10); the same advert is not re-sent to a group within `GROUP_DEDUPE_HOURS` (default 24).
- No automatic retries (a retry could double-post). Failures are reported.
- A restart mid-send marks the interrupted group "outcome unknown" and never re-sends it.
- Global `/pause` holds adverts; `/groups disable` cancels unsent destinations.

## What "sent" means
"Accepted by WhatsApp" = the server accepted the message. It is **not** proof of delivery or that anyone read it. Reports say so.

## Limitations / remaining work
- Verified against the mock provider and a fake Baileys socket only, **not live WhatsApp**.
- Adverts are plain text you supply. Property-linked adverts, media adverts and per-group templates need the property module (Phase 3, not built).
- With `ACCOUNT_MODE=separate` the assistant number must already be a member of each group (it cannot discover or join groups for you).
- Group rules and WhatsApp limits are your responsibility; keep volumes low and post only where adverts are welcome.
