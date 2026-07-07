# BB Tournament Validator

A Discord bot + portable validation core that ingests a Blood Bowl team (PDF now, screenshots later)
and validates it against a **tournament package** defined by a tournament organizer (TO), explaining
*why* the roster passes or fails each rule and how to fix it.

> Status: **v1 BUILT (M1+M2+M3, 2026-07-06)** — 66/66 tests green, all packages typecheck + build.
> Next: register the bot with a Discord token and run the live-guild E2E, then M3.5 (FUMBBL API).
> See [`docs/roadmap.md`](docs/roadmap.md).

## Running the config pane (TO web UI)

A zero-framework web pane for authoring tournament packages + a coaches dashboard.
Writes the same `tournament-packages/*.json` the bot hot-loads — changes go live with no restart.

```
pnpm install
pnpm --filter config-web start          # → http://127.0.0.1:4310
```

- **Configure tab:** tournament name/date, eligible rosters, Skill-Point settings, an Elite-vs-General
  skill list with per-skill cost overrides and a "Do Elite skills cost more?" toggle, sideline/star/
  special caps. Load a **preset** (BB2025 Default, Resurrection 6+2, Eurobowl 2026 approx, Amorical Cup
  per-coach subset) or **edit an existing package**, then Save.
- **Tiers tab:** enable tier-based configuration, set the number of tiers, and drag the 30 BB2025
  teams between tiers. Each tier has its own gold cap, Skill-Point budget, Star Player access, and
  banned stars (name autocomplete from the 69-star list).
- **Matrix tab:** a cash×skills grid. Columns are gold budgets (type `1150` or `1.15M`); rows are
  skill allotments (primary + secondary counts, optional "secondary swap"). Drag teams into a cell —
  that cell sets the team's cash and skills. Add/remove columns and rows freely.
- **Team Rules tab:** per-team line items — gold, primary/secondary counts, swap, star access
  (inherit/allow/ban), and per-team banned stars. Highest precedence.
- **Ban Stars? (Configure tab):** a global banned-star list that tiers, matrix cells, and team
  rules all inherit automatically.

**Configuration precedence** (most-specific wins): team rule → matrix cell → tier → flat package;
global star bans union into every level.

**Two skill models:** the flat/tier path uses the configurable **Skill-Point pool**; the matrix and
team rules can instead use **primary/secondary counts** (with "secondary swap": a secondary slot may
always hold a primary skill, and swap rows let two primary slots buy one secondary). Counts come from
each added skill's primary/secondary access, matching bbtc.pl's "Primary/Secondary skills" summary.
- **Export HTML** (Configure tab): downloads a self-contained one-page rules sheet for the current
  package — matrix/tier/team tables, skill allotment, gold, stars, bans, sideline, special rules —
  print‑ready. The same renderer backs the bot's `/bbbot export`.
- **🎨 AI Art Prompt** (Configure tab): generates a copy‑ready prompt for an image model to make
  tournament key art, derived from the name/date/teams. Same generator backs `/bbbot artprompt`.
- **Coaches tab:** every validated coach with a link back to their roster post, filterable by package.
- Binds to localhost by default. To host it, set `HOST=0.0.0.0` **and** `ADMIN_PASSWORD=<secret>`
  (HTTP Basic auth); put it behind TLS on a public network.

> Presets note: Eurobowl 2026 (gold, per-race) and Amorical Cup (squad format) don't map 1:1 to our
> per-skill Skill-Point model — those presets capture what maps and flag the rest in their description.
> Always verify against the official pack.

## Running the bot

```
pnpm install && pnpm build && pnpm test          # from the repo root
cd apps\discord-bot
copy .env.example .env                            # fill DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID
pnpm register                                     # registers slash commands (instant with GUILD_ID)
pnpm start
```

