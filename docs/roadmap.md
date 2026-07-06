# Roadmap

Derived from the approved plan
(`C:\Users\Jay\.claude\plans\c-users-jay-desktop-example-pdf-2-pdf-c-functional-pebble.md`).

## Release framing (owner, 2026-07-06)

- **v1 = M1 + M2 + M3** — a Discord bot that validates tournament rosters from submitted PDFs.
  **✅ BUILT 2026-07-06** (66 tests green; live-guild E2E pending a bot token).
- **v2 = M3.5** — validating against FUMBBL: fetch the roster from the FUMBBL API (no PDF).
- All decisions D1–D8 are settled — see `fumbbl40k-integration.md` §6. The service lives at
  `apps/tournament-service` in THIS monorepo; the core gets built here (D1+D2).

## M1 — Core + Amazon dataset
- `bb-validator`: model, `TournamentPackage` schema (zod), `costSP()`, rule registry, `runRules()`.
- Dataset: `convertXml` scaffold; **only Amazon reconciled to BB2025** (pinned by the example PDFs).
- Ship `bb2025-default` + the Lustrian sample package.
- Unit tests per rule + `costSP()` tests (default 1; Elite = 2; secondary ×2; CSV override wins;
  changing the Elite set/surcharge re-prices).
- **Gate:** generated Amazon == example-PDF positions/stats/costs.

**Artifacts already produced for M1:** `data/bb2025/rosters/amazon.json`,
`data/bb2025/skills.json`, `tournament-packages/*.json`, `fixtures/amazon-example.roster.json`,
`schemas/tournament-package.schema.json`, plus **unbuilt `.ts` sketches** under
`packages/bb-validator/src/`, `packages/bb-ingest/src/`, `apps/discord-bot/src/`.

## M2 — Ingestion
- `bb-ingest` bbtc.pl **roster PDF** adapter (pdfjs-dist) → normalized `Roster`; golden tests against
  the two example PDFs (target: `fixtures/amazon-example.roster.json`).
- Rules-document **package** ingestion + CSV skill-cost loader.
- Non-Amazon uploads fail gracefully ("roster not yet supported") in M1/M2.

## M3 — Discord bot
- `/validate package:<name>` with attachment → embed (PASS/FAIL, grouped findings + suggestions,
  recomputed SP/gold summary).
- On valid: **✅ reaction**, **DM the coach**, **append to validated-roster CSV**
  (`discordUserId, coachName, teamName, rosterRace, packageName, messageLink, validatedAt`).
- `/report` → validated coaches + teams + clickable Discord message links.
- `/packages list`, `/package show`, `/package import` (doc/CSV → package).

## M3.5 — FUMBBL validation (= release v2, owner milestone 2)
- **`fumbbl-api` RosterSource:** `/validate fumbbl-team:<id|name>` — the bot fetches the team from
  fumbbl.com's API (team JSON → normalized `Roster`; same xml/api shapes the FUMBBL40k client
  already consumes) and validates it against the package. No PDF involved.
- **Coach identity library** (owner design, replaces D4's claim code): registry entry per coach
  `{ id, discordUserId, fumbblName, nafName, nafId, teams[] }`, every key resolvable by the bot
  (`/coach register`, `/coach lookup naf:1234`). NAF name/number is the established competitive
  identifier; `teams[]` tracks per-tournament team registrations. Backs the tournament service's
  entrant identity later (integration plan §6 D4).
- Note: FUMBBL rosters may be races the dataset hasn't reconciled yet — the M1 "roster not yet
  supported" graceful-fail path applies until M4 breadth lands.

## M4 — Breadth
- Reconcile the remaining BB2025 rosters against bbroster.com; bbroster.com ingestion adapter.
- Real BB2025 inducement costs/gating; cross-team star-player eligibility dataset.
- More sample packages; wizard / bot-settings surface for editing SP costs.

## M5 — Screenshots + client port
- Screenshot **OCR** roster source (Tesseract or a vision model) behind the same `RosterSource`.
- Import `bb-validator` into the FUMBBL40k Tauri/PixiJS client (webview) with no core changes —
  mechanics, client touchpoints, and phase mapping in
  [`fumbbl40k-integration.md`](fumbbl40k-integration.md) (pairs with the client repo's
  `docs/tournament-play-plan.md` T1; note T1.4 blocks only on M1, not on M5).

## M6 — Blood Bowl 3 / Warhammer Blood Bowl (roadmap only, not current scope)
- Ingest BB3 teams via a **game-exported JSON** file (straightforward `RosterSource` adapter) and/or
  by **OCR-ing a BB3 screenshot** and applying layout logic (reuses the M5 OCR path).
- Both normalize to the same `Roster` model → no validation/core changes needed. Design the
  `RosterSource` interface now with this in mind.

## Standing risks
- **BB2025 data freshness** is the biggest risk — reused server XMLs are legacy LRB6; reconciliation
  is manual per roster. Mitigated by gating on the example PDFs and cross-checking bbroster.com.
- **PDF parsing is layout-sensitive** — lock with golden fixtures; fail loudly on unknown layouts.
- **Keep the core Node-free** — enforce via lint/CI so it imports cleanly into the Tauri webview.
