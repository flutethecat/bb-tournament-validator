# Architecture

## Monorepo layout (planned)

```
bb-tournament-validator/            (pnpm workspaces)
├─ packages/
│  ├─ bb-validator/   # PURE portable TS core — reused by the PixiJS/Tauri client
│  │   src/model/     #   normalized Roster, ValidationResult types
│  │   src/package/   #   TournamentPackage schema (zod) + loadPackage() resolver
│  │   src/cost/      #   costSP() — the configurable Skill-Point cost function
│  │   src/rules/     #   one file per rule + a registry + runRules()
│  │   src/dataset/   #   dataset types + in-memory lookups (data INJECTED, never read from disk)
│  ├─ bb-data/        # generated BB2025 dataset JSON + dev-time conversion/reconciliation scripts
│  │   data/…         #   (mirrors the /data folder in this repo)
│  │   scripts/convertXml.ts, scripts/reconcile.ts   (Node, dev-only)
│  └─ bb-ingest/      # roster + package ingestion adapters (Node side; pdfjs-dist)
│      src/roster/    #   RosterSource adapters: bbtc.pl (M2), bbroster (M4), BB3-json/ocr (M6)
│      src/package/   #   PackageSource adapters: rules-document parser, CSV skill-cost loader
└─ apps/
   └─ discord-bot/    # discord.js: slash cmds, attachment download, embeds, stores
```

## Data flow

```
Discord attachment (PDF)
        │  apps/discord-bot downloads bytes
        ▼
bb-ingest.RosterSource  ──►  Roster            (normalized, no I/O beyond parsing)
                                   │
packages/*.json ─► bb-validator.loadPackage ─► TournamentPackage
data/bb2025/*   ─────────────────────────────► Dataset
                                   ▼
        bb-validator.validate(roster, package, dataset)  →  ValidationResult
                                   │
        apps/discord-bot renders embed + side effects (✅ / DM / CSV / report)
```

## Portability guardrails (the whole point)

The FUMBBL40k client runs TS in a **Tauri webview** (a browser engine), not Node. Therefore:

- **`bb-validator` must not import** `fs`, `path`, `Buffer`, `process`, `pdfjs`, `discord.js`, or any
  Node built-in. It receives already-parsed `Roster`, `TournamentPackage`, and `Dataset` **objects**.
- All file/PDF/OCR/Discord/network I/O lives in `bb-ingest` and `apps/discord-bot` (Node) — or, in
  the client, in a thin Tauri/webview adapter that hands the core the same object shapes.
- Enforce with an ESLint `no-restricted-imports` rule + a CI check that `bb-validator` builds for a
  browser target with zero Node polyfills.
- `bb-validator` ships its dataset as importable JSON, not via disk reads, so it bundles cleanly.

## Why this shape

- **One core, many front-ends.** The Discord bot and the PixiJS client call the identical
  `validate()` and get identical results/messages.
- **Rules are isolated pure functions** in `src/rules/`, registered in a list the runner iterates, so
  each is independently unit-testable and the client can subset which rules it runs.
- **Ingestion is adapter-based** (`RosterSource` / `PackageSource`) so new formats (bbroster,
  BB3 JSON export, OCR'd screenshots) plug in without touching validation.
- **Stores are interfaces** (`ValidatedStore`) with a CSV implementation now, swappable for a DB later
  without changing bot logic.
