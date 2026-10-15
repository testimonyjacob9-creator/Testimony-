# Security

- Secrets live only in `.env` / host secret store. `.env`, session and data dirs are git-ignored.
- Never paste tokens in chat or commit them. Git pushes use a credential helper or one-time environment variable, never a URL stored in `.git/config`.
- Only `OWNER_PHONE` in its 1:1 chat can run commands. Groups and other senders are ignored.
- Logs redact message text, captions, tokens. Audit log records actions, not conversations.
- Media stored under `DATA_DIR/media` (mode 0700), never served publicly.

## Connecting a number
See docs/ACCOUNT_SETUP.md. The pairing code is printed to the terminal only. `data/auth_state/` is created 0700 (files 0600), is git-ignored, and holds the session: whoever has it controls the account. The library's own logging is disabled so credentials and message content cannot reach logs.

## Disconnecting
WhatsApp > Linked devices > select the session > Log out, then delete the local auth directory.

## If a credential leaks
- GitHub token: GitHub > Settings > Developer settings > Personal access tokens > Delete, then create a new fine-grained token scoped to this repo only.
- WhatsApp session: log out the linked device and re-pair.
- Leaked `.env`: rotate every value in it, then purge it from git history.


## AI (Gemini) execution boundary
Gemini only *proposes*. It has no shell, no JavaScript execution, no SQL, no secrets, no session directory and no ability to message anyone.
Flow: owner message -> owner authentication (unchanged) -> bounded context (current listing, recent refs, <=15 listings, <=8 schedules, last 6 turns) -> Gemini returns JSON -> strict schema validation (`src/ai/schema.js`; unknown actions/fields rejected, never repaired) -> listing refs re-verified in SQLite (an invented id is refused) -> existing handlers. Anything that changes data (status, price/field edits, schedule cancel, advert captions, new schedules) is shown as a draft and needs the owner's "yes"; pausing/resuming a schedule is reversible and runs immediately, and the success message is only produced after the database confirms it.
The owner's text is wrapped as data (`<owner_message>`); pasted adverts or forwarded messages cannot change the rules. Strangers and unauthorized groups never reach the AI. Generated adverts are checked against the saved record (numbers, money, promises like discounts/warranties) and rejected if they invent anything. The API key is never logged, returned or put in error text (errors are scrubbed; tested). A daily request cap limits spend.
