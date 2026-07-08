# RESUME — read this first

Handoff for the **BB Tournament Validator** (`C:\Users\Jay\Documents\Claude\bb-tournament-validator\`).
Last updated 2026-07-07 · HEAD = Spike elite-cost fix · published: `flutethecat/bb-tournament-validator` (private, tag **`v0.1.1`** = current; `v0.1.0` = pre-Spike) ·
**153 tests green, all packages typecheck + build.**

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
  **Tiers now also support count-mode Primary/Secondary allotment + Secondary Swap** (like matrix/team
  rules). **Skill Stacking** (`maxStackedPlayers`) is in all four modes: caps how many players may carry
  >1 added skill (null = no cap); resolved per-team (flat < tier < matrix row < team rule) and enforced
  in the `skill-points` rule. Surfaced everywhere: config pane, one-page HTML export (tier Skills/Stacking
  columns, matrix row notes, team-rules Stacking column, flat hint) and `/bbbot package show`.
- **Cash×skills Matrix** (drag/drop, gold notation `1150`/`1.15M`, columns capped + teams wrap).
- Per-tier gold/SP/stars/bans; per-team line-item rules.
- Export one-page HTML rules sheet + AI-art prompt (bot commands + config buttons).
- **All 30 BB2025 teams** in the dataset.
- **Spike! 2026 ruleset** (`tournament-packages/spike-2026.json`, generated by `build-spike-2026.py`):
  6 tiers, each offering **choose-one gold+SP packages** (`TierDef.skillPackages`; roster legal if it
  fits ANY — the `skill-packages` rule does the gold∧SP∧maxPerPlayer disjunction, and goldBudget/
  skillPoints yield to it). **Stars priced in Skill Points per tier** (`starPlayers.spCostByTier`,
  null=unavailable; `paidInSkillPoints` excludes star gold). Validates the live Dwarf team (t/1263233)
  correctly as NOT legal (9.5 SP > Tier 3's 9-SP max). ⚠ **star SP table transcribed from a rules-pack
  image — spot-check**. ⚠ **the config pane can't author packages/star-SP yet** — editing spike-2026
  there and saving would DROP `skillPackages`/`spCostByTier`; author via the generator. Follow-ups:
  config-pane authoring for skill packages + the HTML export doesn't yet render the 3 packs per tier.
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
- **FUMBBL40k fork admin** (`/bbbot 40k`, Manage Server, needs the bot on the fork host + `FORK_*` env):
  `setchannel` (games/JNLP channel), `announcechannel` (build-announce channel), `createaccount`,
  `copyteam`, `launch` (posts fork-join JNLPs, @-pings each coach — **gated on `/bbbot coach register
  fumbbl:<name>`**), `announce` (re-post latest build). Guide: `docs/40k-fork-guide.md`. Deps: `mysql2`.
- **Build announcer:** the bot polls the FUMBBL40k client's `dist-manifest/latest-build.json`
  (contract `fumbbl40k.build-manifest/1|2`) every 60s and posts new cuts (What's-new change log +
  attached installer, or `downloadUrl` link fallback) to the announce channel; de-dupes on
  version+gitSha (state `data-store/build-announce.json`).
- **⏰ Windows Scheduled Task "FUMBBL40k Daily Build Announce"** runs `apps\discord-bot\scripts\
  daily-announce.cmd` daily at **09:00 local (= Pacific, machine TZ)** → `pnpm announce`
  (`src/announceOnce.ts`): one-shot login, publishes the latest build if new (shares the de-dupe
  state with the poller), exits. Backstops the poller when the bot isn't running. Log:
  `data-store/announce.log`. Manage via `Get-ScheduledTask -TaskName "FUMBBL40k Daily Build Announce"`.

## Key gotchas / durable lessons
- **FUMBBL "team details" PDFs** (not bbtc.pl) mostly parse via `bbtcPdfSource`, but the **header
  mis-parses** (race/coach/teamName split wrong — e.g. race "Underworld", teamName "COACH NAME",
  coach "Denizens"). Legality is fine (race canonicalizes; skills/gold correct) but the embed
  title/CSV coach are wrong. Prefer `/bbbot validate fumbbl-team:<id>` for FUMBBL teams. A proper
  team-details header adapter is a follow-up. FUMBBL skills carry a trait `*` and `(4+)`/`(Goblin)`
  annotations — `normName` now strips them. Skills/stars are SP-paid, so their gold is excluded from
  the tier gold cap (skill-packages rule).
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
2. ~~**Inducement costs/gating**~~ ✅ **DONE.** `inducements.json` (20 inducements) is regenerated from
   FUMBBL ruleset **3906 `clientOptions`** (authoritative per-ruleset costs/caps) — no more `_verify`.
   Reduced-cost special rules captured (`reducedCost`/`reducedMax`/`reducedSpecialRule`: Bribes 3→6 &
   50k under Bribery and Corruption, Master Chef under Halfling Thimble Cup, Biased Ref under B&C). The
   `inducements` rule now raises the cap when the team carries the unlocking special rule. Regenerate
   with `generate_dataset.py --inducements-only`. DATASET_VERSION → `bb2025.5-inducements`. (+2 tests.)
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
5. ~~**Push to GitHub**~~ ✅ **DONE.** Private repo **`flutethecat/bb-tournament-validator`**
   (https://github.com/flutethecat/bb-tournament-validator), `master` tracked, tagged **`v0.1.0`** so
   FUMBBL40k can pin `@bb/validator` via git tag (D7). `.env`/`data-store/` gitignored; history scanned
   clean of the bot token before publishing.
6. **Run the bot persistently** — owner does NOT want it hosted here; **find real hosting** (VPS / beside
   the fork server — decision D3). PARKING-LOT until a host is chosen.
7. ~~Screenshot workflow~~ **PARKING-LOT** (owner). Keep verifying UI via DOM/geometry inspection.

## Pointers
- Full plan: `C:\Users\Jay\.claude\plans\c-users-jay-desktop-example-pdf-2-pdf-c-functional-pebble.md`
- Docs: `docs/architecture.md`, `docs/data-model.md`, `docs/tournament-package.md`,
  `docs/fumbbl40k-integration.md`, `docs/discord-setup.md`, `docs/regression-scenarios.md`,
  `docs/roadmap.md`, `docs/40k-fork-guide.md` (coach + admin how-to for `/bbbot 40k` game launching).
- Decisions D1–D8 (source of truth, precedence, identity, pinning, etc.):
  `docs/fumbbl40k-integration.md` §6.
