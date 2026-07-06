/**
 * The BB2025 dataset, bundled INSIDE the package (integration plan §1.4) so the
 * Discord bot, the tournament service, and the FUMBBL40k client can never
 * disagree on rules-data versions. M1 scope: Amazon only.
 */

import type { Dataset, DatasetRoster, SkillMeta } from "../types";
import amazonJson from "./rosters/amazon.json";
import skillsJson from "./skills.json";
import inducementsJson from "./inducements.json";

/** Bumped whenever rules data changes; surfaced in ValidationResult for skew checks. */
export const DATASET_VERSION = "bb2025.1-amazon";

function buildDataset(): Dataset {
  const rosters: Record<string, DatasetRoster> = {};
  for (const raw of [amazonJson]) {
    const roster = raw as unknown as DatasetRoster;
    rosters[roster.name] = roster;
  }

  const skills: Record<string, SkillMeta> = {};
  for (const [name, meta] of Object.entries(skillsJson.skills)) {
    skills[name] = meta as SkillMeta;
  }

  const inducements: Dataset["inducements"] = {};
  for (const ind of inducementsJson.inducements) {
    inducements[ind.id] = { name: ind.name, cost: ind.cost ?? null, max: ind.max ?? null };
  }

  return { rosters, skills, inducements };
}

export const bb2025: Dataset = buildDataset();
