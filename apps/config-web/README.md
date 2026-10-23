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
| `GET /api/lobby/:id/jnlp` | my seat's JNLP (stored credential added server-side; session-scoped) |
| `POST /api/lobby/:id/close` | creator withdraws an unpaired lobby |
| `GET /api/lobby/:id/roster?role=creator\|opponent` | roster fields only |
| `GET /api/lobby/:id/coach?role=…` | avatar + linked FUMBBL name |
| `GET /api/coach-rating?name=` | FUMBBL rating (3 requests, cached 10 min, per-coach / global / concurrency limits) |

Chat and presence ride the Super WebSocket (`/super`, needs `SUPER_ENABLED=1` plus the fork DB/admin config):
`{type:"hello", lobbyId}` authenticates with the upgrade request's Discord session, checks the browser Origin,
and the socket closes when that session ends. Features: `lobby-chat` (publish, rate-limited per coach) and
`lobby-presence` (server push); at most 3 sockets per coach per lobby. Without Super the page still works and
shows chat history from the state poll.

Environment:

| Variable | Default | Use |
|---|---|---|
| `FUMBBL_BASE_URL` | `https://fumbbl.com` | origin for the coach-rating requests |
| `SUPER_WS_ALLOWED_ORIGINS` | (none) | comma list of browser origins allowed on lobby sockets; the origin of `DISCORD_OAUTH_REDIRECT_URI` is always allowed; with neither set, same host only |
