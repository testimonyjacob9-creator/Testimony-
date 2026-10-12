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
