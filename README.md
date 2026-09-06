# Personal Tracker Push Worker

This Worker provides background Web Push reminders for the Personal Tracker PWA.

## Required Cloudflare configuration

1. Create a Workers KV namespace (for example `personal-tracker-clients`).
2. Add a KV binding to this Worker:
   - Variable name: `CLIENTS`
   - KV namespace: the namespace you created.
3. Add an encrypted secret:
   - Name: `VAPID_PRIVATE_KEY`
   - Value: use the value in the separate `PRIVATE-SETUP-NOT-UPLOAD.txt` file.
4. Deploy the Worker. The cron trigger in `wrangler.jsonc` runs once per minute.
5. Copy the final Worker URL into the app's `config.js`.

Public VAPID key is already stored in `wrangler.jsonc`.
The private key must NEVER be committed to a public GitHub repository.


## v4.1
ה-Worker תומך גם בתזכורות כלליות (חד-פעמיות, יומיות ושבועיות) ובתיאור פעולה/תזכורת בגוף ההתראה.
