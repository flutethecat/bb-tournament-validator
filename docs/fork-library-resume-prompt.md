# RESUME PROMPT — Fork Team Library + Create-Game Matchmaking

Copy/paste the block below as your first message in a fresh session to pick up this task.

---

```
Resume work on the BB Tournament Validator project at `C:\Users\Jay\Documents\Claude\bb-tournament-validator\`.

First, read `docs\RESUME.md` (canonical handoff) and confirm a known-good state:
  cd C:\Users\Jay\Documents\Claude\bb-tournament-validator
  pnpm install && pnpm test
Expect 166 tests green, all packages typecheck+build, clean git tree at HEAD e71c526 (or later — check
`git log` for anything past this prompt's writing). Published private GitHub `flutethecat/bb-tournament-validator`.

⚠ CHECK FIRST: `apps\discord-bot\data-store\announce-hold.json` — build/daily-summary Discord
announcements were HELD by owner request on 2026-07-08 pending go-ahead. Don't assume it's still held —
read the file and/or ask the owner. This is UNRELATED to the task below (that hold only affects the
Discord build-announcer pipeline), but don't accidentally lift it or post while doing this work.

## The task

Build the **fork team library + in-client Create-Game matchmaking** system, per the spec the FUMBBL40k
client session wrote and committed: `C:\Users\Jay\Documents\Claude\fumbbl40k-client\docs\fork-team-browser-spec.md`
(commit `c6ee70e`). READ THAT FILE IN FULL FIRST — this prompt summarizes it, but the spec is the source
of truth for exact param names/response shapes.

**The client side is already fully built and E2E-validated** (fumbbl40k-client `3c0efea`, cases 428–429):
Create-Game modal (opponent autocomplete, team-library browser card list, Ingest Team button,
challenge→waiting→poll-matchstatus→open-JNLP flow) and the password-carrying register modal. They ran
the whole flow against a local stub and it worked end-to-end (paired fork game vs a bot opponent, reached
a live turn). This means: **you only need to build the server side** — no client work, no back-and-forth
needed on the shape, just match the spec exactly and it will light up with zero client changes. The 40k
session will ping if any route/param needs adjusting on their end.

**Gist:** 6 new/updated GET routes on `apps/config-web/src/server.ts` (same pattern as the two already-
shipped routes, `/api/fork/jnlp` and `/api/fork/register` — GET+query params, ACAO:* via the `PUBLIC_PATHS`
allow-list, errors as non-2xx `{error}`):

1. **`/api/fork/register?coach&password`** — UPDATE the existing route. Client case 428 now sends a
   user-chosen password instead of the fixed `12345`. Update `createForkAccount` (in `@bb/fork-ops`,
   `packages/bb-fork-ops/src/index.ts`) to accept + md5 the given password instead of hardcoding
   `MD5_12345`. Keep the idempotent upsert behavior.
   ⚠ **Confirmed broken today (2026-07-08):** the route currently reads+ignores any `password` query
   param — `createForkAccount` still always writes `MD5_12345` regardless. The 40k session tested the
   register modal against the live endpoint and got `{ok}` (coach-row creation genuinely works), but the
   chosen password ("regtest99" for their test row `ClientRegTest`) was silently discarded — the real DB
   password is still "12345". Fix this first; it's the smallest of the 6 items and unblocks their
   already-passing UI test for real.
2. **`/api/fork/library?coach`** → `{teams: LibraryTeam[]}` — list a coach's ingested teams.
3. **`/api/fork/library/ingest?coach&team`** → ingest a FUMBBL team (id or URL) into the coach's library.
   Reuses `fetchForkTeam` + `copyForkTeam` (already in `@bb/fork-ops`) + parses `currentTeamValue`/
   `treasury` from the team XML. Returns `{ok,team:LibraryTeam,raceWarning?,needsRestart?}`.
4. **`/api/fork/coaches?q&limit`** → `{coaches:[name]}` — opponent-name autocomplete against
   `ffb_coaches.name` (the fork DB, already reachable via `forkDbConfigFromEnv`).
5. **`/api/fork/challenge?coach&teamId&opponent&password`** — enter matchmaking; instant match if the
   opponent has a reciprocal pending challenge. In-memory map, ~10min TTL is fine for v1.
6. **`/api/fork/matchstatus?coach`** — poll (client polls ~2s); returns `{status:"waiting"}` or
   `{status:"matched",gameName,opponent,jnlp}` (jnlp built via the already-shared `buildForkJnlp`).
7. **`/api/fork/cancel?coach`** → drops the pending challenge.

**LibraryTeam shape**, storage choice, and the full matchmaking protocol (shared gameName construction,
who builds which side's JNLP, when to drop the challenge) are all spelled out precisely in the spec file
— don't guess, read it.

## Two design questions the spec explicitly leaves to you (owner has NOT weighed in — use judgment,
## note your choice in RESUME.md + memory so it's a recorded decision, not a silent default)

1. **Does an ingested team persist on the fork permanently, or is it an ephemeral test copy?** (Spec
   calls this a "parking lot," not required for v1.) Recommendation if no stronger signal: persist it
   (write the XML to `teams/` same as `copyForkTeam` already does, keep the library row) — an ephemeral
   team that vanishes on a fork rebuild would be a confusing dead-end for a coach who just ingested it to
   play with. Low-stakes on a test fork either way; document whichever you pick.
2. **`needsRestart:true` vs hot-reloading the FFB team cache** when a newly-ingested team's XML lands.
   Recommendation: ship `needsRestart:true` for v1 (matches the existing, already-documented constraint
   that `copyteam`/`/bbbot 40k copyteam` has — "restart the FFB server to load new team files"; don't
   build Java-side hot-reload as part of this task, it's out of scope and not this repo's code to own
   unprompted). Flag hot-reload as a future ask back to the 40k/fumbbl40k-server side if it becomes a
   real pain point.

## Housekeeping once built

- Add tests (pure logic: challenge/match state machine, LibraryTeam parsing — mirror the existing
  `packages/bb-fork-ops/test/forkOps.test.ts` style). Run `pnpm test`, expect all green (166 + new).
- Typecheck `packages/bb-fork-ops`, `apps/config-web`, `apps/discord-bot` if touched.
- Verify live via your own preview server (`preview_start` "config-web" — do NOT assume another
  session's dev server on 4310 is reachable by your tools; start your own) — hit each route with
  `preview_eval`/`fetch`, check status/ACAO/body, clean up any test DB rows/library entries you create.
- Commit + push (private GitHub, direct push is the established norm for this repo this session — no PR).
- Update `docs/RESUME.md`, `docs/40k-fork-guide.md` (or a new doc if the library/matchmaking surface
  grows enough to deserve its own page — your call), and the `bb-tournament-validator-project` memory file.
- Update your subsection in the SHARED `fumbbl40k-client\docs\daily-summary.md` (Tournament Bot track,
  top day) as you ship — established convention this session; commit + push directly to that repo too.
- Reply to the FUMBBL40k Convo session (cross-session message) confirming what shipped, matching their
  exact contract, and flagging your two design-question choices.

## Context you should know before starting

- `@bb/fork-ops` (`packages/bb-fork-ops/`) already holds `buildForkJnlp`/`jnlpFilename`/
  `createForkAccount`/`forkConfigFromEnv`/`forkDbConfigFromEnv`/`ForkConfig`/`ForkDbConfig` — this is
  where the new library/matchmaking pure logic likely belongs too (shared with the bot if `/bbbot 40k`
  ever wants library/matchmaking commands — not required now, but keep the door open).
- `apps/discord-bot/src/fork40k.ts` already has `fetchForkTeam`, `copyForkTeam`, `parseTeamId`,
  `forkRosterNames`, `forkSupportsRace` — reuse these directly for the ingest route (they're
  Node-specific — file I/O — so they stay in the bot's `fork40k.ts`, not the pure `@bb/fork-ops`
  package; config-web will need its own copy or a lift, your call — same "is this genuinely shared" test
  applied earlier this session for `buildForkJnlp`/`createForkAccount`).
- Config-web's `.env` already has `FORK_DB_*` (added when `/api/fork/register` shipped). It does NOT
  have `FORK_TEAMS_DIR` — the ingest route needs to write team XML files, so config-web will need that
  env var too (or its own resolution of the fork's `teams/` dir) — check `apps/discord-bot/.env` for the
  exact path in use (`fumbbl40k-server\ffb-server\teams`) and mirror it.
- The two already-shipped routes (`/api/fork/jnlp`, `/api/fork/register`) are documented in
  `docs/40k-fork-guide.md` and `docs/RESUME.md` — match their style/tone when documenting the new ones.
- `mysql2` is a dependency of `@bb/fork-ops` already (added for `createForkAccount`) — the `/api/fork/coaches`
  autocomplete query can reuse that same connection pattern.

Ask the owner which of the two design questions they'd rather weigh in on if anything feels ambiguous
beyond what's above — but don't block the whole build on it; use the stated recommendation and move.
```
