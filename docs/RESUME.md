# RESUME — read this first

Handoff for the **BB Tournament Validator** (`C:\Users\Jay\Documents\Claude\bb-tournament-validator\`).
Last updated 2026-07-06 · HEAD `7092790` · **126 tests green, all packages typecheck + build.**

## What this is
A Discord bot + a portable TS validation core + a TO web config pane that validate Blood Bowl **2025**
rosters against tournament packages. The core (`@bb/validator`) is pure, Node-free, browser-safe TS
so it can later drop into the FUMBBL40k Tauri/PixiJS client (see `docs/fumbbl40k-integration.md`).

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
  secondary, enforced), cost reconciliation, star players (generic detection + bans), inducements,
  sideline, special rules.
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
1. **Star-player eligibility** — we detect + ban stars but don't enforce *which* stars a team may
   hire. FUMBBL exposes `_Star Players` roster (id 8513) + per-team `plays for` rules.
2. **Inducement costs/gating** — `data/bb2025/inducements.json` still has `_verify` placeholders;
   FUMBBL ruleset options likely hold the real numbers.
3. **Position keywords** — dataset positions have empty `keywords` (FUMBBL API omits them); needed for
   the FUMBBL40k client's T1 keyword-gating. Infer or source separately.
4. **M3.5 / v2 — FUMBBL API roster ingestion** (`/bbbot validate fumbbl-team:<id>`): natural now that
   we already talk to the FUMBBL API.
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
