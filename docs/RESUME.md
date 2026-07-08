# RESUME — read this first

> **Session callsign: General Veers** — this (the Tournament Bot / BB Tournament Validator) track's identity
> in the FUMBBL40k convo family. Siblings: **Tarkin** (Fumbbl40k client), **Colonel Aurek Voss** (FUMBBL
> Classic), **Wulff Yularen** (artifact orchestrator, `local_18db1e04…`). Use this name on cross-session
> messages so a future Tournament Bot session is recognized consistently.

Handoff for the **BB Tournament Validator** (`C:\Users\Jay\Documents\Claude\bb-tournament-validator\`).
Last updated 2026-07-08 · validator core + FUMBBL40k bot integration (daily-summary auto-publish +
copyteam fork-roster-support warning + announcement hold + config-web one-click launch/register +
**fork team library + Create-Game matchmaking**) · published: `flutethecat/bb-tournament-validator`
(private; tag **`v0.2.0`** = current pin point — Spike! ruleset + all fork-ops + library/matchmaking;
v0.1.0/v0.1.1 predate that work) · **185 tests green, all packages typecheck + build.**
✅ **Announce hold LIFTED 2026-07-08** (owner go-ahead) — the pipeline is live again and **v0.1.14 (test)
was announced** to the announce channel (installer attached; de-dupe state `build-announce.json` marked
`0.1.14`/`b95324f`). To pause again: `/bbbot 40k hold`; `data-store/announce-hold.json` is the switch.

✅ **DONE: fork team library + Create-Game matchmaking** (both sides shipped, 2026-07-08). Server built
per the spec (`fumbbl40k-client\docs\fork-team-browser-spec.md`, `c6ee70e`): 6 new `/api/fork/*` routes +
the register-password fix, all on config-web (see the fork-endpoints section below). Verified live against
the running fork (MariaDB 3316): matchmaking pairs both sides on a shared gameName with correct per-side
JNLPs; ingest fetches a real FUMBBL team, re-coaches + writes its XML, upserts the library row; register
now persists the coach's chosen password (confirmed the stored md5 matches). **Client side** was already
done (fumbbl40k-client `3c0efea`, cases 428–429, E2E-validated vs a local stub). Two design decisions I
made (recorded, not silent defaults): **(1)** ingested teams **persist** (XML kept in the fork's teams/
dir + a JSON library row per coach — survive a rebuild as long as files are kept); **(2)** ingest returns
**`needsRestart:true`** for v1 (no FFB hot team-cache reload — out of scope, that's fork-server code). The
build spec/plan is preserved in `docs/fork-library-resume-prompt.md` for reference.

## What this is
A Discord bot + a portable TS validation core + a TO web config pane that validate Blood Bowl **2025**
rosters against tournament packages. The core (`@bb/validator`) is pure, Node-free, browser-safe TS
so it can later drop into the FUMBBL40k Tauri/PixiJS client (see `docs/fumbbl40k-integration.md`).
The Discord bot **also hosts FUMBBL40k fork ops** (`/bbbot 40k …` — account/team provisioning, JNLP
game-launching, and an automated build announcer with a daily 9AM publish; see `docs/40k-fork-guide.md`).

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
  `copyteam` (**warns if the team's race has no matching fork roster** — `forkSupportsRace`/`RACE_ALIASES`
  in `fork40k.ts`, curated not fuzzy-substring on purpose, see its comment for the "Orc" ⊂ "Black Orc"
  false-positive it avoids; the original 6-race gap — Black Orc/Khorne/Snotling/Gnome/Imperial Nobility/
  Old World Alliance — was closed 2026-07-08 by generating those roster XMLs, see the fumbbl40k-server
  cross-repo note below), `launch` (posts fork-join JNLPs, @-pings each coach — **gated on `/bbbot coach
  register fumbbl:<name>`**), `announce` (re-post latest build), `daily` (re-post daily summary). Guide:
  `docs/40k-fork-guide.md`. Deps: `mysql2`.
- **`@bb/fork-ops`** (`packages/bb-fork-ops/`, renamed from `@bb/fork-jnlp` once a 2nd shared need showed
  up): `buildForkJnlp`/`jnlpFilename` (pure) + `createForkAccount`/`queryCoaches`/`forkConfigFromEnv`/
  `forkDbConfigFromEnv` (mysql2) + the team-fetch/ingest helpers (`fetchForkTeam`/`copyForkTeam`/
  `parseTeamId`/`forkSupportsRace`/`parseTeamXmlMeta`/`ingestForkTeam`, lifted here from the bot's
  `fork40k.ts` once config-web needed them too — `teams.ts`) + the library store (`library.ts` —
  `readLibrary`/`upsertLibraryTeam`/`LibraryTeam`) + `Matchmaker` (`matchmaking.ts`, in-memory, poll-based,
  ~10min TTL). Used by BOTH the bot's `/bbbot 40k` commands and config-web's `/api/fork/*` routes so they
  can't drift. `ForkDbConfig` (DB-only, gated on `FORK_DB_HOST`) vs `ForkConfig` (+ `teamsDir`, gated on
  `FORK_TEAMS_DIR`). `discord-bot/src/fork40k.ts` is now a thin re-export barrel.
  `createForkAccount(cfg, name, password?)` md5s the chosen password (defaults to "12345" when omitted).
- **Config-web fork endpoints** (all GET, all in `PUBLIC_PATHS` → bypass `ADMIN_PASSWORD`, all get
  `access-control-allow-origin: *` on **every** response incl. errors — set centrally in the request
  handler so a missing-param 400 is still readable by a browser client). `.env` needs `FORK_DB_*` (register/
  coaches/matchmaking) and `FORK_TEAMS_DIR` (ingest); `FORK_LIBRARY_DIR` optional (defaults to
  `apps/config-web/data-store/library`):
  - `GET /api/fork/jnlp?coach&teamId&gameName&password` — one-click Launch (JNLP attachment).
  - `GET /api/fork/register?coach&password` — register/reset a fork coach with the **chosen password**
    (md5-hashed); `password` optional → "12345". `{ok,coach}`/`{error}`.
  - `GET /api/fork/library?coach` → `{teams:LibraryTeam[]}`.
  - `GET /api/fork/library/ingest?coach&team` → `{ok,team,raceWarning?,needsRestart}` — fetch a FUMBBL team
    (id or /t/URL), re-coach + write its XML to the fork teams dir, upsert the library row.
  - `GET /api/fork/coaches?q&limit&coach` → `{coaches:[name]}` — opponent autocomplete (`coach` excludes
    self; LIKE metachars escaped).
  - `GET /api/fork/challenge?coach&teamId&opponent&password` → `{status:"waiting"}` (reciprocal match is
    delivered via the next poll for both sides).
  - `GET /api/fork/matchstatus?coach` → `{status:"waiting"}` | `{status:"matched",gameName,opponent,jnlp}`
    (matched result is consumed on read).
  - `GET /api/fork/cancel?coach` → `{ok}`.
- **Build announcer:** the bot polls the FUMBBL40k client's `dist-manifest/latest-build.json`
  (contract `fumbbl40k.build-manifest/1|2`) every 60s and posts new cuts (What's-new change log +
  attached installer, or `downloadUrl` link fallback) to the announce channel; de-dupes on
  version+gitSha (state `data-store/build-announce.json`).
- **Daily-summary announcer:** the bot also polls the shared cross-track end-of-day file
  `fumbbl40k-client/docs/daily-summary.md` every 60s and posts the **topmost day's entry** (parsed:
  stops at the first `---` or next `## ` heading, so same-day appendices like "## Smoke test" are
  excluded) as its own embed to the announce channel; de-dupes on date (state
  `data-store/daily-summary-announce.json`). Read the FILE directly (not a cross-session tagged
  message) — the compiling session may reset right after compiling, so a live-message trigger isn't
  robust. Manual re-post: `/bbbot 40k daily`.
- **⏰ Windows Scheduled Task "FUMBBL40k Daily Build Announce"** runs `apps\discord-bot\scripts\
  daily-announce.cmd` daily at **09:00 local (= Pacific, machine TZ)** → `pnpm announce`
  (`src/announceOnce.ts`): one-shot login, publishes the latest build **and** the daily summary if new
  (shares de-dupe state with the pollers), exits. Backstops both pollers when the bot isn't running.
  Log: `data-store/announce.log`. Manage via `Get-ScheduledTask -TaskName "FUMBBL40k Daily Build
  Announce"`.

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
6. **Run the bot persistently** — owner does NOT want the DISCORD BOT hosted here; **find real hosting**
   (VPS / beside the fork server — decision D3). PARKING-LOT until a host is chosen.
6b. ✅ **config-web is durably HOSTED** (owner directive 2026-07-08 — "stay up unless otherwise directed";
   Register + Create Game in the client hard-require it on :4310). **Windows scheduled task "FUMBBL40k
   config-web" (owner registered it elevated 2026-07-08) runs `apps/config-web/scripts/serve.cmd` (tsx
   src/server.ts → :4310, logs to `data-store/config-web.log`) AtLogOn, unlimited runtime, restart-on-crash
   ×3.** Verified live: task Running, 4310 serving all `/api/fork/*` routes. Survives session close, logoff,
   and reboot (re-fires at logon).
   - Manage: `Get-ScheduledTask -TaskName "FUMBBL40k config-web"` / `Start-ScheduledTask` / `Stop-ScheduledTask`.
   - If ever down before the next logon, relaunch now: `Start-Process cmd '/c "C:\Users\Jay\Documents\Claude\bb-tournament-validator\apps\config-web\scripts\serve.cmd"' -WindowStyle Hidden`.
   - ⚠ Registering the task needs an ELEVATED shell (the non-elevated agent shell gets Access Denied on
     `Register-ScheduledTask`/`schtasks /create`); in PowerShell use the cmdlet form (New-ScheduledTaskAction
     + Register-ScheduledTask), NOT cmd-style `\"` escaping (it swallows `/sc`). serve.cmd path has no spaces.
7. ~~Screenshot workflow~~ **PARKING-LOT** (owner). Keep verifying UI via DOM/geometry inspection.

## Pointers
- Full plan: `C:\Users\Jay\.claude\plans\c-users-jay-desktop-example-pdf-2-pdf-c-functional-pebble.md`
- Docs: `docs/architecture.md`, `docs/data-model.md`, `docs/tournament-package.md`,
  `docs/fumbbl40k-integration.md`, `docs/discord-setup.md`, `docs/regression-scenarios.md`,
  `docs/roadmap.md`, `docs/40k-fork-guide.md` (coach + admin how-to for `/bbbot 40k` game launching),
  `docs/fork-library-resume-prompt.md` (**NEXT UP** — copy-paste resume prompt for the fork team
  library + Create-Game matchmaking build, not yet started).
- Decisions D1–D8 (source of truth, precedence, identity, pinning, etc.):
  `docs/fumbbl40k-integration.md` §6.
