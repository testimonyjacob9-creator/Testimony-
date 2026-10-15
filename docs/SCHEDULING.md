# Recurring posts and the morning routine

## How you use it
Send (or pick) a property, then say it in plain English:
"Post this every morning at 8 AM" | "Post this video every day at 7 PM" | "Post PROP-002 Monday to Saturday at 9 AM until 30 Nov" |
"Post this house tomorrow morning" | "Post this property on my status now" | "Send PROP-001 to my approved groups every day at 9 AM".
The assistant replies with a **draft** (property, time, destination, start/end date, media, caption, warnings). **Nothing is scheduled until you reply yes.**
Edit the draft first: "change the time to 10 AM", "Monday to Saturday", "until 30 Nov". A new "Post ..." message replaces the draft.

## Managing schedules
`/schedule` (list) | `/schedule pause|resume|cancel [S-1]` | `/schedule time S-1 10am` | `/schedule history [S-1]` and plain English:
"Pause the morning posts", "Resume the schedule", "Stop posting the old apartment", "Change the posting time to 10 AM", "Move the afternoon status to 5 PM",
"Show me everything scheduled for tomorrow". If a phrase could mean several schedules or properties the assistant lists them and asks. **Cancel is permanent**: a cancelled schedule never restarts; only a *paused* one can be resumed.
`/pause` / `/resume` (no schedule words) is the **global switch** that holds all automation.

## Guarantees (all covered by automated tests)
- **No duplicate runs**: each schedule has at most one run per local date, enforced by a database UNIQUE constraint written in the same transaction that advances the schedule. Parallel ticks, repeated ticks, a second process or a restart cannot post twice.
- **Per-item claims**: every Status item is claimed before sending. A crash mid-post marks the item "unknown", the run "unknown", warns you on restart, and **never re-sends**.
- **Retries**: a failed attempt is retried after `SCHEDULE_RETRY_DELAY_SECONDS` up to `SCHEDULE_MAX_ATTEMPTS`; a retry only sends items that were not already accepted. Then it is reported as FAILED/PARTIAL.
- **Missed runs**: if the assistant was offline/paused past `MISSED_RUN_GRACE_MINUTES` (default 120) the run is skipped and reported, never posted late. While disconnected nothing is consumed; within the grace window it posts after reconnecting.
- **Availability**: the property must be `available` at run time. Marking it sold/rented/unavailable pauses its schedules immediately (and a run re-checks anyway). Paused-because-sold schedules refuse to resume until the property is available again.
- **Media**: files are re-checked on disk before posting; a missing file fails the run with nothing partially posted.
- **Empty audience**: no recipients = no post (docs/STATUS_AUDIENCE.md).
- **Honest wording**: Status success is only ever "accepted by WhatsApp for N recipients; I cannot confirm who saw it". Group runs say "queued as advert C-n"; the group sender reports real per-group results. The word "published" is never used.

## Reports
All schedules due together produce **one** private report ("Your 8:00 AM routine has finished": per property result, group promotion status, next run). Failures and retries are reported immediately.
Optional **morning briefing** (`/routine on`, `/routine time 7:30am`): what is scheduled today plus warnings (paused schedules, empty audience, global pause, drafts awaiting approval). Sent at most once per day, within 3 hours of its time.

## Group schedules
Disabled until `/groups enable` is confirmed. A group schedule posts the property's text caption to the approved groups (re-validated at run time; text only). Each day's run is a separate advert, so daily repeats are allowed only because you scheduled them; the draft warns that frequent posting can annoy members.

## Not supported
WhatsApp **Channels** (refused with an explanation), photos/videos to groups, reading back whether a Status was seen.
