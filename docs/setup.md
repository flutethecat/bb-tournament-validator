# Go-live setup

Operator steps for taking config-web (Super FUMBBL) live. Each section belongs to one feature; values go in the live
`apps/config-web/.env` only, never in the repository.

## Go-live checklist

Every key and outside step from the sections below, in one list. Generate secrets on the host; never commit them or paste
them into a ticket or chat.

Environment keys (`apps/config-web/.env`):

- [ ] `PRIVACY_MAP_KEY`: 32+ random characters; set once, never change ([Privacy](#privacy)).
- [ ] `PRIVACY_BLOCKLIST_SALT`: optional; unset = generated on first use ([Privacy](#privacy)).
- [ ] `POSTMARK_SERVER_TOKEN`: the Postmark Server API token ([Portal email](#portal-email-postmark)).
- [ ] `MAIL_FROM`: the no-reply address on superfumbbl.com.
- [ ] `MAIL_REPLY_TO`: optional; leave unset.
- [ ] `MAIL_STREAM`: `outbound` (default).
- [ ] `MAIL_LEAGUE_STREAM`: the Broadcasts stream id (for example `broadcast`); unset = `MAIL_STREAM`.
- [ ] `MAIL_LINK_SECRET`: 32+ random characters; signs unsubscribe and confirmation links.
- [ ] `MAIL_LINK_BASE_URL`: the public origin, for example `https://superfumbbl.com` (or set `PUBLIC_BASE_URL`).
- [ ] `POSTMARK_WEBHOOK_SECRET`: a random string; the webhook password.

Outside steps:

- [ ] Postmark: create the Server, add a Broadcasts stream, request account approval after DNS verifies.
- [ ] Postmark: add the `superfumbbl.com` sender signature (domain).
- [ ] DNS at the superfumbbl.com host: SPF (`include:spf.mtasv.net`), the DKIM TXT record Postmark shows, the `pm-bounces`
      CNAME to `pm.mtasv.net`, and a `_dmarc` TXT record starting at `p=none`.
- [ ] Postmark: webhook on both streams (Bounce, Spam Complaint, Subscription Change); "Send test" returns 200.
- [ ] Restart config-web (the scheduled task), check the log for `[mail]` warnings, then run the mail test below.
- [ ] Keep `PRIVACY_MAP_KEY` out of data-store backups.

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

## Portal email (Postmark)

Full guide: [`docs/mail/setup.md`](mail/setup.md). In short:

The server sends two kinds of email: address confirmation (Account page, Email panel) and league messages (an organiser's
"Message members"). Organisers never see addresses. Until `POSTMARK_SERVER_TOKEN` is set nothing leaves the host (the log
transport writes one redacted line per message).

1. **Postmark server.** Create a Server; its `outbound` stream carries confirmations. Add a **Broadcasts** stream (for
   example `broadcast`) for league messages. Copy the Server API token into `.env` only. Ask Postmark to approve the
   account once DNS is verified.
2. **Sender.** Sender Signatures > Add Domain > `superfumbbl.com`. From = a no-reply address on that domain; the display
   name "Super FUMBBL" is set in code.
3. **DNS** (at the superfumbbl.com host; copy the exact values Postmark shows):
   - SPF: TXT on the domain, `v=spf1 include:spf.mtasv.net ~all` (add the include to an existing SPF record instead of a
     second one).
   - DKIM: the TXT record Postmark shows (host like `<date>pm._domainkey`).
   - Return-Path: CNAME `pm-bounces` to `pm.mtasv.net`.
   - DMARC: TXT `_dmarc`, `v=DMARC1; p=none; rua=mailto:<a mailbox you read>`; move to `p=quarantine` after clean reports.
4. **Environment keys:** `POSTMARK_SERVER_TOKEN`, `MAIL_FROM`, `MAIL_REPLY_TO` (optional), `MAIL_STREAM`,
   `MAIL_LEAGUE_STREAM`, `MAIL_LINK_SECRET`, `MAIL_LINK_BASE_URL` (or `PUBLIC_BASE_URL`), `POSTMARK_WEBHOOK_SECRET`. Restart
   config-web; the log names anything missing.
5. **Webhook.** On each stream: URL `https://postmark:<POSTMARK_WEBHOOK_SECRET>@<site host>/api/mail/postmark/webhook`,
   events Bounce, Spam Complaint and Subscription Change. Hard bounces and complaints suppress the address (only a salted
   hash is kept).
6. **Test.** Send yourself a confirmation link from the Account page; then, as an organiser, "Message members" to a
   second account that has league-contact consent, the league acknowledgement and a confirmed address. Check Postmark
   Activity and `<state>/mail/outbox/journal.jsonl`.
