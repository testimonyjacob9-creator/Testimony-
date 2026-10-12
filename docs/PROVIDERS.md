# WhatsApp provider research

## Official WhatsApp Business Platform (Cloud API)
- Suitable for: sending/receiving 1:1 messages on a dedicated business number, templates.
- Groups API exists but requires Official Business Account (OBA) eligibility, and covers groups the business number creates/manages, not your existing personal groups.
- Posting to Status: no official endpoint found in our research; do not assume it exists.
- It cannot operate your personal WhatsApp account.

## Unofficial WhatsApp Web libraries (Baileys, whatsmeow, paid gateways)
- Can drive a normal account as a linked device, including Status and groups you already belong to.
- Risks: violates WhatsApp terms in some uses, possible number restriction/ban, protocol changes break it, session must be kept alive and stored privately.
- Mitigations in this project: owner-only control, approved-group allowlist, preview/approval before bulk sends, per-group dedupe, rate limits, no group discovery/auto-join, no evasion of anti-abuse controls.
- Recommendation: test with a secondary number first.

## Feature support matrix
| Feature | Official Cloud API | Baileys (planned) |
|---|---|---|
| Owner chat commands | Yes (business number) | Yes |
| Operate personal account | No | Yes (linked device) |
| Status text/image/video | No documented support | Yes, delivery not reliably verifiable |
| Message existing personal groups | No | Yes |
| Official Groups API | OBA only | n/a |
| Receive media | Yes | Yes |
| Ban risk | Low | Real |
