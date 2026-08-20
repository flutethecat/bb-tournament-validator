# Config-web Admin Tools — build spec (for Codex dispatch)

**Status:** READY for Codex dispatch. Orchestrated by Veers; built by Codex (Sol 5.6). All route
facts below verified against current `server.ts` / auth modules.

## Auth-mode reality (must-read before touching gates)
config-web runs in one of two modes; the live host runs **sidecar ON** (startup log: "auth: session
sidecar enabled", `AUTH_SIDECAR_ALLOW_INSECURE_PUBLIC=1`):
- **Sidecar ON:** `requireSession()` gates. `requireAdminGate` (server.ts:470–483) returns true for
  **ANY authenticated session**. Organizer-writes are additionally gated centrally at
  server.ts:1473–1477 (needs `auth.organizer`). Net: existing user/game write routes ≈ **organizer**;
  `GET /api/fork/users` ≈ **any session**.
- **Sidecar OFF:** Basic `ADMIN_PASSWORD` (`isAdminAuthed`, 490–496) or admin bearer token
  (`isTokenAuthed`, 508–519).
Consequence: "any logged-in coach" is NOT admin under sidecar. The new user-management powers (set
level, ban, silence, edit identities) are true-admin operations, so they need a NEW gate:
`requireAdminLevel(req, res, auth) = auth?.admin === true || isAdminAuthed(req) || isTokenAuthed(req)`
— works in BOTH modes. Use it for all NEW admin routes. Leave the existing game/user routes on their
current `requireAdminGate` unless explicitly retightened.

## Context / why
The old "Bot Panel" (`tournaments.html`, `users.html`) uses the legacy `theme.css` look and is being
retired. The new standard is the **Tournament Rules Construction** design (`tournament-rules.{html,css,js}`).
The owner wants fork admin tooling brought into that design language, plus new capabilities:

1. **User controls** — Ban, Silence, and a per-account **Permission level** (Player / Organizer / Admin).
2. **Game controls** — the existing close/delete/concede/schedule tools, reworked into the new design.
3. **Fork account = primary identity.** The Super FUMBBL fork account (`ffb_coaches.name`) is the
   canonical userID; other identities (Discord, NAF, tournament) attach to it as a **library**.
4. Deprecate `tournaments.html`.

## Owner decisions (locked 2026-08-19)
- **Ban/Silence = config-web soft-enforce** (no fork-server change — upstream-parity holds). Two teeth
  for Ban: (a) a banned coach's JNLP issuance / fork login is **refused with a clear error message**;
  (b) **game creation/scheduling is blocked server-side** when either playerid is a banned coach.
  **Silence is a stored + displayed flag only** — fork chat is server-side with no admin op, so there is
  NO true chat suppression. This limit must be shown in the UI, not implied away.
- **Storage = a new JSON store `identities.json`** (config-web-owned, sibling of `organizers.json`),
  keyed by fork account name. Holds the identity library + permission level + ban/silence flags.
- **Permissions = Player / Organizer / Admin, with per-account Admin.** A coach flagged `admin` in the
  store authenticates as admin via their **own login** (not only the shared `ADMIN_PASSWORD`).

## Data model — `identities.json`
Location: resolved like `organizers.json` (see `apps/config-web/src/auth/organizers.ts` — env override
`IDENTITIES_FILE`, else a default path next to the app). One record per fork account, keyed by the
normalized (trim+lowercase) fork name, but storing the canonical-cased name.

```jsonc
{
  "version": 1,
  "coaches": {
    "gondra87": {
      "forkName": "GONDRA87",          // canonical case; the PRIMARY id
      "level": "player",                // "player" | "organizer" | "admin"
      "banned": false,
      "silenced": false,
      "note": "",                       // optional admin note (reason for ban etc.)
      "identities": {                    // the attached-identity LIBRARY (all optional)
        "discordUserId": "",
        "discordUsername": "",
        "nafName": "",
        "nafId": "",
        "tournamentCoachId": ""         // link into discord-bot coach registry if distinct
      },
      "updatedAt": "2026-08-19T00:00:00Z",
      "updatedBy": "someAdminCoach"
    }
  }
}
```

Notes:
- The store is **additive** over the existing derived link (users route already left-joins
  `ffb_coaches` ↔ discord-bot `coaches.json` by fumbblName). `identities.json` is the *editable,
  authoritative* overlay; the derived link remains the auto-suggested default when no override exists.
- Reads tolerate a missing/corrupt file → empty store (never throw), mirroring `readOrganizers()`.
- Writes are atomic (temp file + rename) and bounded; never partial-write the live file.

## Permission model
New module `apps/config-web/src/auth/access.ts` (sits beside `organizers.ts`):
- `readIdentities(): IdentityStore` — cached read of `identities.json` (same tolerance as `readOrganizers`).
- `coachLevel(coach): "player" | "organizer" | "admin"` — from the store; default `player`.
  **Legacy bridge:** a name present in `organizers.json` but absent/`player` in the store resolves to at
  least `organizer` (so existing organizers keep working during migration).
- `isBanned(coach): boolean`, `isSilenced(coach): boolean`.
- Keep `isOrganizer(coach)` working: `coachLevel(coach) !== "player"` OR legacy `organizers.json`.

### Session elevation (the per-account Admin path)
`SessionIdentity` is assembled at **TWO** points that already compute `organizer` from a JSON store —
BOTH must gain `admin`:
1. `apps/config-web/src/auth/requireSession.ts:61` (sidecar path):
   `const identity = session ? { coach: session.coach, organizer: isOrganizer(session.coach) } : undefined;`
2. `apps/config-web/src/server.ts:503–506` `bearerIdentity(req)` (sidecar-off bearer path) — mirror it.

Change:
- Extend `SessionIdentity` (`requireSession.ts:5`) to `{ coach, organizer, admin }`.
- At both points derive from `access.ts`:
  `organizer: coachLevel(coach) !== "player" || isOrganizer(coach)`, `admin: coachLevel(coach) === "admin"`.
- Add the `requireAdminLevel` gate (see Auth-mode section) for NEW admin routes; it honours `auth.admin`.
- Banned coach is NEVER elevated — a banned admin/organizer loses powers while banned (guard in `access.ts`
  resolvers so a banned coach resolves to `player` + not-admin).

## Ban enforcement points (server-side) — exact routes
Refuse with a clear user-facing message: `"This account is banned from Super FUMBBL. Contact an organizer."`
1. **Login (primary choke point)** — a banned coach must not get a session:
   - `POST /api/fork/login` → `coachLogin.ts:60–137`, after the digest verify, before `createSession` (line 126).
   - `POST /api/auth/login` → `portal.ts:145–200`, after `verifyCoachPassword`, before `createSession` (line 196).
   Return 403 with the ban message.
2. **Self-service matchmaking (public, no session)** — these bypass login, so guard directly:
   - `GET /api/fork/challenge` (server.ts:879–900) — block if `isBanned(coach)` OR `isBanned(opponent)`
     (query params `coach` line 880, `opponent` line 882) BEFORE `matchmaker.challenge` (line 896);
     403 naming which side.
   - `GET /api/fork/jnlp` (server.ts:680–708) — block if `isBanned(coach)` (query `coach` line 681)
     BEFORE `buildForkJnlp` (line 701).
   - `GET /api/fork/matchstatus` (903–906) is covered transitively (its JNLP comes from a challenge that
     the gate above already refused) — no separate gate needed, but note it.
3. **TO scheduling (`POST /api/fork/schedule`, server.ts:938–949)** — pairs by **teamId**, not coach.
   Best-effort: resolve each of `homeTeamId`/`awayTeamId` to its owner coach via the existing fork team
   lookup (`@bb/fork-ops` library/teams helpers) and reject if either owner `isBanned`. If a teamId can't
   be cheaply resolved to a coach, do NOT block (log it) — and say so in the spec/PR, don't fake coverage.
4. **Silence** — store + surface only. Do NOT claim enforcement anywhere (no fork admin op for chat).

## Frontend — new Admin Console (matches the tournament-rules design)
New page set served by config-web:
- `public/admin.html` — same shell as `tournament-rules.html`: `.page-shell` > `.brand-header`
  (reuse `assets/`), a `.toolbar` (login + section switch), `.main-grid`, `.footer`. **Reuse
  `tournament-rules.css`** (shared design tokens/classes — `.panel`, `.section-head/.section-title`,
  `.btn/.btn.primary`, `.control`, `.chip`, `.summary-card`, `.notice`, `.validation`). Add only a small
  `admin.css` for table/toggle specifics not already in the shared sheet.
- `public/admin.js` — mirror `tournament-rules.js` architecture exactly:
  - a `state` object + `render()` that rewrites panels via innerHTML template strings;
  - delegated `data-action` click/change handlers per container (see `tournament-rules.js:1056–1111`);
  - `requestJson(path, options)` helper; login via `POST /api/auth/login` with header `X-CW-Auth: 1`
    + `{ username, password }`, token held in `state.token`, authed calls send
    `Authorization: Bearer ${state.token}` (see `tournament-rules.js:920–1005`).
- **Auth posture:** admin.html itself is session-gated (NOT in the public allowlist); every mutating
  admin API is `isAdminAuthed`-gated. Reads that populate the tables are session+admin gated.

### Panel 1 — Users (fork-primary identity library)
- Master table keyed by fork account (primary id). Columns: Fork account · Level · Status
  (live-game / idle, reuse the existing users route rows) · Attached identities (Discord/NAF/tournament
  chips) · flags (Banned/Silenced) · Actions.
- Per row: edit permission **Level** (Player/Organizer/Admin select), **Ban**/**Unban** toggle,
  **Silence**/**Unsilence** toggle (with the "display-only, no chat suppression" caveat shown inline),
  edit **attached identities** (a small identity-library editor: discord id/username, NAF name/id,
  tournament link), plus the existing **Reset fork password** / **Clear games** actions restyled.
- Silence toggle carries a visible `.notice` explaining it is a flag only.

### Panel 2 — Game controls
- Live games list (reuse `adminListLive` / the existing `/api/fork/game/*` ops) restyled into `.panel`
  rows with `.btn` actions: Close / Delete / Concede home|away. Add the existing **schedule** and
  **broadcast message** (`adminMessage`) and **refresh** (`adminRefresh`) admin ops as first-class
  controls. Matchmaking settings (home/away, overtime) move here from `users.html`, restyled.

### Deprecate `tournaments.html`
- Static files are served from `public/` by `serveStatic` (server.ts:528–543). `tournaments.html` and
  `users.html` are NOT in any public allowlist, so they're already session/admin-gated — no server change
  needed. Deprecation gesture: replace `tournaments.html`'s body with a minimal meta-refresh + link
  redirect to `/admin.html` (same pattern as `index.html`), keeping the file so old bookmarks land.
  `users.html` is superseded by the Admin Console → Users panel; give it the same redirect to `/admin.html`.

## Verified route/line anchors (server.ts unless noted) — for the Codex build
- `/api/fork/users` handler 1279–1347; reads `readCoachRegistry(COACH_REGISTRY_JSON)` (COACH_REGISTRY_JSON
  resolved 164–166, default `../../discord-bot/data-store/coaches.json`); links by fumbblName (index
  1288–1290; match 1312–1315); linked shape 1318–1326 = `{ id, discordUserId, nafName, nafId, teamCount }`.
- Registry types: `CoachRegistryEntry` in `src/data.ts:159–167`; `readCoachRegistry` 169–176. Bot-side
  canonical type `CoachEntry` in `apps/discord-bot/src/store/coachRegistry.ts:25–33`
  (`{ id, discordUserId?, fumbblName?, nafName?, nafId?, teams[], updatedAt }`).
- Gates: `isAdminAuthed` 490–496; `isTokenAuthed` 508–519; `requireAdminGate` 470–483; `isOrganizerWrite`
  547–561; central organizer-write check 1473–1477. Existing admin routes: users 1280, reset-password 1368,
  clear-games 1386, user/:name/games 1352 (regex 1350), game/:id/:op 953 (regex 951), matchmaking-settings
  987/991.
- Static: `serveStatic` 528–543, `PUBLIC_DIR` 148, static GET allowlist inside `authorized()` 441–450 and
  `requireSession.isPublicRequest` 43–57. `PUBLIC_PATHS` 104–145.
- `organizers.ts`: read-only, `DEFAULT_ORGANIZERS_FILE` line 5, `ORGANIZERS_FILE` override 11–13, shape
  `{ organizers: string[] }`. Mirror this exactly for `identities.json` + `IDENTITIES_FILE`.

## Constraints for the Codex build
- **config-web is the ONLY app in scope.** Do NOT touch the fork server, the Tauri client, `dist-manifest`,
  version stamps, or release-train files. Upstream-parity + server-derived laws apply.
- Reuse existing helpers — `@bb/fork-ops` (`adminListLive`, `adminClose/Delete/Concede`, `adminMessage`,
  `adminRefresh`, `scheduleForkGame`, `listForkCoaches`, `verifyCoachDigest`), `organizers.ts` pattern for
  the new store, the `requestJson`/`data-action` frontend idiom. Do NOT introduce a framework or new deps.
- New tests: a `access.test.ts` (level/ban/silence resolution + legacy organizers bridge) and a
  `identitiesStore.test.ts` (tolerant read, atomic write, bounded) in `apps/config-web/test/`, matching the
  existing vitest style (`customGate.test.ts`, `bugReports.test.ts`).
- Definition of done: `pnpm --filter config-web build` (tsc) clean; `npx vitest run apps/config-web` green;
  new admin.html loads against a running :4310 with the panels rendering and the login/token flow working.

## Verification (end-to-end)
- tsc + vitest as above.
- Restart config-web via its scheduled task ("FUMBBL40k config-web") and load `http://localhost:4310/admin.html`.
- Log in; confirm: a coach set to `admin` in `identities.json` is elevated (can hit an admin route via own
  login); setting `banned:true` blocks that coach's fork login/JNLP and blocks scheduling a game with them;
  the Silence toggle shows its display-only caveat; game controls close/concede a live game.
