# Go-live setup

Operator steps for taking config-web (Super FUMBBL) live. Each section belongs to one feature; values go in the live
`apps/config-web/.env` only, never in the repository.

## Privacy

Data export (Account page, "Download my data", `GET /api/me/export`) needs no setup.

Account deletion (Account page, "Delete my account", `POST /api/me/delete`, and the admin "Delete a coach" card) needs one
key:

1. Generate `PRIVACY_MAP_KEY`: at least 32 random characters, for example
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. Put it in the live `.env` as `PRIVACY_MAP_KEY=<value>`. Never commit it, never paste it into a ticket or chat, and keep
   it out of backups of the data-store directory (with the key and the data store together, a guessed coach name, NAF id
   or Discord id can be matched to its "Deleted coach #n" pseudonym; see `docs/privacy/log-hygiene.md`).
3. Restart config-web.

Without the key, account deletion answers **503** ("Account deletion is not configured on this host (PRIVACY_MAP_KEY)"),
the anonymise-on-write filters for results, replay moments and NAF games are off, and any delete job already in the
journal (`<FORK_STATE_DIR>/privacy/jobs/`) stays pending without running a step until the key is back. Do not change the
key later: a new key stops the filters matching coaches deleted under the old one.

Optional: `PRIVACY_BLOCKLIST_SALT` salts the hashed Discord ids kept for deleted banned coaches; unset, a salt is generated
into `<FORK_STATE_DIR>/privacy/blocklist-salt` on first use.

Delete jobs that cannot finish (the game server's account step, retried every 10 minutes) are marked stuck after 7 days and
listed on the admin "Delete a coach" card (Tabletop page) with Retry and Close. A stuck coach stays fenced (no sign-in, no
writes, no email) until an admin retries it successfully or closes it after finishing the remaining step by hand.
