# FUMBBL40k tournament-mode integration plan

Companion to the client-side directive
`C:\Users\Jay\Documents\Claude\fumbbl40k-client\docs\tournament-play-plan.md` (T1). That doc defines
*what* tournament mode is (client mode + authoritative tournament service, FFB protocol untouched).
This doc defines *how this project's pieces integrate into it* — consumption mechanics, client
touchpoints, phase mapping, and testing.

## 0. Contract recap (from T1)

- **Same core, two places:** the client bundles `bb-validator` for instant local pre-validation;
  the tournament service runs the SAME core and its verdict is the only one that counts.
- **The FFB game wire is never extended.** The service is a REST(+ws) overlay that references
  matches by gameName/gameId/coach; the client's Spectate/Play paths are unchanged.
- This project supplies: the validation core, the BB2025 dataset, the ingestion adapters
  (service-side PDF entry path), and the `ValidatedStore`/report design (service entrant store).

## 1. Consumption mechanics (how the core gets into the client)

Both repos live under `C:\Users\Jay\Documents\Claude\`, and `fumbbl40k-client` is a
pnpm@10 workspace (`apps/*`, `packages/*`). `bb-validator` is consumed as a **prebuilt package,
not workspace source**, so client tooling never compiles validator sources:

1. `bb-validator` gets a real build in M1: `tsup` → ESM `dist/` + `.d.ts`, `"sideEffects": false`,
   browser target, **zero runtime dependencies** (the purity contract in
   `packages/bb-validator/src/index.ts`).
2. **Dev loop:** path dependency in `apps/tauri/package.json` —
   `"@bb/validator": "file:../../../bb-tournament-validator/packages/bb-validator"`.
   pnpm resolves `file:` outside the workspace; Vite bundles the ESM dist into the webview like any
   other dep. (Same mechanism the tournament service uses from wherever it lives — owner D2.)
3. **Pinning (DECIDED D7, 2026-07-06):** git-tag dependency —
   `flutethecat/bb-tournament-validator#bb-validator-vX.Y.Z` with a `prepare` build (both repos are
   private GitHub; installing machines are gh-authed). The `file:` path stays for day-to-day dev.
4. **Dataset:** `bb-data`'s JSON (`data/bb2025/*.json`) ships INSIDE the `@bb/validator` package as
   an exported `dataset` entry point (`import { bb2025 } from "@bb/validator/dataset"`), so client
   and service can never disagree on rules data versions. It's ~tens of KB of JSON — bundling is a
   non-issue. (⚠ do NOT put it in `apps/tauri/public/` — the known Vite gotcha where new public/
   files need a dev-server restart; a normal import avoids it.)
5. **Version skew guard:** `validate()`'s result gains `coreVersion` + `datasetHash`; the service
   rejects submissions whose local pre-validation ran on an older dataset with a friendly "update
   the client" message (mirrors the client repo's Server1 version-check pattern).

## 2. Client touchpoints (fumbbl40k-client)

Follows the client's existing seams; nothing below touches `packages/ffb-protocol`'s wire code.

| Touchpoint | Integration |
|---|---|
| **Top-nav / StartMenu (M3)** | Tournament becomes the third mode beside Spectate \| Play (T1 §4). If tournament mode lands before the M3 StartMenu, it enters via a header mode toggle in the interim. |
| **New view** | `apps/tauri/src/views/TournamentView.vue` beside `SpectateView.vue`: tournament browser → my entrant status → "your table" pairing panel → standings (ws-refreshed). |
| **New store** | `tournament.ts` Pinia store: service base URL, active tournament, package, entrant status, pairings. Does NOT touch the game `store.ts` except the two hooks below. |
| **Settings** | `settings.ts` gains `tournamentServiceUrl` following the existing `SERVER_TARGETS` picker pattern (fork-local default `http://localhost:PORT`, configurable for hosted). |
| **Roster gate on join** | Before `store.ts connectAsPlayer()` (join by gameName+teamId), tournament mode checks the pairing: joining a game that isn't your pairing → warn (soft-block, TO override — owner D5). `eligibleRosters` + keyword gates filter team selection *before* submit. |
| **Validation dialog** | Local `validate()` findings rendered in a dialog that is **movable + resizable per style-guide §A5b** (standing client rule for ALL new dialogs). Rendering mirrors the bot's `renderResultEmbed` field-for-field: PASS/FAIL header, SP/gold summary line, per-finding message + *suggestion*. |
| **Result reporting** | Hooks the existing **endGame settle rail (client case 299)**: when a tournament pairing's game settles, offer "Report result" → `POST /pairings/:id/result` (score/CAS/gameId). Manual-entry form covers live-FUMBBL games played outside the client. |
| **Spectate links** | Standings rows link in-progress pairings to the existing spectate path (gameName on the fork / gameId on FUMBBL) — zero new protocol. |

Renderer/PixiJS impact: **none in v1.** Tournament mode is Vue-level UI around the untouched pitch;
the only pitch-adjacent element is the header showing tournament + round when active.

## 3. Service integration (where this project's other pieces land)

- **Authoritative check:** service imports the same `@bb/validator` + bundled dataset;
  `POST /tournaments/:id/entrants` body = the normalized `Roster` JSON (client submits structured
  JSON — no PDF in the client path).
- **PDF entry path (optional, TO-facing):** `bb-ingest`'s `bbtcPdfSource` runs service-side so a TO
  can accept PDF submissions from coaches who don't use the client. Same `IngestResult.problems`
  behavior: fail loudly, never mis-parse.
- **Entrant store:** the bot's `ValidatedStore` interface (`apps/discord-bot/src/store/validatedStore.ts`)
  is the service's entrant-store seam; `messageLink` generalizes to `sourceRef` (Discord message
  link OR client submission id).
- **Discord bot (T1.6):** the bot's handlers become thin adapters over the service API
  (`/validate` → `POST /entrants`, `/report` → `GET /standings`) — already annotated in
  `apps/discord-bot/src/commands.ts`.

## 4. Phase mapping (validator M-phases ↔ client T-phases)

| Step | Needs from this project | Client/service work |
|---|---|---|
| **T1.0** | `bb-validator` M1 built + Amazon dataset gate green (owner **D1**: built here or bootstrapped in the service repo and synced back) | none |
| **T1.1** | M1 core + `loadPackage` | Service skeleton: packages CRUD, entrant submit → authoritative validate, entrant store |
| **T1.2** | — | `bb-formats` (swiss/round-robin) in the service repo; pure/deterministic like the core |
| **T1.3** | — | Client read-only mode: browse/pairing/standings (`TournamentView`, `tournament.ts`, settings URL) |
| **T1.4** | M1 core bundled in client (§1 mechanics) | Local pre-validation UX, keyword/roster gates, authoritative submit round-trip |
| **T1.5** | — | endGame report flow + manual entry + TO confirm |
| **T1.6** | Bot M3 (or build the bot directly against the service) | Discord adapter |
| **Breadth** | Validator M4 (all BB2025 rosters reconciled) | Unblocks non-Amazon tournaments — the client's roster gate reads the same dataset, so it lights up automatically |

Key sequencing consequence: **client tournament mode T1.3 (read-only) can proceed in parallel with
validator M1** — only T1.4 blocks on the core being importable.

## 5. Testing the integration

- **Parity test (the critical one):** the same `(roster, package, dataset)` triple must produce
  identical `ValidationResult` JSON in (a) vitest/Node, (b) the service, (c) the Tauri webview —
  proven by a fixture round-trip using `fixtures/amazon-example.roster.json` +
  `tournament-packages/lustrian-superleague.example.json`. Deep-equal on the serialized result.
- **Bundle purity:** CI builds `@bb/validator` with a browser target and no Node polyfills; a Vite
  build of the client must not pull any polyfill for it (fails the build if it does).
- **E2E on the fork loop:** create a tournament on the service → submit the example Amazon roster
  (accept) and a mutated over-budget one (reject with suggestions) → generate round 1 → play/settle
  a game on the local fork (`ws://localhost:22227`, the drivePregame harness can bot one side) →
  report result → standings update. This exercises every client touchpoint in §2 without touching
  live FUMBBL.
- **Live-FUMBBL variant:** manual result entry path only (owner D6) — verify a pairing referencing a
  fumbbl.com gameId links out to spectate correctly.

## 6. Decisions (ALL DECIDED with the owner, 2026-07-06)

- **D1 — core home:** built **in this monorepo**, beside the service. (Owner picked "service repo";
  with D2 placing the service in `apps/tournament-service` here, that IS this repo — no sync-back,
  no drift.)
- **D2 — service location:** `apps/tournament-service` in this monorepo, beside `apps/discord-bot`.
- **D3 — hosting v1:** same box as the fork server (localhost); revisit for public events.
- **D4 — identity:** the claim-code idea is REPLACED by the **coach identity library** (owner
  design): one registry entry per coach —
  `{ id, discordUserId, fumbblName, nafName, nafId, teams[] (per-tournament registrations) }` —
  every key callable by the bot to resolve the coach (`/coach register`, `/coach lookup
  <key>:<value>`; NAF name/number is the established competitive identifier). Sketch:
  `apps/discord-bot/src/store/coachRegistry.ts`. Release framing set by the owner: **v1 = the
  Discord bot validating submitted PDFs; v2 = validating against FUMBBL = fetch the roster from the
  FUMBBL API** (`/validate fumbbl-team:<id>`, a new `fumbbl-api` RosterSource — no PDF).
- **D5 — pairing gate:** warn + TO override (soft-block).
- **D6 — live-FUMBBL results:** manual TO confirm for v1; **FUMBBL match-page scraping scoped as a
  later upgrade** on top of it.
- **D7 — client pinning:** git-tag dependency (§1.3).
- **D8 — entry UI:** interim header mode toggle (Spectate | Play | Tournament) is fine before the
  M3 StartMenu; migrates into StartMenu when M3 lands.
