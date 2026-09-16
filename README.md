# Personal Tracker Push Worker v6.2 — Stability Update

Goals:
- Keep the indexed KV scheduler (`usesKvList:false`) and one-minute cron.
- Suppress unnecessary KV writes when client state/subscription/timezone did not change.
- Avoid stale remote state overwriting newer local PWA data.
- Add a 10-minute catch-up window for scheduled reminders, so a missed cron minute does not lose the reminder.
- Keep notification actions: Done / Snooze one hour. (`Cancel` remains an in-app action rather than a notification button.)
- Add richer diagnostics for subscription state, last server events, pending actions and snoozes.
- Preserve task reminders.
- On first v5.5 client sync, clear legacy snoozes from earlier unstable tests.
- Keep VAPID private key as a Cloudflare secret; never commit it to this repository.

After deploy, `/health` should report:
- `scheduler: indexed-v3`
- `usesKvList: false`
- `notificationActions: true`
- `taskReminders: true`
- `actionSync: server-merge-v2`
- `writeSuppression: true`
- `catchUpMinutes: 10`
- `diagnosticsV2: true`
