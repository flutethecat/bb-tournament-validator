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
| `/app/tournaments` | placeholder linking to `/tournaments.html` |
| `/app/team-builder` | placeholder linking to `/team-builder.html` |
| `/app/tournament-team-builder` | placeholder linking to `/tournament-team-builder.html` |
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