All commands live under the `/bbbot` namespace (prevents conflicts with other bots):
`/bbbot validate roster:<pdf> package:<name>` · `/bbbot report [package] [csv]` ·
`/bbbot packages` · `/bbbot package show <name>` · `/bbbot package import <document> [skillcosts]` ·
`/bbbot coach register|lookup|me` · `/bbbot export package:<name>` (posts a one-page HTML rules
sheet) · `/bbbot artprompt package:<name>` (an AI-art prompt for the tournament). On a valid roster
the bot ✅-reacts, DMs the coach, and records them in `data-store/validated-rosters.csv`.

## Why

The validation logic will later be reused inside the FUMBBL40k **Tauri + PixiJS** client, whose UI
runs TypeScript in a **webview (browser engine), not Node**. So the core is designed as pure,
dependency-light, browser-safe TypeScript with **no Node built-ins** — all I/O (PDF, Discord, files)
lives in the bot's adapter layer. Scope is **BB2025 only**.

## What's here now (artifacts)

```
bb-tournament-validator/
├─ README.md
├─ docs/
│  ├─ architecture.md            # monorepo layout, data flow, portability guardrails
│  ├─ data-model.md              # TypeScript interfaces for Roster / TournamentPackage / results
│  ├─ tournament-package.md      # how TOs author packages + the Skill-Point costing model
│  ├─ fumbbl40k-integration.md   # how this project plugs into FUMBBL40k tournament mode (T1)
│  └─ roadmap.md                 # milestones M1..M6
├─ schemas/
│  └─ tournament-package.schema.json
├─ data/
│  ├─ bb2025/
│  │  ├─ rosters/amazon.json     # the only BB2025-reconciled roster in M1 (Amazon)
│  │  ├─ skills.json             # skill -> category + elite/trait flags
│  │  └─ inducements.json        # BB2025 inducement types (M4 reconciliation pending)
│  └─ skill-costs.example.csv    # CSV skill-cost override template
├─ tournament-packages/
│  ├─ bb2025-default.json        # baseline package
│  └─ lustrian-superleague.example.json  # sample package the example roster passes
├─ packages/                     # (reserved for pnpm workspaces; .ts sketches live here now)
│  ├─ bb-validator/src/          # UNBUILT code sketches of the pure core
│  └─ bb-ingest/src/             # UNBUILT ingestion adapter sketches
├─ apps/
│  └─ discord-bot/src/           # UNBUILT bot sketches (store + commands)
└─ fixtures/
   └─ amazon-example.roster.json # normalized Roster parsed from the supplied bbtc.pl PDFs (golden)
```

## Ground truth

The two supplied `Example PDF` files are bbtc.pl Amazon exports and are the M1 ground truth. Their
internal math is fully consistent and pins the Amazon dataset:

- Sideline 230k = 3 re-rolls × 60k + apothecary 50k → **re-roll 60k, apothecary 50k**.
- "Primary skills 6 / Skills cost 160k" decodes exactly as the 6 added skills
  (Block×3, Guard, Wrestle, Leader), all in their positions' **primary** categories.
- Under the owner's **Skill-Point** model (primary 1, Elite +1, secondary ×2) those 6 skills cost
  **10 SP** — see `fixtures/amazon-example.roster.json` and `packages/lustrian-superleague.example.json`.

## Key decisions

- **Stack:** TypeScript; pure webview-safe core, Node only in the bot.
- **Ingestion:** PDF/text first; OCR later; BB3 JSON/screenshots on the roadmap (M6).
- **TO packages:** JSON/YAML canonical, plus rules-document + CSV ingestion.
- **Skill costing:** configurable **Skill Points** (see `docs/tournament-package.md`).
- **Dataset:** all 30 BB2025 teams, generated from FUMBBL ruleset 3906 (`packages/bb-validator/scripts/generate_dataset.py`); skill categories (incl. Devious) from the fumbbl40k-server fork.
- **On success the bot:** ✅-reacts, DMs the coach, records them to a validated-roster CSV, and can
  emit a `/report` linking each validated coach to their post.
