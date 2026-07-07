/**
 * The BB2025 dataset, bundled INSIDE the package (integration plan §1.4) so the
 * Discord bot, the tournament service, and the FUMBBL40k client can never
 * disagree on rules-data versions. Scope: all 30 BB2025 teams (from FUMBBL ruleset 3906).
 */

import type { Dataset, DatasetRoster, DatasetStar, DatasetTeam, SkillMeta } from "../types";
import rostersJson from "./rosters.json";
import skillsJson from "./skills.json";
import inducementsJson from "./inducements.json";
import teamsJson from "./teams.json";
import starsJson from "./stars.json";

/** Bumped whenever rules data changes; surfaced in ValidationResult for skew checks. */
export const DATASET_VERSION = "bb2025.5-inducements";

function buildDataset(): Dataset {
  const rosters: Record<string, DatasetRoster> = {};
  for (const raw of rostersJson.rosters) {
    const roster = raw as unknown as DatasetRoster;
    rosters[roster.name] = roster;
  }

  const skills: Record<string, SkillMeta> = {};
  for (const [name, meta] of Object.entries(skillsJson.skills)) {
    skills[name] = meta as SkillMeta;
  }

  const inducements: Dataset["inducements"] = {};
  for (const ind of inducementsJson.inducements as Array<Record<string, unknown>>) {
    inducements[ind.id as string] = {
      name: ind.name as string,
      cost: (ind.cost as number | null) ?? null,
      max: (ind.max as number | null) ?? null,
      reducedMax: (ind.reducedMax as number | null | undefined) ?? undefined,
      reducedCost: (ind.reducedCost as number | null | undefined) ?? undefined,
      reducedSpecialRule: (ind.reducedSpecialRule as string | undefined) ?? undefined,
    };
  }

  const teams = teamsJson.teams as DatasetTeam[];
  const stars = starsJson.stars as DatasetStar[];

  return { rosters, skills, inducements, teams, stars };
}

export const bb2025: Dataset = buildDataset();
