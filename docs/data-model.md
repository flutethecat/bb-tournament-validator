# Data model (TypeScript reference)

These are the interfaces the pure core (`bb-validator`) exposes. They are documentation for the
planned implementation; the actual `.ts` files live under `packages/bb-validator/src/` once built.
All are plain data (no methods, no I/O) so they cross the Node/webview boundary unchanged.

## Roster (output of `bb-ingest`)

```ts
export type Target = `${number}+`;           // e.g. "3+"  (AG/PA/AV in BB2025 target form)

export interface RosterPlayer {
  number: number;
  positionName: string;                       // matched to a dataset position (or alias)
  MA: number; ST: number;
  AG: Target; PA: Target; AV: Target;
  skills: string[];                           // as printed on the sheet
  baseSkills?: string[];                       // filled by validator via dataset diff
  addedSkills?: string[];                      // skills - baseSkills
  keywords: string[];
  cost: number;                                // gold, as printed
}

export interface Roster {
  rosterName: string;                          // race, e.g. "Amazon"
  coach: string;
  teamName: string;
  sideline: {
    apothecary: boolean;
    assistantCoaches: number;
    cheerleaders: number;
    dedicatedFans: number;
    reRolls: number;
  };
  inducements: { id?: string; name: string; count?: number; cost?: number }[];
  leagues: string[];
  specialRules: string[];
  players: RosterPlayer[];
  summary?: {                                  // if the source printed one (bbtc.pl does)
    playersCost: number; skillsCost: number; inducementCost: number;
    sidelineCost: number; total: number;
    primarySkills?: number; secondarySkills?: number;
  };
}
```

## Dataset (BB2025 rules data, injected)

```ts
export type SkillCategory = "General" | "Agility" | "Strength" | "Passing" | "Mutation";

export interface DatasetPosition {
  id: string; name: string; aliases?: string[];
  type: string;                                // lineman|thrower|blitzer|blocker|bigguy|...
  max: number; cost: number;
  MA: number; ST: number; AG: Target; PA: Target; AV: Target;
  skills: string[];                            // base skills
  primaryCategories: SkillCategory[];
  secondaryCategories: SkillCategory[];
  keywords: string[];
}

export interface DatasetRoster {
  id: string; name: string; tier?: number;
  specialRules: string[];
  reRollCost: number; maxReRolls: number;
  apothecaryAllowed: boolean; maxBigGuys: number;
  positions: DatasetPosition[];
  starPlayers: { name: string; cost: number }[];
}

export interface SkillMeta { category?: SkillCategory; elite?: boolean; trait?: boolean }

export interface Dataset {
  rosters: Record<string, DatasetRoster>;      // keyed by race name (and aliases)
  skills: Record<string, SkillMeta>;
  inducements: Record<string, { name: string; cost: number | null; max: number | null }>;
}
```

## TournamentPackage

See `schemas/tournament-package.schema.json` for the authoritative shape and
`docs/tournament-package.md` for the costing semantics. The TS type mirrors that schema.

## Skill-point cost function

```ts
export interface SkillCostConfig {
  primaryCostSP: number;            // default 1
  secondaryMultiplier: number;      // default 2
  secondaryCostSP?: number | null;  // overrides multiplier if set
  eliteSurchargeSP: number;         // default 1
  eliteSkills: string[];            // default ["Block","Guard","Mighty Blow","Dodge"]
  skillCostSP: Record<string, number>; // per-skill overrides (highest precedence)
}

export type Access = "primary" | "secondary" | "illegal";

export function costSP(skill: string, access: Access, cfg: SkillCostConfig): number {
  if (skill in cfg.skillCostSP) return cfg.skillCostSP[skill];      // explicit override wins
  const base = access === "secondary"
    ? (cfg.secondaryCostSP ?? cfg.primaryCostSP * cfg.secondaryMultiplier)
    : cfg.primaryCostSP;
  const elite = cfg.eliteSkills.includes(skill) ? cfg.eliteSurchargeSP : 0;
  return base + elite;
}
```

## ValidationResult

```ts
export type Severity = "error" | "warning" | "info";

export interface Finding {
  ruleId: string;
  severity: Severity;
  playerRef?: number;              // player number, when player-specific
  message: string;                 // human-readable, the product
  expected?: string | number;
  actual?: string | number;
  suggestion?: string;             // how to fix, e.g. "drop Guard, or raise SP budget to 7"
}

export interface ValidationResult {
  valid: boolean;                  // no errors
  errors: Finding[];
  warnings: Finding[];
  infos: Finding[];
  recomputedSummary: {
    skillPointsUsed: number;
    skillPointBudget: number;
    goldUsed?: number;
    goldBudget?: number | null;
    playerCount: number;
  };
}

export function validate(roster: Roster, pkg: TournamentPackage, data: Dataset): ValidationResult;
```

## Validated-roster store (bot side)

```ts
export interface ValidatedEntry {
  discordUserId: string; coachName: string; teamName: string;
  rosterRace: string; packageName: string;
  messageLink: string;             // https://discord.com/channels/<guild>/<channel>/<message>
  validatedAt: string;             // ISO 8601
}

export interface ValidatedStore {                    // CSV impl for now, DB later
  upsert(entry: ValidatedEntry): Promise<void>;      // latest wins per discordUserId+packageName
  list(packageName?: string): Promise<ValidatedEntry[]>;
}
```
