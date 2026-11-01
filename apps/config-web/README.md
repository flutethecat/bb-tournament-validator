# config-web

Plain Node `http` server (`src/server.ts`, run with `tsx`) serving `public/` and the JSON API on :4310.

## League & Tournament Manager SPA (`/app/`)

The manager is becoming a single Vue 3 + vue-router + TypeScript SPA (owner ruling 2026-10-22), phased: the shell
ships now and the hand-built pages migrate in as they are touched. Source: `spa/`. Build output goes to
`public/app/` and is **not committed** (gitignored).

```sh
pnpm --filter config-web build:spa        # vite build --config spa/vite.config.ts -> public/app/
pnpm --filter config-web typecheck:spa    # vue-tsc -p spa/tsconfig.json --noEmit
```

The server serves `/app` and `/app/*` as public static in both auth modes (like `/lobby/`): any path under `/app`
without a file extension (and not under `/app/assets/`) is answered with `/app/index.html` (history fallback,
`src/spaRoutes.ts`). Every API call the SPA makes gates itself. The build directory defaults to `public/app/`;
`SPA_DIST_DIR` (env) points the server at another one. `/theme.css` and `/theme.js` stay unbundled and
are loaded by `spa/index.html`; the shell styles with their `--ui-*` tokens, so the Black/Red (dark) and FUMBBL
(light) presets apply as on every other page.

| Route | Page |
|---|---|
| `/app/` | redirects to `/app/lobby` |
| `/app/lobby` | Start Game (challenge a coach, challenges for you, your lobbies). Needs a Discord session |
| `/app/lobby/:id` | a Lobby (presence, chat, rosters, coach card, Start game). Needs a Discord session |
| `/app/tabletop` | Tabletop: New match (my team, opponent coach + their team save id, post-match none / spp-only / full) and my matches (ids this browser remembers; no list endpoint yet). Needs a Discord session |
| `/app/tabletop/:id` | the phone-first match recorder (events through an offline queue, submit, per-coach confirm; organiser Undo revision when `/api/auth/session` says `organizer`). Needs a Discord session |
| `/app/tabletop/organiser` | organiser console (round matches, bulk Confirm & publish / Reopen, CSV export); organiser sessions only |
| `/app/standings?league=` | league standings table from `/api/standings` (public) |
| `/app/tournaments` | placeholder linking to `/tournaments.html` |
| `/app/team-builder` | placeholder linking to `/team-builder.html` |
| `/app/tournament-team-builder` | the Tournament Builder (the old `/tournament-team-builder.html` 302s here, `?save=<id>` becomes the path) |
| `/app/account` | the session's Discord identity + linked FUMBBL name (`GET /api/account`), Sign out |

Identity is the Discord session only: `spa/src/session.ts` reads `GET /api/auth/session` (the same endpoint the
vanilla page reads) and counts a session only when it says `authMethod: "discord"`. Signed out, or signed in with a
password session, a route marked `requiresAuth` renders the sign-in prompt in place of the page (a password session
is never labelled as Discord); "Login with Discord" goes to `/api/auth/discord/start?next=/app/<route>`, so the
coach lands back where they were.

