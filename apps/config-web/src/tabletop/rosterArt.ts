import { addedSkills, findPosition, isStarName } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { readManifest, resolveSprite, safeArt, skillCategory, type SpriteManifest } from "../teamShareView.js";
import { rosterFor } from "./pregame.js";
import type { TabletopTeamFile } from "./postMatch.js";
import { positionStats } from "./teamFile.js";

/** A skill with its dataset category ("General", "Agility", ..., or "Trait"), as the shared team view shows it. */
export interface RosterSkill { name: string; category: string }
/** Display-only extras the recorder's Rosters pane needs, composed from the same data the shared team view uses. */
export interface RosterArt {
  /** Art path inside the generated sprites folder (relative, never a URL), or absent when the pack has none. */
  sprite?: string;
  /** The position's own skills, then the ones the player gained. */
  printed?: RosterSkill[];
  added?: RosterSkill[];
  /** The position's printed characteristics (a stat above this is an advancement). */
  printedStats?: { ma: number; st: number; ag: number; pa: number | null; av: number };
}

const printedStatsOf = (ds: Parameters<typeof positionStats>[0]): NonNullable<RosterArt["printedStats"]> => {
  const { ma, st, ag, pa, av } = positionStats(ds);
  return { ma, st, ag, pa, av };
};

/**
 * The match GET's team files with sprite, printed / added skills (with category) and the position's printed
 * stats added to every player. `publicDir` is the folder holding the generated art manifests; without it (or
 * without a manifest) only the skills and stats are added.
 */
export function withRosterArt(file: TabletopTeamFile | undefined, publicDir?: string): TabletopTeamFile | undefined {
  if (!file) return file;
  const dsRoster = rosterFor(file);
  const raceName = dsRoster?.name ?? file.race ?? "";
  const sprites = publicDir ? readManifest<SpriteManifest>(publicDir, "sprites/manifest.json") : null;
  return {
    ...file,
    players: file.players.map((p) => {
      const posName = (p as { positionName?: string }).positionName ?? p.positionId ?? "";
      const star = isStarName(bb2025, posName) || isStarName(bb2025, p.positionId ?? "");
      const ds = dsRoster && !star
        ? dsRoster.positions.find((x) => x.id === p.positionId) ?? (posName ? findPosition(dsRoster, posName) : undefined)
        : undefined;
      const addedNames = ds ? addedSkills(ds, p.skills) : [];
      const printedNames = p.skills.filter((s) => !addedNames.includes(s));
      const sprite = safeArt(raceName && posName ? resolveSprite(sprites, raceName, ds?.name ?? posName) : null);
      const art: RosterArt = {
        ...(sprite ? { sprite } : {}),
        printed: printedNames.map((name) => ({ name, category: skillCategory(name) })),
        added: addedNames.map((name) => ({ name, category: skillCategory(name) })),
        ...(ds ? { printedStats: printedStatsOf(ds) } : {}),
      };
      return { ...p, ...art };
    }),
  };
}
