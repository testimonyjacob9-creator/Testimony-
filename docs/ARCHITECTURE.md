# Architecture

```
src/
  config.js          validated env config
  logger.js          pino with content/secret redaction
  storage/db.js      SQLite (node:sqlite), versioned migrations, audit()
  providers/         WhatsApp contract + mock (+ baileys in Phase 2)
  (planned) security/ owner auth
  (planned) commands/ slash + natural-language -> structured actions (provider-independent)
  (planned) modules/  properties, status, groups, leads, scheduler, media
```

Principles
- Everything outside `providers/` depends only on the `WhatsAppProvider` interface.
- Every action is first a **proposed** pending action; only the provider result marks it **completed**.
- Results carry `verified` so we never claim a Status was published when it cannot be confirmed.
- Persistent state (jobs, approvals, history) lives in SQLite so restarts lose nothing.
- Message content is not logged; the audit log stores actions and outcomes, not conversations.
