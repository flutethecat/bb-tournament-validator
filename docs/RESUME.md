# RESUME — read this first

Handoff for the **BB Tournament Validator** (`C:\Users\Jay\Documents\Claude\bb-tournament-validator\`).
Last updated 2026-07-06 · HEAD = FUMBBL team-ingestion commit ·
**135 tests green, all packages typecheck + build.**

## What this is
A Discord bot + a portable TS validation core + a TO web config pane that validate Blood Bowl **2025**
rosters against tournament packages. The core (`@bb/validator`) is pure, Node-free, browser-safe TS
so it can later drop into the FUMBBL40k Tauri/PixiJS client (see `docs/fumbbl40k-integration.md`).

## Relationship to FUMBBL40k (why this exists — strategic context)
This project is **not standalone forever** — it's built to branch into the sibling **FUMBBL40k**
project, and the two are already wired together:

- **FUMBBL40k** (`C:\Users\Jay\Documents\Claude\fumbbl40k-client` + `fumbbl40k-server`, both private
  GitHub `flutethecat`) is a fork of FFB (github.com/christerk/ffb) building a **Tauri v2 + Vue 3 +
  PixiJS** cross-platform Blood Bowl client that speaks the FFB WebSocket protocol, plus a forked
  Java server for async play + leagues. Its full context is in the `[[fumbbl40k-project]]` memory.
- **This validator's core is that project's tournament-validation engine.** The FUMBBL40k client has a
  **T1 tournament-play plan** (`fumbbl40k-client/docs/tournament-play-plan.md`): a client *tournament
  mode* + an authoritative *tournament service*, both of which **bundle `@bb/validator`** as the
  single validation engine (client for instant local pre-validation, service as the authority — one
  package, two consumers, no drift). The service also ingests this project's `ValidatedStore` design
  and the Discord bot becomes a thin adapter over the service API.
- **That is why the core is pure/Node-free** — it has to run in the Tauri **webview** (a browser JS
  engine, not Node). Every "keep I/O out of the core" decision traces back to this.
- **Shared data lineage:** this validator's dataset is pulled from **FUMBBL's own API** (ruleset 3906)
  and the fork's skill categories — the same data the FUMBBL40k client/server already use. So the two
  projects stay consistent by construction.
- **Integration mechanics + all cross-project decisions (D1–D8)** — consumption via git-tag pin,
  dataset bundled inside the core package, client touchpoints (`TournamentView.vue`, a `tournament`
  Pinia store, settings service URL, movable §A5b dialogs, the endGame/case-299 result hook), and the
  parity/E2E test plan — are in **`docs/fumbbl40k-integration.md`** (its §6 has the decision record).
- **Consequence for future work:** keep `@bb/validator` framework-agnostic and its result/render
  shapes stable; new validation lives in the core (not the bot/service) so both consumers get it;
  favour server-derived signals. When FUMBBL40k work resumes, this repo is a dependency of it.

## Verify the state
```
pnpm install
pnpm test            # 126 tests, all green
pnpm build           # builds @bb/validator (tsup, platform:neutral)
# typecheck each pkg: (cd <pkg> && ../../node_modules/.bin/tsc -p tsconfig.json)
```

## Layout (pnpm monorepo, Node 24 / pnpm 10.34)
- `packages/bb-validator/` — **pure core**. Model, `TournamentPackage` schema, resolver
  (`resolveTeamConfig`, precedence **team > matrix > tier > flat**, global star bans union in),
  11-rule registry, configurable Skill-Point costing **and** primary/secondary count mode (+secondary
  swap), renderers (`renderPackageHtml`, `renderArtPrompt`). Bundled BB2025 dataset at
  `src/dataset/bb2025/` (exported as `@bb/validator/dataset`).
- `packages/bb-ingest/` — bbtc.pl PDF → `Roster` (pdfjs-dist); rules-document + CSV package ingest.
- `apps/discord-bot/` — discord.js. `/bbbot validate|report|packages|package show|import|coach|
  export|artprompt|watch|unwatch|watches`. Stores: validated CSV, coach registry, watch bindings.
- `apps/config-web/` — zero-framework Node http server + vanilla HTML/CSS/JS pane (Configure / Tiers /
  Matrix / Team Rules / Coaches). Serves `/api/*`; writes `tournament-packages/*.json`.

## What's built (all working)
- Ingest bbtc.pl PDFs (golden-tested on the two example PDFs) + rules-doc/CSV packages.
- Validate: eligibility, squad size, positional limits (skips stars), gold budget, skill access,
  Skill-Point **or** primary/secondary **count** allotment (secondary swap = 2 primaries → 1
  secondary, enforced), cost reconciliation, star players (generic detection + bans + **per-team
  eligibility**), inducements, sideline, special rules.
- Four exclusive config modes with best-effort conversion between them; global star bans inherited.
- **Cash×skills Matrix** (drag/drop, gold notation `1150`/`1.15M`, columns capped + teams wrap).
- Per-tier gold/SP/stars/bans; per-team line-item rules.
- Export one-page HTML rules sheet + AI-art prompt (bot commands + config buttons).
- **All 30 BB2025 teams** in the dataset.
- Discord bot live behaviors: ✅ react + DM + CSV row on valid roster; `/report` links; watched-channel
  auto-ingestion (needs Message Content intent).

## Data source of truth (important)
- **Rosters** = FUMBBL REST API **ruleset 3906 "BB2025"** (`fumbbl.com/api/roster/list/3906` +
  `roster/get/{id}`). Verified to match the bbtc.pl example Amazon exactly. Owner picked FUMBBL over
  bbtc.pl (bbtc is a SPA with no clean data endpoint).
- **Skill categories** = the `fumbbl40k-server` fork's Java skill classes (`com.fumbbl.ffb.skill.**`,
  bb2025 package wins), incl. the **Devious ("D")** tree (Dirty Player, Sneaky Git, Shadowing, Pile
  Driver, Put the Boot In, Quick Foul, Eye Gouge, Lethal Flight, Lone Fouler, Saboteur, Fumblerooski,
  Violent Innovator). Roster codes G/A/S/P/M/D → General/Agility/Strength/Passing/Mutation/Devious.
- Regenerate with `python packages/bb-validator/scripts/generate_dataset.py` (needs fumbbl.com +
  the sibling fork repo). Writes `rosters.json` / `skills.json` / `teams.json`.

## Live bot ops
- App **"Blood Bowl Tournament Bot#7593"**, client id `1523777908408058106`, guild
  `1118995074685087816`. Creds in `apps/discord-bot/.env` (gitignored). ⚠ Token was pasted in chat;
  owner chose NOT to reset it, and to keep Administrator.
- Needs the **Message Content privileged intent** ON (Bot page) for watched-channel ingestion —
  Administrator permission does NOT cover it.
- The bot runs as a foreground process that dies with the session. To bring it back:
  `cd apps\discord-bot && pnpm register && pnpm start` (register only needed after command changes).
- ⚠ Private channels need the bot **added to the channel** even with Administrator.

## Key gotchas / durable lessons
- Never bind one big `<datalist>` to many inputs — it hangs Chrome's renderer (looks like "lost
  styling"). Star inputs use `.star-ac` + attach `list` on focus only.
- Matrix cells: keep `<td>` a table cell; the flex drop-zone is an inner `<div>` (else cells stack).
- `resolveTeamConfig` is THE place all config methods funnel through — extend it, not the rules.
- Core stays Node-free (no `fs`/`Buffer`/`pdf`/`discord`) — that's the portability contract.
- `preview_screenshot` was flaky/hung most of this iteration (headless capture, not the app); UI was
  verified via DOM/geometry inspection instead.

## Open items / next steps (prioritized)
1. ~~**Star-player eligibility**~~ ✅ **DONE (uncommitted).** `stars.json` is now regenerated from
   FUMBBL `_Star Players` roster **8513** (67 stars) carrying `playsFor` (special-rule keywords) →
   resolved to an explicit eligible `teams` list at dataset-gen time (`build_stars`/`FAVOURED_MAP` in
   `generate_dataset.py`; run `--stars-only` to refresh from local `rosters.json`). The `star-players`
   rule enforces eligibility (`starEligibleForTeam` in `lookup.ts`): a star on a team it can't play for
   → error. `(Any)` = all teams; `(Negate Availability)` = all-except-listed (Morg minus Sylvanian
   Spotlight); the collapsed FUMBBL `"Favoured of..."` team rule is expanded per team by `FAVOURED_MAP`
   (specific-deity teams = own god; generic Chaos teams Chosen/Renegade/Norse = all gods, permissive to
   avoid false rejections — **revisit if FUMBBL exposes per-team gods**). Stars with empty `teams`
   (Frank 'n' Stein, Bryce Cambuel — no FUMBBL `playsFor`) skip eligibility so data gaps never reject.
   DATASET_VERSION → `bb2025.4-star-eligibility`. **Config pane:** the star-ban autocomplete is now
   context-aware (`eligibleStarNames`/`teamsForStarInput` in `app.js`) — Team Rules offers only that
   team's eligible stars, a Tier offers the union across its member teams, the global ban offers every
   star that HAS eligibility data; banning a star no relevant team can field is occluded (a no-op that
   should never occur). Appearance is gated behind eligibility data: the 2 empty-`teams` stars are
   occluded everywhere in the picker (the validator still doesn't reject them — data-gap safety).
2. **Inducement costs/gating** — `data/bb2025/inducements.json` still has `_verify` placeholders;
   FUMBBL ruleset options likely hold the real numbers.
3. ~~**Position keywords**~~ ✅ **DONE.** All 159 positions (30 teams) now carry `keywords` (race +
   role, e.g. `["Human","Lineman"]`) for FUMBBL40k's T1 keyword-gating. Sourced from FUMBBL's roster
   **XML** (`fumbbl.com/xml:roster?id=<rid>`) — the JSON API omits them; parsed in
   `roster_keyword_map`, title-cased + sorted to match the bbtc.pl print (Amazon fixture is the gate:
   new parity test in `datasetGate.test.ts`). One upstream FUMBBL gap (Renegade Skaven, no XML
   keywords) filled via `KEYWORD_OVERRIDES`. Refresh in place with `generate_dataset.py --keywords-only`.
4. ~~**M3.5 — FUMBBL API roster ingestion**~~ ✅ **DONE (code).** `/bbbot validate package:<name>
   [roster:<pdf>] [fumbbl-team:<id>]` — pass a FUMBBL team id instead of a PDF. `fumbblTeamToRoster`
   (bb-ingest, the M6 JSON→Roster seam) converts `fumbbl.com/api/team/get/{id}` JSON → `Roster`,
   filling stats/cost/keywords from the dataset position (FUMBBL omits per-player stats; no rule reads
   printed stats) and skills from the team; `validateFumbblTeam` in the bot pipeline fetches + validates.
   +4 converter tests (135 green). ⚠ **Must `pnpm register` + restart the bot** to expose the new option.
   Known limit: FUMBBL *league* teams carry earned stat-ups as pseudo-skills (`+AG`/`+MA`) that show as
   "unknown skill" — fresh tournament teams don't have these; refine later if league teams need support.
5. **Push to GitHub** (private, `flutethecat`) so the client can consume `@bb/validator` via a git tag
   (decision D7). Repo is local-git only.
6. **Run the bot persistently** (Windows service / beside the fork server — decision D3).
7. Fix/avoid the flaky screenshot workflow for UI verification.

## Pointers
- Full plan: `C:\Users\Jay\.claude\plans\c-users-jay-desktop-example-pdf-2-pdf-c-functional-pebble.md`
- Docs: `docs/architecture.md`, `docs/data-model.md`, `docs/tournament-package.md`,
  `docs/fumbbl40k-integration.md`, `docs/discord-setup.md`, `docs/regression-scenarios.md`,
  `docs/roadmap.md`.
- Decisions D1–D8 (source of truth, precedence, identity, pinning, etc.):
  `docs/fumbbl40k-integration.md` §6.
