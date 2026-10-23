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

Identity is the Discord session (`cw_session` cookie). The Lobby is a view over the matchmaker:
creating a lobby enters the creator's challenge, joining enters the opponent's counter-challenge, and the
matchmaker pairs + schedules on the fork as it does for the client's Create Game.

API (session-gated, cookie writes need `X-CW-Auth: 1`):

| Route | Purpose |
|---|---|
| `GET /api/lobby` | my lobbies + challenges addressed to me |
| `POST /api/lobby {teamId, opponent}` | challenge = create (or join, if the opponent already opened one) |
| `GET /api/lobby/:id` | lobby state (also the presence heartbeat); 410 when expired |
| `POST /api/lobby/:id/join {teamId}` | counter-challenge; pairs and schedules |
| `POST /api/lobby/:id/launch` | `{jnlpUrl, scheme: null}` for my seat |
| `POST /api/lobby/:id/close` | creator withdraws an unpaired lobby |
| `GET /api/lobby/:id/roster?role=creator\|opponent` | roster fields only |
| `GET /api/lobby/:id/coach?role=…` | avatar + linked FUMBBL name |
| `GET /api/coach-rating?name=` | FUMBBL rating (3 fumbbl.com requests, cached 10 min) |

Chat and presence ride the Super WebSocket (`/super`, needs `SUPER_ENABLED=1` plus the fork DB/admin config):
`{type:"hello", lobbyId}` authenticates with the upgrade request's session; features `lobby-chat` (publish)
and `lobby-presence` (server push). Without Super, the page still works and shows chat history from the
state poll, with live chat off.
