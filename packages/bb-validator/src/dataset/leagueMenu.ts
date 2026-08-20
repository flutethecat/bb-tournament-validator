import type { DatasetRoster } from "./types";

export const ALL_DEITIES = [
  "Favoured of Khorne",
  "Favoured of Nurgle",
  "Favoured of Hashut",
  "Favoured of Tzeentch",
  "Favoured of Slaanesh",
  "Favoured of Chaos Undivided",
] as const;

export const FAVOURED_MAP: Readonly<Record<string, readonly string[]>> = {
  "Chaos Dwarf": ["Favoured of Hashut"],
  Khorne: ["Favoured of Khorne"],
  Nurgle: ["Favoured of Nurgle"],
  "Chaos Chosen": ALL_DEITIES,
  "Chaos Renegade": ALL_DEITIES,
  Norse: ALL_DEITIES,
};

const ALWAYS_ON_RULES = new Set([
  "Bribery and Corruption",
  "Brawlin' Brutes",
  "Chaos Clash",
  "Low Cost Linemen",
  "Masters of Undeath",
  "Swarming",
  "Team Captain",
]);

export interface LeagueMenu {
  alwaysOn: string[];
  leagueOptions: string[];
}

/** Split roster mechanics from the one league affiliation selected for star eligibility. */
export function leagueMenuForRoster(
  roster: Pick<DatasetRoster, "name" | "specialRules">,
): LeagueMenu {
  const alwaysOn: string[] = [];
  const leagueOptions: string[] = [];
  for (const rule of roster.specialRules) {
    if (ALWAYS_ON_RULES.has(rule)) {
      alwaysOn.push(rule);
    } else if (rule === "Favoured of...") {
      leagueOptions.push(...(FAVOURED_MAP[roster.name] ?? []));
    } else {
      leagueOptions.push(rule);
    }
  }
  return { alwaysOn, leagueOptions: [...new Set(leagueOptions)] };
}
