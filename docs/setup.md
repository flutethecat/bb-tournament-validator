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
- [ ] `DISCORD_BOT_TOKEN`: the bot's token, the same value as `DISCORD_TOKEN` in `apps/discord-bot/.env`
      ([Discord DMs](#discord-dms)).

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

## Discord DMs

Actionable notifications also go out as a Discord DM from the bot, with a link (owner 11-01): today a game-time
proposal received, countered or accepted. config-web sends them itself through the Discord REST API with the bot's token;
the bot process does not need to change or restart. Coaches choose on the Account page (Notifications panel, "Discord
messages for actions I need to take"): on by default for coaches with Discord linked.

1. **Token.** Put the bot's token in the live `apps/config-web/.env` as `DISCORD_BOT_TOKEN=<value>` (the same value as
   `DISCORD_TOKEN` in `apps/discord-bot/.env`). Never commit it or paste it anywhere. Unset = no DMs are queued.
2. **Link origin.** DMs carry absolute links, so `MAIL_LINK_BASE_URL` (or `PUBLIC_BASE_URL`) must be set too; without it
   DMs stay off and the log says so (`[discord-dm]`).
3. **Bot setup (Discord Developer Portal).** No privileged gateway intents are needed for DMs (config-web uses REST only;
   the bot must have connected to the gateway at least once, which the running bot does). Opening a DM and sending a
   message need no server permission. Coaches must **share a server with the bot** and allow DMs from server members;
   otherwise Discord refuses the DM (403).
4. **Restart** config-web (the scheduled task).

Behaviour: DMs ride the mail outbox (`<FORK_STATE_DIR>/mail/outbox/journal.jsonl`, channel `discord`) with the same
retries, backoff and send-time re-checks as email (opt-out, Discord still linked, account not being deleted). Discord rate
limits are honoured, and each message carries a nonce so a retry never posts twice. A DM Discord refuses for good (DMs
closed, no shared server, unknown user) is dead-lettered and falls back to ONE email, only when the coach agreed to emails
(league-contact consent) and has a confirmed address. A DM that runs out of retries (Discord down, bad token) is
dead-lettered without email. Coach, team and competition names are Markdown-escaped, so the action link is the only link. The outbox never
stores the coach's Discord id (it is looked up at send time), and logs never carry it or the token.

**Test.** With two accounts that share a server with the bot, propose a time from one to the other; the second gets a DM
"<coach> proposed times for <fixture>. Accept or decline: <link>". Turn the setting off on the Account page and propose
again: no DM.

## Dev and demo data

### Demo leagues (Browse leagues)

`apps/config-web/scripts/seed-demo-leagues.ts` writes 12 made-up leagues (every one named "Demo ..." and flagged
`test: true`) through the app's own store writers, so Browse leagues has something to show on a dev or demo server. The
data is fake: invented names and places, `example.com` links, no real coaches. Artwork comes from art already in the repo
(race crests and existing header art); nothing is downloaded. Both views show a small "Demo" chip on these leagues.

```
pnpm --filter config-web exec tsx scripts/seed-demo-leagues.ts <state dir>            # create or refresh
pnpm --filter config-web exec tsx scripts/seed-demo-leagues.ts <state dir> --remove   # delete them again
```

- `<state dir>` is the server's `FORK_STATE_DIR` (leagues live under `<state dir>/leagues`). Point a test server at a
  scratch dir, e.g. `FORK_STATE_DIR=<scratch> PORT=<free port> tsx src/server.ts`.
- The script refuses the live data dir (the server's default `apps/config-web/data-store`, the shell's `FORK_STATE_DIR`,
  or any folder named `data-store`) unless both `--live` and `--yes` are given. Don't seed the live site without the
  owner's go-ahead.
- The check compares real paths, so a link or junction to the live dir is refused too. A state dir that does not exist
  yet is created.
- Each league it writes is stamped `seededBy: { script: "seed-demo-leagues", run }`, and the run id and league ids go in
  `<state dir>/demo-leagues.seed.json`. `--remove` deletes a league only when its id is on the script's fixed demo list,
  the marker lists it, its stamp matches the marker's run, and it is still a test league named "Demo ..."; every other
  league is left alone. An existing league with a demo id that is not the script's own stamped record is never
  overwritten.
