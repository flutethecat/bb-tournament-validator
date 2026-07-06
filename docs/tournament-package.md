# Authoring a tournament package

A **tournament package** is the rule set a roster is validated against. It is a JSON (or YAML) file
matching [`schemas/tournament-package.schema.json`](../schemas/tournament-package.schema.json). It can
also be produced by ingesting a formatted rules document plus an optional CSV skill-cost sheet.

Config is resolved in **precedence order**: `package.skillCostSP` (inline) → ingested CSV →
category defaults in the package → built-in BB2025 defaults. A package may `extends` a base package
(e.g. `bb2025-default`) and override only what it changes.

## The Skill-Point (SP) costing model

Teams spend **Skill Points** on the skills they ADD to players (base positional skills are free).
Every number below is a package field and can be changed per tournament.

| Field | Default | Meaning |
|-------|---------|---------|
| `skillPointBudget` | — | Total SP a team may spend on added skills. |
| `primaryCostSP` | `1` | Cost of a skill taken from a **primary** category. |
| `secondaryMultiplier` | `2` | Secondary (doubles) SP = `primaryCostSP × this`. |
| `secondaryCostSP` | `null` | Flat SP for a secondary skill; overrides the multiplier. |
| `eliteSurchargeSP` | `1` | Extra SP for a skill in the **Elite** set. |
| `eliteSkills` | `["Block","Guard","Mighty Blow","Dodge"]` | The effective Elite set. |
| `skillCostSP` | `{}` | Per-skill overrides (highest precedence). |
| `maxPerPlayer` | `2` | Max added skills on one player. |
| `maxSameSkillTeamwide` | `null` | Max copies of one added skill across the team. |

**Cost function** (see `docs/data-model.md` for the code):

```
costSP(skill, access) =
    skillCostSP[skill]                                        if defined
  else (access == secondary ? primaryCostSP*secondaryMultiplier : primaryCostSP)
       + (eliteSkills.includes(skill) ? eliteSurchargeSP : 0)
```

`access` is `primary` / `secondary` / `illegal`, decided by whether the skill's category is in the
player's position `primaryCategories` / `secondaryCategories` (from the roster dataset). An `illegal`
access is a hard error regardless of budget.

### Worked example (the supplied Amazon PDF)

Added skills: `Block, Block, Block, Guard, Wrestle, Leader` — all in their positions' primary
categories. With defaults:

| Skill | Elite? | Access | SP |
|-------|--------|--------|----|
| Block × 3 | yes | primary | 2 each → 6 |
| Guard | yes | primary | 2 |
| Wrestle | no | primary | 1 |
| Leader | no | primary | 1 |
| **Total** | | | **10 SP** |

So [`lustrian-superleague.example.json`](../tournament-packages/lustrian-superleague.example.json) sets
`skillPointBudget: 10` and the example roster is **legal** (exactly on budget). Set it to `8` and the
same roster fails with, e.g.: *"Team is 2 SP over budget (10/8). Suggestion: drop one Block (−2 SP)."*

## Overriding costs from CSV

`data/skill-costs.example.csv` (columns `skill,costSP,elite`) lets a TO price individual skills or
tweak the Elite set without editing JSON. Empty (header-only) = use package defaults.

## Other constraints a package controls

- **`eligibleRosters`** (+ optional `tiers`) — which races may play.
- **`goldBudget`** — optional parallel gold cap (null = SP-only tournament).
- **`starPlayers`** — allowed / max count / max combined cost.
- **`inducements`** — allowed ids (`['*']`/`[]`) and per-inducement caps.
- **`sideline`** — max re-rolls, apothecary, cheerleaders, assistant coaches, dedicated fans.
- **`special`** — Insignificant-trait constraint, stalling, Slann, stat increases, `bannedSkills`,
  `minPlayers`.

## Validation output

The validator returns structured `errors` / `warnings` / `infos`, each with a human-readable
`message` and — where fixable — a `suggestion`. The Discord bot renders these as an embed; on a fully
valid roster it reacts ✅, DMs the coach, and records them (see `docs/architecture.md`).
