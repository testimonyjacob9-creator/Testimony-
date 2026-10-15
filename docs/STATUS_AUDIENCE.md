# Status recipients: what Baileys can and cannot do (read from the 6.7.24 source; the project now runs 7.0.0-rc14, not re-audited)

## How a Status post reaches people
`sendMessage('status@broadcast', content, { statusJidList })`. The library encrypts the post to **exactly the JIDs you list**.
It has no "all my contacts" shortcut, so the assistant must build that list itself.

## Where contacts can come from
| Source | Reliable? |
|---|---|
| `contacts.upsert` from WhatsApp app-state sync (`contactAction`) | Delivered by WhatsApp to a linked device, mainly right after linking / when app state resyncs. Not guaranteed on every connect. |
| `messaging-history.set` (`contacts`, push names) | Only when history sync is enabled. We keep `syncFullHistory: false`, so usually nothing. |
| `contacts.update` | Partial updates (push names) as people message you. |
| A contact-list API | **Does not exist** in this version. No in-memory store is bundled either. |
| Group member lists | Not contacts. People in your groups are not necessarily your contacts, so groups are never used as an audience. |

## Consequences (honest limits)
1. **The audience may be incomplete.** We only know contacts WhatsApp has actually sent to this linked device. The assistant persists them in SQLite as they arrive and shows counts (never numbers) via `/audience`.
2. **Some contacts have no phone number**: WhatsApp may identify them only by an anonymous ID (`@lid`). This version has no ID-to-phone mapping, so they cannot be targeted. They are counted ("not targetable"), never guessed.
3. **Privacy settings.** The assistant can read the privacy *mode* WhatsApp reports (e.g. `contacts`), but NOT your "My contacts except..." / "Only share with..." lists, and the library does not apply them for you. The post is encrypted to everyone in the list; WhatsApp's own apps/servers decide visibility. We cannot verify who sees a post, so reports never say "published", only "accepted by WhatsApp for N recipients".
4. **Empty audience = no posting.** If no recipients are known the Status feature refuses to post (it would only be visible to yourself).

## Safe configuration
- Default mode `all`: every phone contact learned from sync + numbers you added, minus exclusions.
- `/audience add <number>`: add a number you know. `/audience remove <number>`: exclude (stays excluded after re-syncs).
- `/audience mode manual`: use only the numbers you added. Use this if the synced list looks wrong or too broad.
- Your own number is always included so your other devices show your post.

## Suggested first-run check (needs your approval to connect)
After linking, wait a few minutes, then send `/audience`. If "Usable recipients" is far lower than your real contact count, either re-link to trigger a fresh contact sync, or add the missing numbers manually.