The SPA Lobby behaves as the vanilla page: Accept / Confirm challenge / Close follow the server's `canAccept` /
`canRenew` (`lobbyControl` in `spa/src/shared/format.ts`); Start game posts `/launch` and downloads the
session-scoped `GET /api/lobby/:id/jnlp` it names; a temporary rating failure shows "Rating unavailable right now"
and retries on later polls with backoff (15 s doubling to 5 min); chat keeps the last 200 lines; a socket refusal
(`lobbyRefused`) is explained and not retried, other drops reconnect up to 5 times. A pending pairing
(`settingUp`: the game server's answer was lost and the server is retrying) shows "Setting up the game" from the
shared status line while the 4 s poll continues (no Close while the fork is being asked); a client-side seat in a
mixed pairing shows "in the client". An uncertain setup (`canCheckAgain`) shows "Game setup did not confirm"
(pointing at Your games) with Check again (`POST /api/lobby/:id/check`) and Start over
(`POST /api/lobby/:id/start-over`) for either coach, and no Accept / Confirm / Close; a ready game with
`duplicateGames` adds "An extra game was created; an organiser can remove it."

Layout (`spa/src`): `app.ts` builds app + router + session + library; `router.ts` holds the routes, the nav and
the auth gate; `views/` one component per route; `components/` shared pieces; `lobby/` the Lobby controllers (no
DOM, unit-tested); `shared/` modules also used by the vanilla Lobby page (`api.ts`, `format.ts`, `lobby.css`).

### How pages migrate

1. Build the page as `spa/src/views/<Name>View.vue` (logic that talks to the API in a plain `.ts` controller next
   to it, so it can be tested without a DOM, as `lobby/room.ts` is).
2. Point its route in `spa/src/router.ts` at the new view instead of `LinkOutView` (add `meta.requiresAuth` if it
   needs a session). Shared fetch/format helpers go in `spa/src/shared/`.
3. Add route tests to `test/spaShell.test.ts` (server-rendered against a mocked API).
4. When the SPA page fully covers the old one, a later lane redirects the old `.html` to `/app/...` and deletes it
   (the vanilla `/lobby/` page is kept this round).

GET `/api/account` carries `fumbblName`: the linked FUMBBL name from the tournament coach registry
(`src/fumbblLink.ts`, also used by the Lobby coach card). An entry with the coach's Discord id wins; otherwise the
registry `fumbblName` must equal the fork coach name exactly (case-sensitive), be unique, and not belong to a
different Discord account. Anything else is `null`. The registry has no FUMBBL coach id, so none is returned.

Sign out (Account page) posts `POST /api/auth/logout` (`X-CW-Auth: 1`, live session required). The sidecar portal
handles it with the sidecar on; with it off, `server.ts` dispatches the same handler (`handleLogout` in
`src/auth/portal.ts`).

## Privacy notice (`/app/privacy`)

Public page; the data inventory it renders lives in `spa/src/privacy/inventory.ts` (the export/delete lanes import it too).
The "Who we are" block reads `GET /api/privacy/contact` (cached 5 min), which serves `PRIVACY_CONTROLLER_NAME` and
`PRIVACY_CONTACT_EMAIL` from the environment (see `.env.example`); unset, both are `null` and the page says "Contact: see the
Help page". Hosting is fixed at "United States" and `euRepresentative` is `null` until paid launch. Breach runbook, processor
list and log-hygiene notes are in the repo root `docs/privacy/`.

## Start Game / Lobby page (`/lobby/`)

Source: `lobby/` (vanilla TypeScript + Vite, styled with the site theme `/theme.css` + `/theme.js`, which stay
unbundled). Its API client, display helpers and component CSS live in `spa/src/shared/` (shared with the SPA's
`/app/lobby`, which ports this page). Build output goes to `public/lobby/` and is **not committed** (gitignored).

```sh
pnpm --filter config-web build:lobby     # vite build --config lobby/vite.config.ts -> public/lobby/
```

Run it on the host after pulling, then the running server serves it as static files (no restart needed):
`/lobby/` is Start Game, `/lobby/#<lobbyId>` is a Lobby. Without a build, `/lobby/` answers 404.

Identity is a Discord-authenticated session (`cw_session` cookie; sessions record their provenance and the lobby
refuses password sessions). The Lobby is a view over the matchmaker: creating a lobby enters the creator's
challenge, joining enters the opponent's counter-challenge, and the matchmaker pairs (atomically, re-checking
both teams and bans) and schedules on the fork as it does for the client's Create Game. Lobby challenges carry
no credential; if the creator's challenge lapses or is cancelled, the lobby waits for the creator to confirm
again (`renew`), it never re-enters consent on its own.

API (Discord session required; cookie writes need `X-CW-Auth: 1`; writes take the game-start lock only after
the session check and a bounded 16 KB / 10 s body read):

| Route | Purpose |
|---|---|
| `GET /api/lobby` | my lobbies + challenges addressed to me |
| `POST /api/lobby {teamId, opponent}` | challenge = create (or join, if the opponent already opened one) |
| `GET /api/lobby/:id` | lobby state (also the presence heartbeat); 410 when expired |
| `POST /api/lobby/:id/join {teamId}` | counter-challenge |
| `POST /api/lobby/:id/renew {teamId?}` | creator confirms again after a lapse / cancel |
| `POST /api/lobby/:id/launch` | `{jnlpUrl: "/api/lobby/:id/jnlp", scheme: null}`; marks me "in the client" |
| `GET /api/lobby/:id/jnlp` | my seat's JNLP with my stored credential (session-scoped, same cache gate + game-start lock as the writes; 503 on a host without the fork account store, never a placeholder password) |
| `POST /api/lobby/:id/close` | creator withdraws an unpaired lobby |
| `GET /api/lobby/:id/roster?role=creator\|opponent` | roster fields only |
| `GET /api/lobby/:id/coach?role=…` | avatar + linked FUMBBL name |
| `GET /api/coach-rating?name=` | FUMBBL rating (3 requests, cached 10 min, per-coach / global / concurrency limits) |

