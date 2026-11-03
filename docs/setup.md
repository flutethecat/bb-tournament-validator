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
- [ ] `DISCORD_INVITE_URL`: optional; the Super FUMBBL Discord invite (`https://discord.gg/<code>`) shown to coaches who
      share no server with the bot ([Discord DMs](#discord-dms)). Unset = no invite line.
- [ ] `DISCORD_CLIENT_ID`: optional; the bot application's id, for the "Add the Super FUMBBL bot to your server" button in
      league settings ([Competition Discord](#competition-discord)). Unset = the button is hidden. (The same key Discord
      sign-in already uses.)
- [ ] League Events in Discord (optional): `DISCORD_BOT_TOKEN` + `DISCORD_CLIENT_ID` above, and the bot invited to each
      league's server with **Manage Events** ([League Events](#league-events)).
- [ ] `LEAGUE_EVENTS_MARKER_KEY`: optional; 32+ random characters. Signs the hidden marker on Discord events (unset = a key
      derived from `DISCORD_BOT_TOKEN`; changing it only means a lost create may be posted twice) ([League Events](#league-events)).
- [ ] `FORK_ROUTES_REQUIRE_AUTH`: leave unset (off) until the client changes in [Fork route lockdown](#fork-route-lockdown)
      have shipped; then set `1`.
- [ ] `CONFIG_WEB_SERVICE_KEY`: optional; only if a server-to-server caller needs the fork reads
      ([Fork route lockdown](#fork-route-lockdown)). Unset = the service header is never accepted.

Outside steps:

- [ ] Postmark: create the Server, add a Broadcasts stream, request account approval after DNS verifies.
- [ ] Postmark: add the `superfumbbl.com` sender signature (domain).
- [ ] DNS at the superfumbbl.com host: SPF (`include:spf.mtasv.net`), the DKIM TXT record Postmark shows, the `pm-bounces`
      CNAME to `pm.mtasv.net`, and a `_dmarc` TXT record starting at `p=none`.
- [ ] Postmark: webhook on both streams (Bounce, Spam Complaint, Subscription Change); "Send test" returns 200.
- [ ] Restart config-web (the scheduled task), check the log for `[mail]` warnings, then run the mail test below.
- [ ] Keep `PRIVACY_MAP_KEY` out of data-store backups.

## Fork route lockdown

Owner rulings (11-03): "No-sign-in paths should be locked down for all fork paths." and "Tournament Builder remains open
but saving is locked behind login." The policy lives in `apps/config-web/src/auth/forkRouteAuth.ts`.

`FORK_ROUTES_REQUIRE_AUTH` (default **off**; `1` / `true` / `on` / `yes` turns it on, read on every request, no restart
needed for the code path but restart config-web after editing `.env`):

- Off: the fork routes behave exactly as before.
- On: these answer **401** with `{"code": "sign_in_required"}` unless the caller is signed in (the `cw_session` cookie, or
  `Authorization: Bearer <token>` from `POST /api/fork/login` or the Discord desktop claim `POST /api/auth/desktop/claim`):
  `GET /api/fork/library` (a coach reads only their own; organisers, admins and the service key read any),
  `POST /api/fork/library/ingest`, `POST /api/fork/library/retire`, `GET /api/fork/coaches`, `GET /api/fork/games`,
  `GET /api/fork/records`, `POST /api/fork/team-builder/build`, `POST /api/fork/my-games`, `/api/fork/team-builder/saves`.
  `my-games` and `build` still accept the deprecated body coach + fork password (verified against the fork DB) as the
  client's fallback when its token exchange fails.

Always open: `POST /api/fork/login`, `GET /api/fork/name-available`, `GET /api/fork/register` (sign-up), the Tournament
Builder reads (`/api/fork/rosters`, `team-builder/tiers`, `limits`, `inducements`, `legal-skills`,
`POST team-builder/preview`) and the public tournament reads.

**Game creation is exempt, temporarily** (owner 11-03: "Hold on fixing the client, we don't need to lock down game creation
yet."): `GET /api/fork/challenge`, `matchstatus`, `cancel` and `jnlp` keep their old behaviour with the flag on or off,
including the query-string password (digest and clear text). Lifting the hold means moving them into the lockdown table
and shipping the client changes first.

Always on, whatever the flag: `POST /api/fork/reload` is admin only (an organiser session gets 403).

Server-to-server: `CONFIG_WEB_SERVICE_KEY` (header `X-CW-Service-Key`) lets a server read `GET /api/fork/records`,
`GET /api/fork/coaches` and any `GET /api/fork/library` with the flag on. Nothing needs it today (the fork server calls no
`/api/fork/*` route; the Discord bot signs in with `POST /api/fork/login` and uses Bearer). Generate it on the host like the
other secrets if a caller appears.

Before turning the flag on, the desktop client must:

1. Send its held Bearer for Discord-signed-in coaches (today `ensureConfigWebToken` returns no token without a saved fork
   password, so Discord-only coaches call every fork route anonymously).
2. Send the Bearer on `GET /api/fork/records` (Statistics view uses a plain fetch).
3. Treat `401` with `code: "sign_in_required"` as "sign in", not "wrong password".

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

**Queue and pacing.** DMs go out at most 3 per second (the outbox's `discord` channel pace, on top of the global 10 per
second); a 429 from Discord holds the route for Discord's `retry_after` and longer waits go back to the outbox backoff
(30 s, 2 min, 8 min ...). The journal survives restarts. With no `DISCORD_BOT_TOKEN` nothing is queued.

**Registration notice.** Registration forms show "We'll message you about this event on Discord. You can turn this off in
Account." When the token is set, config-web asks Discord whether the coach shares a server with the bot
(`GET /api/me/discord-reach`, cached 10 minutes; the coach's Discord id and the token are never answered or logged); if not,
and `DISCORD_INVITE_URL` is set, the form adds "Join the Super FUMBBL Discord to get messages" with the invite.

**Test.** With two accounts that share a server with the bot, propose a time from one to the other; the second gets a DM
"<coach> proposed times for <fixture>. Accept or decline: <link>". Turn the setting off on the Account page and propose
again: no DM.

## League Events

Organisers add league nights, drafts, tournament days, socials and other events in League management, Schedule. They show
on the league Calendar, coaches get an inbox note (and, when the organiser leaves it on, a reminder 24 hours before each
occurrence), and the league webhook gets "New league event" (an event toggle in Competition Discord, on by default; each
event's own "Post to Discord" starts ticked for league nights). Events live in `<FORK_STATE_DIR>/leagues/<id>/events.json`
(no coach data). Drafts never notify or post.

**Discord scheduled events (optional, needs the bot).** With the bot in the league's Discord server, an organiser can turn
on "Create Discord events" in League settings, External connections, and pick the server (and optionally a voice channel
for online events). Each League Event then keeps one Discord scheduled event for its next occurrence: created, updated,
moved and deleted with it, and rolled on to the next week for a repeating event. Calls run in the background, retried with
backoff (30 s, 2 min, 10 min, 30 min, 2 h, then 6 h; 8 attempts), and never hold up a save. Removals that run out of
retries are kept and listed in Connections with "Retry cleanup".

**Who can pick a server.** The bot is shared by every league, so an organiser sees and can pick only servers where their
LINKED Discord account (Account page) has Manage Events or Administrator; config-web reads the member and roles with the
bot token. Every sync re-checks that at least one current organiser of the league still has it; if none has (permission
removed, Discord unlinked), the sync stops and Connections says why, and it resumes once a manager has it again. When a
voice or stage channel is picked, the check uses the EFFECTIVE channel permissions (role and member overwrites count),
for the organiser and for the bot (View Channel, Connect, Manage Events).

**Only the bot's own events.** Each Discord event carries a marker signed with `LEAGUE_EVENTS_MARKER_KEY`. The sync adopts
(after a lost create) or removes an event only when Discord says the bot created it; events made by anyone else are never
changed or deleted. Cleanups that ran out of retries are re-checked hourly, also with the option off, and retried once
the bot can manage events in that server again.

1. **Token.** `DISCORD_BOT_TOKEN` (see [Discord DMs](#discord-dms)). Unset = the option shows "Add the Super FUMBBL bot to
   your server to create Discord events" and nothing is sent to Discord.
2. **Invite button.** `DISCORD_CLIENT_ID` (see [Competition Discord](#competition-discord)). The League Events invite asks
   for View Channels, Send Messages, Embed Links **and Manage Events** (permissions `8589954048`).
3. **Bot permission in each server.** The bot needs **Manage Events** in the league's server (granted by that invite, or
   added to the bot's role by a server admin). For online events held in a voice channel it also needs View Channel and
   Connect on that channel. Without Manage Events Discord answers 403: the organiser sees "The bot can't manage events in
   that server" and the sync keeps retrying with backoff.
4. **Restart** config-web (the scheduled task). Nothing is set live by a build.

**Test.** In a test league: invite the bot to a test server, turn on "Create Discord events", pick the server, add a League
Event an hour ahead; the server's Events list shows it within a minute. Edit the time (it moves), then delete it (it goes).

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

## Operations

### League fork team copies (cleanup and backfill)

Play on Super FUMBBL installs a copy of each league team on the fork for the fixture (fork team id `lg_<16 hex>`, a team
file in `FORK_TEAMS_DIR` plus a row in the coach's fork library). Owner 11-03: those copies are deleted at the end.

- **Automatic.** When a fixture's result is banked (or Super FUMBBL play is cancelled with no game left on the fork), the
  same store write marks the fixture's copies for removal (`fork.cleanup`, "pending"). Results from every other writer
  (hand entry, forfeit, deadline outcome, recorder) are picked up by a scan on the same tick. The server's 2-minute sync
  tick (and one run 30 s after start, so a restart resumes) removes them under the install's locks: refused while any of
  the teams is in a live or scheduled game; then a per-team "reload required" marker
  (`FORK_TEAMS_DIR/.league-copy-removals/<id>.json`), the library rows, the team files and a fork reload, which clears
  the marker. While a marker is left by a failure, only games with those teams are refused (a fresh build of the team
  replaces it); everything else keeps working. Failures retry with a backoff (2 min doubling to 6 h) and never hold up
  banking. A copy another fixture still needs is kept and removed once nothing needs it; every fixture that recorded a
  removed copy forgets its build fingerprint, so generating it again rebuilds the team. If a copy whose removal failed
  is needed again by another fixture, its marker is dropped and those fingerprints too, so that fixture's next Generate
  reinstalls it. Each removal is one
  `[leagues] Super FUMBBL team copies removed ...` line in the server log (league / season / fixture ids and fork team
  ids only) and an entry in the fixture's fork history.
- **First scan baseline.** The first scan on a server writes `<FORK_STATE_DIR>/league-fork-cleanup-baseline.json`
  with the fixtures that were already finished with their copies before this existed. The server never touches those on
  its own; they are the backfill's job. Deleting the file makes the next scan write a new baseline (it never cleans the
  fixtures it lists). The file is read strictly (`createdAt` and `refs`, every ref a `league/season/fixture` key): if it
  is malformed the scan marks nothing (it fails closed), logs `[leagues] Super FUMBBL team copy scan skipped: ...` every
  tick, and the backfill and admin route report it, until it is fixed or deleted.
- **Backfill (one-off).** List first, from the server's folder (reads the server's `.env`: `FORK_STATE_DIR`,
  `FORK_LIBRARY_DIR`, `FORK_TEAMS_DIR`; `--state-dir`, `--library-dir`, `--teams-dir` override them). The dry run only
  reads:

```
pnpm --filter config-web exec tsx scripts/fork-team-cleanup.ts
```

  Then remove through the running server, signed in as a site admin, so every fixture write goes through the server's
  own store and fork locks (a cookie call also needs the `X-CW-Auth: 1` header). The body `{}` is the same dry run:

```
POST /api/admin/league-fork-cleanup   {"apply": true}
```

  `--apply` on the script is only for a stopped server. A running config-web holds `<FORK_STATE_DIR>/.config-web-running.lock`
  (whatever host or port it listens on), and the script refuses while a live process holds it; a lock left by a process
  that died is taken over. The script holds the lock while it applies. Both need the fork admin API
  (`FORK_ADMIN_PASSWORD`: live-game check and reload). Only `lg_` league copies are ever touched; a coach's own teams
  are never listed.

## Competition Discord

Leagues, their seasons (and later ladders) and tournaments each post to their own Discord webhook. Nothing here needs an
environment key: organisers paste webhook URLs in the app, where they are stored server-side and only ever shown masked.

- **Where.** League settings, External connections (league webhook, Weekly Digest, season webhooks); tournament Manage,
  Discord; the tournament wizard's Registration step. A blank season webhook uses the league's; a blank tournament webhook
  uses its series' when the series has one. A new season copies the league's webhook and options when it is made.
- **Events.** One toggle per event. Tournaments start in tournament mode (published, registration closing in 24 hours,
  check-in open, pairings posted, match end, round summary, final standings). In-game events come only from recorded games
  (the tabletop recorder, Super FUMBBL results); deaths and sent-offs post live, the rest go in the end-of-game digest unless
  switched to live. Hand-entered results are never announced. Drafts never post. Coach-typed text is always posted with
  listed words starred (***).
- **Weekly Digest.** On by default for a league with a webhook: Sunday 10:00 in the league's time zone (League settings, General;
  defaulted to the organiser's browser zone at creation; UTC until set),
  or every 2 / 4 weeks, or after each round. Weeks without games are skipped. The last run is stored in
  `<FORK_STATE_DIR>/discord/ledger.json`, so a restart never posts twice.
- **State.** `<FORK_STATE_DIR>/discord/` holds tournament options (`competitions.json`), tournament / series webhooks
  (`secrets.json`, keep it out of shared backups like the league `secrets.json` files) and the posted-events ledger.
- **Optional bot invite.** With `DISCORD_CLIENT_ID` set, league settings show "Add the Super FUMBBL bot to your server"
  (OAuth invite with View Channels, Send Messages and Embed Links; the League Events invite adds Manage Events, see
  [League Events](#league-events)). Posting through the bot instead of the webhook is a later
  step; today every competition post goes through its webhook.
- **Test.** In a test league with a webhook to a test channel: "Send test post", then "Send samples of every event"
  (one "[TEST]" sample per ticked event, at most once every 10 minutes per competition), then Weekly Digest "Preview".
