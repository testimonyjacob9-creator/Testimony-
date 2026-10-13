# Properties and media

## Adding a property
Send the description as a normal message (and photos/videos before or after). A message that states a property type plus at least one concrete
detail (price, bedrooms, location, sale/rent, land size) becomes a **draft** with a stable reference (`PROP-001`, never reused).
Extraction is rule-based and **only records what the text states**: sale/rent, contact, bathrooms etc. stay empty until you provide them; the reply lists what is missing.

Fill gaps: `set contact to 08031234567`, `Change the price of PROP-001 to 30 million`, `/property set PROP-001 listing sale`.
Say **done** to mark the draft *available*. A draft is never posted.

## Commands / phrases (owner only)
`/properties` (+ filters: "show properties below 20 million in Ekpoma", "available", "sold") | `/property PROP-001` or "show the second property" |
`/property sold|rented|unavailable|available PROP-001` or "mark PROP-001 as sold" | edits as above | `delete PROP-001` (drafts delete immediately;
others need your yes) | `/caption PROP-001 [short|long]` or "prepare three different captions for this property".
If a phrase matches several properties the assistant lists them and asks; it never guesses.

## Captions
Built only from saved fields (title, location, price, sale/rent label, rooms, features, contact, ref). A custom caption (`/property set PROP-001 caption ...`) overrides all styles.

## Media storage (safe local strategy)
- Photos (JPEG/PNG/WebP) and videos (MP4/3GP/MOV) are **streamed** to `DATA_DIR/media/PROP-xxx/` with a hard size cap (`MAX_MEDIA_MB`), checked against the declared size first and again while downloading. Temp files (`media/tmp`) are removed on failure and at startup.
- Directory 0700, files 0600, referenced by **relative path + SHA-256**; WhatsApp download URLs are never stored. Duplicate files per property are ignored.
- Before any scheduled post the files are re-checked (present, same size). Missing media = the post fails honestly.
- Files are not served over HTTP. Back up `DATA_DIR/media` together with the SQLite file (see docs/DEPLOYMENT.md). No paid storage is used; the only cost is disk space.
- A burst of uploads gets one acknowledgement (`MEDIA_ACK_DELAY_MS`, default 3000).
- Voice notes, documents and stickers are refused (not stored).

## Linking to marketing
`send PROP-001 to my approved groups` (text-only caption; photos/videos are not sent to groups yet) re-checks that the property is still *available* before **every** group send and records each accepted send in the property's history (`show PROP-001`).