Scheduling on the fork: after the request is sent, only a parsed success is a game and only the fork's own
readable `<error>` is a refusal (named-game fallback, as before). Anything else (proxy error, truncated body,
timeout, network fault) leaves the pairing UNCERTAIN: both challenges stay held, nothing is scheduled again
automatically and no timers run. The lobby shows "Game setup did not confirm" with **Check again**
(`POST /api/lobby/:id/check`, under the game-start lock: looks for a live game whose two seats are exactly these
coaches with these teams, in both coaches' live-game lists; extra matches are reported as duplicates) and
**Start over** (`POST /api/lobby/:id/start-over`: withdraws both challenges; a game may already exist, see Your
games). A client seat that takes its JNLP through an authorized match poll shows as "in the client".

While a pairing is in flight or uncertain, accept / confirm requests for its coaches answer 409 with the lobby
state; Check again has a 5 s per-lobby cooldown; a lobby with an uncertain setup is not swept at 24 h.
`GET /api/fork/cancel` needs the coach's own session (any provenance, as for matchstatus) or the digest the
challenge was entered with.

Discord signup keeps one durable provisional record (in the identities store: Discord id, coach name, generated
credential digest, operation id) written before the fork insert; the next Discord sign-in resumes from it and
accepts the account only if the fork row carries exactly that digest. A provisional record older than 24 h with no insert
in flight is purged on the next identities write or sign-in; any fork account that attempt may have created is
left on the fork (an organiser can remove it). A client challenge for a coach held by an in-flight / uncertain
pairing gets 409 with `lobbyId` and `lobbyUrl` (absolute from `PUBLIC_BASE_URL`, else relative `/lobby/#<id>`).

`/api/fork/matchstatus` returns a JNLP only to an authorized poll (the coach's own session, or the digest that
coach supplied with a client challenge), built from that digest; any other poll gets status only and never
consumes the delivery. Lobby seats are never delivered there. `/api/auth/session` reports `authMethod`.

Chat and presence ride the Super WebSocket (`/super`, needs `SUPER_ENABLED=1` plus the fork DB/admin config):
`{type:"hello", lobbyId}` authenticates with the upgrade request's Discord session, checks the browser Origin,
and the socket closes when that session ends. Features: `lobby-chat` (publish, rate-limited per coach) and
`lobby-presence` (server push); at most 3 sockets per coach per lobby. Without Super the page still works and
shows chat history from the state poll.

Environment:

| Variable | Default | Use |
|---|---|---|
| `FUMBBL_BASE_URL` | `https://fumbbl.com` | origin for the coach-rating requests |
| `PUBLIC_BASE_URL` | (none: relative links) | public http(s) origin (no credentials, no path; validated at startup, an invalid value is ignored) used for absolute lobby links in the held-consent 409; never derived from the request's Host header |
| `SUPER_WS_ALLOWED_ORIGINS` | (none) | comma list of browser origins allowed on lobby sockets; the origin of `DISCORD_OAUTH_REDIRECT_URI` is always allowed; with neither set, same host only. **REQUIRED** on any host whose public browser origin differs from the Discord redirect origin (e.g. page at `https://<host>`, redirect URI `http://<host>:4310`): list every origin coaches open the page from, or lobby chat is refused |

## New-user flow (welcome modal, contact & consent)

After a Discord sign-in the SPA reads `GET /api/me/onboarding`; while `needed` (the privacy notice was never accepted,
or an older version was) a blocking "Welcome to Super FUMBBL" modal covers every route until `POST /api/me/onboarding`
saves the preferred name, email, phones, league-contact consent (opt-in) and the privacy acceptance (required). Until
then every state-changing `/api` request by that coach (lobby and tabletop included) answers **428** "Complete your
profile first.", except the onboarding POST, `/api/me/delete`, the `/api/auth/*` sign-in/out flows and read-only name
checks; reads and anonymous calls are untouched. The Account page edits the same fields later with
`GET/PATCH /api/me/contact`.

- Field schema and defaults for existing records: `src/auth/contactSchema.ts`. `PRIVACY_VERSION` is the notice's single
  constant in `spa/src/privacy/version.ts` (bump it to ask everyone again). Routes and gate: `src/auth/onboarding.ts`.
- A Discord re-sign-in refreshes the contact email only while it is Discord-sourced; a coach-edited email or preferred
  name is never overwritten.
- League notice (owner 10-31): each league a coach is on (team or participant on their fork account) shows a one-time,
  non-blocking notice ("By joining <League>, its organisers can see your name and profile, and can send you league
  messages through Super FUMBBL (your email address is never shown to them).") with a required checkbox;
  `GET/POST /api/me/leagues/sharing` stores `consent.leagues[<id>] = { at, version }` or a decline
  (`consent.leaguesDeclined`); the Account page lists the leagues with Stop sharing / Share. There is no self-service
  league join yet (coaches arrive by import or Assign coach account); a future join must ask the same notice.
- Organisers never receive email addresses or phone numbers (`src/auth/contactFor.ts`). `POST /api/admin/identities/naf`
  by a non-admin organiser is allowed only for a coach on a league they own or organise (403 otherwise; tournaments do
  not count); an acknowledged member answers `organiserMemberView` (name, preferred name, public profile, NAF fields,
  `acceptsLeagueMessages`), anyone else on their league the public allow-list (coach name, NAF fields). Site admins
  are unchanged. The admin identities list, edit and merge stay site-admin only.
- `mailerRecipientFor(coach, leagueOrTournamentId)` (exported from `server.ts`) is MAILER-ONLY: the address the coming
  league mailer sends to (through the email delivery provider, Postmark), only with the league-contact opt-in AND
  membership (an acknowledged league, or a tournament entry). Its result never goes into an HTTP response; a test
  crawls every literal `/api` GET route to check no route returns another coach's email or phones.

## Tabletop recorder: team files

`POST /api/tabletop/matches` takes `home.team` / `away.team` as `library:<teamId>` (a fork library team, read from its
stored team XML) or `save:<saveId>` (a Team Builder save; a bare id still means a save). Revisions for both kinds live
in the tabletop store (`TABLETOP_DIR`), keyed by the ref; library teams are NOT written back to the fork's team XML in
this lane. Write-back to the fork library is a later lane (upstream-parity and fork-restart constraints apply).

### Licensed turn-timer cues (host-only, never in git)

The tabletop recorder plays the Super FUMBBL client's turn-timer sounds (Retro SFX by Andrea Baroni / Cyberleaf Studio): the
minute sound once at 1:00, then once on each remaining second 10..1 (the minute sound as the warning tone on 10..6, the
countdown sound on 5..1). The licence allows use but forbids redistribution, so the files are **never committed**: they live
only on the host under the gitignored `apps/config-web/public/sounds/ui/` with a `manifest.json`
(`{"files": {"minute": "/sounds/ui/turn-clock-minute.wav", "countdown": "/sounds/ui/turn-clock-countdown.wav"}}`). Deploy step:
copy the client's `turnClockMinute.wav` and `turnClockCountdown.wav` byte-for-byte, saved under the lower-case names `turn-clock-minute.wav` / `turn-clock-countdown.wav` (the public matcher accepts lower-case names only), from the client checkout
(`apps/tauri/src/assets/sounds/`, `git show origin/order-66:<path> > <dest>`) and write the manifest. Without the manifest
the recorder falls back to generated tones on the same cadence. Credit: the recorder's Settings sheet.

## Admin Testing Suite

The control panel (`/control-panel.html`) shows a "Testing suite" card to organisers and admins (the card stays hidden for
everyone else; every `/api/admin/testing/*` route answers 403 to a non-organiser session). First tool: **Tabletop test
match**, which loads a recorder match from two chosen teams (library or builder saves) without the normal flow.

- `GET /api/admin/testing/tools`: the suite's tools.
- `GET /api/admin/testing/tabletop-defaults`: the default pair, or `{defaults: null}`. Configure it with
  `TABLETOP_TEST_HOME="coach|library:<id>"` and `TABLETOP_TEST_AWAY="coach|save:<id>"` (either ref kind). Nothing is hard-coded.
- `GET /api/admin/testing/teams?coach=`: a coach's library teams and saves (the pickers).
- `POST /api/admin/testing/tabletop-match` `{home, away, pregame: "skip"|"full", postMatch, turnTimer?: {mode: "on", seconds}}`
  returns `{matchId, url: "/app/tabletop/<id>"}`. Same validation and store as the normal create route; the match is flagged
  `test: true`, and its results row is flagged too, so standings, Elo and counted results never include it, even if published.
- `DELETE /api/admin/testing/tabletop-matches`: purge every test match (events, journals, test result rows). Team revisions a
  test match wrote stay; use `postMatch: "none"` to avoid them.

## Test sign-in (local UAT only)

`POST /api/auth/test-login` mints a real session (method `discord`, marked `test: true` in `GET /api/auth/session`) without Discord, so the Lobby and Tabletop can be exercised locally. It does not exist (404) unless both env vars are set:

```
TEST_LOGIN_SECRET=<at least 16 random characters>
TEST_LOGIN_COACHES=Alice:organizer,Bob,Carol:admin
```

`TEST_LOGIN_COACHES` is a comma list of `name[:level]` (`player` default, `organizer`, `admin`); only listed coaches may sign in. A declared level is raised through the identities store, never lowered.

```
curl -i -X POST http://127.0.0.1:PORT/api/auth/test-login -H "X-CW-Auth: 1" -H "X-Test-Login: $TEST_LOGIN_SECRET" -H "content-type: application/json" -d '{"coach":"Alice"}'
```

Loopback callers only (any `X-Forwarded-For` is refused), timing-safe secret check, 3 wrong secrets per 10 minutes per IP gives 429. Never set these variables on a public host.

## League fixture on the local fork: end-to-end rig

`scripts/league-fork-test.ts` plays one league fixture on the local Super FUMBBL fork against the live config-web state dir,
then tears everything down. The report is in `docs/artifact-orchestration/league-fork-test-2026-10-30.md`.

```
cd apps/config-web
pnpm exec tsx scripts/league-fork-test.ts                 # setup -> generate -> launch -> play -> Check for result (in process) -> verify -> teardown
pnpm exec tsx scripts/league-fork-test.ts --live-sync     # wait for the live server's 2-minute sync instead (its result notices reach the two test coaches' live inboxes; swept at teardown)
pnpm exec tsx scripts/league-fork-test.ts --mark-test-games 1094,1095  # list earlier fork games as test games and store their results test:true
pnpm exec tsx scripts/league-fork-test.ts --keep          # leave the test league for inspection
pnpm exec tsx scripts/league-fork-test.ts --teardown-only # remove it
```

- Creates the throwaway league `tabbl-test` ("TABBL Test", no Discord webhook). It holds one season with copies of two TABBL
  season-6 teams (`--home` / `--away` team ids), with Flutethecat and Gondra87 seated, and one fixture marked `test: true`.
  Real TABBL data, `identities.json` and `organizers.json` are only read.
- Uses the real fork client with the live `.env` (`--env`). No secret is printed or written; the JNLPs are saved redacted.
- Both seats play headless on the scheduled game id. This is a scenario build of the client worktree's
  `packages/ffb-protocol/scripts/drivePregame.ts` (`--client`, default `wt-declare`): one forced block casualty and one
  touchdown via the fork's test talk commands, then the away side concedes.
- Writes `checks.json`, `diff.json` (before/after for both league teams and the fixture), the fork team files, the raw and
  parsed fork result, and the logs to `--out` (default `.league-fork-test/<stamp>`, git-ignored). The exit code is non-zero
  on any failed check.
- Every scheduled game id goes into `data-store/test-games.json` (src/testGames.ts) the moment it is scheduled, and its
  finished result is stored `test: true`. The results store stamps `test` on every read and write for a listed id, so
  `/api/fork/records` (refreshFinishedResults), Elo, Glicko, records and recent results never count a test game,
  whoever imports it and whenever. The list is never pruned.
- The rig's own notifications go to an isolated store under `<out>/isolated/`, never to the live inboxes. Check 2c
  asserts that no live row was written.
- Banking is asserted exactly against the parsed FumbblResult: per-player SPP (and the BB2025 table: TD 3, CAS 2, MVP 4),
  the counters, injuries and MNG on the stored record, treasury = before − inducement spend + winnings, and fans =
  before + dedicatedFansModifier. The per-player lines are in `assertions.txt`.
- Teardown runs at the start and end of every run. It deletes the league folder, its `lg_*` fork team files (followed by
  a fork refresh), the library rows, and any live notification rows linking to `/app/leagues/tabbl-test`.
  Finished fork games stay in the fork DB and stay listed as test games.
