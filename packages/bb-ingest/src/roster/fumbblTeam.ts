/**
 * FUMBBL team JSON (https://fumbbl.com/api/team/get/{id}) → our Roster model.
 * The M6 "JSON → Roster" adapter seam (rosterSource.ts), used by /bbbot validate
 * fumbbl-team:<id>. Pure conversion — the network fetch lives in the consumer.
 *
 * FUMBBL's team JSON omits per-player stats/cost (they live on the roster), so we
 * fill MA/ST/AG/PA/AV, cost and keywords from the bundled BB2025 dataset position;
 * skills (base + earned) come from the team. No rule reads printed player stats —
 * the validator resolves everything from the dataset — so this stays authoritative.
 */

import {
  findPosition,
  findRoster,
  findStar,
  isStarName,
  type Dataset,
  type Roster,
  type RosterPlayer,
} from "@bb/validator";

/** The subset of FUMBBL's team JSON we read. Deliberately tolerant. */
export interface FumbblTeam {
  name?: string;
  coach?: string | { name?: string };
  roster?: string | { name?: string };
  rerolls?: number;
  apothecary?: string | boolean;
  assistantCoaches?: number;
  cheerleaders?: number;
  dedicatedFans?: number | null;
  /** Legacy field; falls back to dedicated fans when the newer one is absent. */
  fanFactor?: number | null;
  /** FUMBBL returns `[]` when empty but a name-keyed object when populated. */
  specialRules?: (string | { name?: string })[] | Record<string, unknown>;
  players?: FumbblPlayer[];
}

export interface FumbblPlayer {
  number?: number;
  name?: string;
  position?: string;
  skills?: string[];
}

export interface FumbblConversion {
  roster?: Roster;
  problems: string[];
}

/** Read a name from a FUMBBL field that may be a bare string or a {name} object. */
function nameOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "name" in v) return String((v as { name?: unknown }).name ?? "");
  return "";
}

/** FUMBBL serializes team special rules as `[]` when empty but a name-keyed object when populated. */
function specialRuleNames(sr: FumbblTeam["specialRules"]): string[] {
  if (!sr) return [];
  if (Array.isArray(sr)) return sr.map(nameOf).filter(Boolean);
  return Object.keys(sr);
}

export function fumbblTeamToRoster(team: FumbblTeam, data: Dataset): FumbblConversion {
  const problems: string[] = [];
  const rosterName = nameOf(team.roster);
  if (!rosterName) return { problems: ["FUMBBL team has no roster/race — cannot validate."] };

  const dsRoster = findRoster(data, rosterName);
  if (!dsRoster)
    problems.push(`Roster "${rosterName}" is not in the BB2025 dataset — stats/costs may be incomplete.`);

  const players: RosterPlayer[] = [];
  for (const p of team.players ?? []) {
    const positionName = p.position ?? "";
    const skills = p.skills ?? [];
    const number = p.number ?? players.length + 1;
    const pos = dsRoster ? findPosition(dsRoster, positionName) : undefined;
    if (pos) {
      players.push({
        number,
        positionName,
        MA: pos.MA,
        ST: pos.ST,
        AG: pos.AG,
        PA: pos.PA,
        AV: pos.AV,
        skills,
        keywords: [...pos.keywords],
        cost: pos.cost,
      });
    } else {
      const star = isStarName(data, positionName) ? findStar(data, positionName) : undefined;
      if (!star && positionName)
        problems.push(`Unknown position "${positionName}" (#${number}) in ${rosterName} — included with zero cost.`);
      players.push({
        number,
        positionName,
        MA: 0,
        ST: 0,
        AG: "-",
        PA: "-",
        AV: "-",
        skills,
        keywords: [],
        cost: star?.cost ?? 0,
      });
    }
  }
  if (players.length === 0) return { problems: [...problems, "FUMBBL team has no players."] };

  const roster: Roster = {
    rosterName,
    coach: nameOf(team.coach),
    teamName: team.name ?? "",
    sideline: {
      apothecary: team.apothecary === true || team.apothecary === "Yes",
      assistantCoaches: team.assistantCoaches ?? 0,
      cheerleaders: team.cheerleaders ?? 0,
      dedicatedFans: team.dedicatedFans ?? team.fanFactor ?? 0,
      reRolls: team.rerolls ?? 0,
    },
    inducements: [],
    leagues: [],
    specialRules: specialRuleNames(team.specialRules),
    players,
  };
  return { roster, problems };
}
