# Personal Tracker Push Worker — v5

Cloudflare Worker for Personal Tracker Web Push notifications.

## What changed in v5
- Removed `KV.list()` from the every-minute cron path.
- Uses a single registry key (`_meta:client-index:v1`) plus ordinary KV reads instead.
- Keeps the cron at once per minute without consuming the 1,000/day KV List quota.
- Registers/repairs a device in the index whenever the app posts `/state`.
- Sends time-sensitive pushes with Web Push urgency `high`.
- Keeps a small per-device dispatch log so scheduled time can be compared with Worker send time through `POST /diagnostics`.

## Existing Cloudflare configuration
- KV binding: `CLIENTS`
- Runtime secret: `VAPID_PRIVATE_KEY`
- Cron: `* * * * *`

Do not commit the VAPID private key to GitHub.
