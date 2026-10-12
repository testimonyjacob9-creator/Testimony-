# Destination capability audit (Baileys 6.7.24, read from the installed library source)

Audited by inspecting `node_modules/baileys/lib`. "Supported by the library" does NOT mean verified against real
WhatsApp: nothing here has been run live. Each destination is a separate code path with separate risks.

| Destination | Library support | Hard requirements / caveats | Verification possible? | Project decision |
|---|---|---|---|---|
| **Groups** (list) | `groupFetchAllParticipating()` returns every group the account is in, with subject, participants, `announce` (admins-only posting) | Membership is implied by being listed | Yes (listing is authoritative at that moment) | **Implemented** (Feature: group selection) |
| **Groups** (send) | `sendMessage(groupJid, ...)` | Account must be a member; admin-only groups block non-admins; bulk sends risk restrictions | Server acceptance only; delivery/read not confirmed | **Implemented, OFF by default**, owner must enable, rate-limited, allowlist-only |
| **WhatsApp Status** | `sendMessage('status@broadcast', content, { statusJidList })` | **You must supply the recipient list** (`statusJidList`); the library has no built-in "my contacts" list. Only listed contacts can see the post. Media must be uploaded | **No.** There is no read-back of a posted status; server acceptance is the best signal | Planned (recurring schedule feature). Will report "sent to WhatsApp, visibility not confirmed", never "published" |
| **WhatsApp Channels** | Management APIs exist (`newsletterCreate/Follow/Metadata/FetchMessages/...`); the send path has newsletter handling (`messages-send.js`) | No documented/tested guarantee that posting works for an existing admin channel with this version; behaviour changes between releases | Unknown | **Disabled. No code path.** Revisit only with a live test on a throwaway channel |
| **Incoming media** | `downloadMediaMessage` / `downloadContentFromMessage` | Media URLs are temporary and encrypted; they must be downloaded immediately and saved to disk | n/a | Must be saved to `DATA_DIR/media` on receipt (never store URLs). Not built yet |

## Consequences
- Group and Status posting use different APIs and different failure modes; they are never treated as interchangeable.
- Status needs an explicit audience (contacts who may see it). That list must be configured by the owner. Not built yet.
- Channels stay off. This does not block the rest of the project (per the fallback rule).

## Deployment requirements (recurring posts)
A recurring schedule needs a process that is **always running** and holds the WhatsApp session:
- NOT suitable: Netlify/Vercel/serverless functions, or free hosting tiers that sleep.
- Suitable: a small VPS, a Raspberry Pi/always-on PC, or a container host with a persistent disk. Needs Node >= 22.13, a persistent folder for `data/` (SQLite DB, `auth_state/`, `media/`), and a process manager (systemd or pm2) to restart on crash/boot.
- Prices vary by provider and change; check current pricing before choosing. Nothing is purchased on your behalf.
- Restart safety: schedules and send records live in SQLite; every send is claimed atomically before execution, and interrupted sends are marked "outcome unknown" instead of being retried blindly, so a restart cannot cause a duplicate post.
