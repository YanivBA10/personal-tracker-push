# Personal Tracker Push Worker v6

Update goals:
- Keep the indexed KV scheduler (`usesKvList:false`) and the one-minute cron.
- Add notification actions: Done / Snooze one hour / Cancel.
- Add background reminders for Tasks.
- Reconcile notification actions back into the local PWA state on the next sync.
- Keep VAPID private key as a Cloudflare secret (do not add it to this repository).

After deploy, `/health` should report `scheduler: indexed-v2`, `usesKvList:false`, `notificationActions:true`, and `taskReminders:true`.
