# config-web

Plain Node `http` server (`src/server.ts`, run with `tsx`) serving `public/` and the JSON API on :4310.

## Start Game / Lobby page (`/lobby/`)

Source: `lobby/` (vanilla TypeScript + Vite, styled with the site theme `/theme.css` + `/theme.js`, which stay
unbundled). Build output goes to `public/lobby/` and is **not committed** (gitignored).

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
