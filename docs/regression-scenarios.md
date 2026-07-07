# Regression scenarios

End-to-end scenarios that exercise the whole validation + render + ingestion surface, so
cross-cutting changes (the resolver, tiers/matrix/team-rules, count mode, renderers) don't silently
break each other. Run everything with `pnpm test` from the repo root.

## How to run

```
pnpm test                                   # all suites (currently 123 tests)
pnpm exec vitest run packages/bb-validator/test/regression.test.ts   # just these scenarios
```

The core scenarios run against the **real bundled BB2025 dataset** and the **actual example-PDF
Amazon roster** (`fixtures/amazon-example.roster.json`) — i.e. production data, not stubs.

## Automated scenarios (`packages/bb-validator/test/regression.test.ts`)

| # | Scenario | Expected |
|---|----------|----------|
| R1 | Example Amazon vs a matching SP package (10 SP, 1.2M gold) | **valid** |
| R2 | Amazon (1.2M) vs a Tier-1 1.15M gold cap | gold-budget error tagged `(Tier 1)` |
| R3 | Matrix cell sets gold + primary count; 6 primary pass / 5 primary fail | pass at 6, fail at 5 tagged `(matrix)` |
| R4 | Team-rule gold overrides the flat `goldBudget` (precedence team > flat) | resolves to team gold; **valid** |
| R5 | Secondary Swap feasibility on real positions (2 secondaries vs 4-primary allotment) | **fits with swap**, **fails without** |
| R6 | Global banned star on the roster | banned-star error; **star is NOT mis-flagged as an unknown position** |
| R7 | Unknown race (Slann, absent from ruleset 3906) | graceful `dataset` error, `valid:false` |
| R8 | `renderPackageHtml` + `renderArtPrompt` for all four modes (flat / tiers / matrix / team-rules) | standalone HTML + prompt, both mention the teams |
| R9 | `loadPackage` normalizes a partial package (defaults filled, overrides kept) | budget/surcharge kept, defaults applied |
| R10 | Dataset breadth: all 30 teams resolve; Devious skill legal where a position has Devious access; Mutation skill illegal without access | breadth + category access correct |

## Covered by focused suites (also regression-relevant)

| Area | Suite | Scenarios |
|---|---|---|
| bbtc.pl PDF ingestion | `packages/bb-ingest/test/bbtcPdf.test.ts` | both example PDFs → golden `Roster`; non-bbtc bytes fail loudly |
| Rules-document + CSV package ingest | `packages/bb-ingest/test/packageDoc.test.ts` | labeled-line + CSV → package; unknown lines reported |
| `costSP` config | `packages/bb-validator/test/costSP.test.ts` | primary/secondary/elite/CSV precedence |
| Per-rule unit checks | `packages/bb-validator/test/rules.test.ts` | eligibility, squad size, positional limits, skill access/points, sideline, stars, special |
| Count model + swap + matrix + parseGold | `packages/bb-validator/test/matrix.test.ts` | `fitsSkillCounts`, matrix resolution, gold notation |
| Tiers | `packages/bb-validator/test/tiers.test.ts` | tier eligibility / gold / SP / stars / bans |
| Dataset gate | `packages/bb-validator/test/datasetGate.test.ts` | generated Amazon == example PDF |
| Renderers | `packages/bb-validator/test/{packageHtml,artPrompt}.test.ts` | HTML sections, escaping, prompt content |
| Bot stores | `apps/discord-bot/test/{stores,watchStore}.test.ts` | CSV escaping, upsert-latest-wins, key uniqueness, watch bindings |
| Config-web data | `apps/config-web/test/data.test.ts` | package save/load, skill catalog, coaches CSV |

## Findings from executing these

- **BUG FOUND + FIXED (R6):** the `positional-limits` rule flagged Star Players as "not a position on
  the roster" because stars live outside the dataset `positions[]` list (they're validated by the
  `star-players` rule). Any legal roster containing a star produced a spurious error. Fixed by
  skipping known stars (`isStarName`) in `positional-limits`. This is exactly the kind of
  cross-cutting break the end-to-end scenarios exist to catch.

## Manual / UI scenarios (not automated)

These need a browser (`pnpm --filter config-web start`) or a live Discord guild:

1. **Config pane mode exclusivity** — enabling Tiers, then Matrix, then Team Rules each disables the
   others and converts the current rules (gold/stars/bans carry; skills carry where representable).
   Saving writes only the active mode's field.
2. **Matrix editing** — add/remove columns and rows; drop teams into cells; columns stay capped and
   teams wrap; delete buttons remove col/row and return teams to the pool.
3. **Export / Art prompt buttons** — download the one-page HTML; generate + copy the art prompt.
4. **Live bot** — `/bbbot watch` a channel, drop a bbtc PDF → ✅ on the post + DM + CSV row;
   `/bbbot report`, `/bbbot export`, `/bbbot artprompt`, `/bbbot coach …`.
   ⚠ Known tooling gap this iteration: `preview_screenshot` (headless capture) has been unreliable,
   so UI verification has leaned on DOM/geometry inspection rather than images.
