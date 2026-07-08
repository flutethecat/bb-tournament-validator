/**
 * FUMBBL40k fork provisioning — the `/bbbot 40k` admin commands. This is the ONLY
 * place the bot touches the fork's MariaDB or writes team files, and it only works
 * when the bot runs on the fork host (DB + teams dir are local there).
 *
 * Config comes from env (see .env.example: FORK_DB_*, FORK_TEAMS_DIR); when unset,
 * the commands report that fork provisioning isn't configured rather than crashing.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildForkJnlp,
  createForkAccount,
  forkConfigFromEnv,
  jnlpFilename,
  type ForkConfig,
} from "@bb/fork-ops";

export { buildForkJnlp, createForkAccount, forkConfigFromEnv, jnlpFilename, type ForkConfig };

export interface CopiedTeam {
  teamId: string;
  teamName: string;
  coach: string;
  path: string;
  /** Set when the team's race has no matching roster loaded on the fork. */
  raceWarning?: string;
}

/** Pull a FUMBBL team id from a /t/<id> URL (or a bare id / ?id=<id>). */
export function parseTeamId(input: string): string | undefined {
  const s = String(input).trim();
  return (s.match(/\/t\/(\d+)/) ?? s.match(/[?&]id=(\d+)/) ?? s.match(/(\d+)\s*$/) ?? s.match(/^(\d+)$/))?.[1];
}

/** Filesystem-safe token (prevents path traversal from an external coach name). */
const safe = (s: string): string => s.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "unknown";

export interface ForkTeam {
  teamId: string;
  teamName: string;
  coach: string;
  /** The team's race/roster name, e.g. "Khorne" (from FUMBBL's team API, best-effort). */
  raceName?: string;
  xml: string;
}

/** Fetch a FUMBBL team from a /t/<id> URL (or id) and pull its coach + name. */
export async function fetchForkTeam(url: string): Promise<ForkTeam> {
  const teamId = parseTeamId(url);
  if (!teamId) throw new Error(`Couldn't find a team id in "${url}" — expected https://fumbbl.com/t/<id>.`);
  const res = await fetch(`https://fumbbl.com/xml:team?id=${teamId}`, { headers: { accept: "application/xml" } });
  if (!res.ok) throw new Error(`FUMBBL xml:team ${teamId}: HTTP ${res.status}.`);
  const xml = await res.text();
  const coach = (xml.match(/<coach>([^<]*)<\/coach>/i)?.[1] ?? "").trim();
  const teamName = (xml.match(/<name>([^<]*)<\/name>/i)?.[1] ?? "").trim();
  if (!coach) throw new Error(`No <coach> found in the team XML for ${teamId} (private team or wrong id?).`);
  // Race name isn't in the team XML export — pull it from the JSON team API (best-effort;
  // only used for the fork-roster-support warning below, so a failure here isn't fatal).
  let raceName: string | undefined;
  try {
    const jr = await fetch(`https://fumbbl.com/api/team/get/${teamId}`, { headers: { accept: "application/json" } });
    if (jr.ok) raceName = ((await jr.json()) as { roster?: { name?: string } }).roster?.name;
  } catch {
    /* best-effort */
  }
  return { teamId, teamName, coach, raceName, xml };
}

/** Names of the rosters the fork server currently has loaded (sibling `rosters/` dir next to `teams/`). */
export function forkRosterNames(teamsDir: string): string[] {
  const rostersDir = join(dirname(teamsDir), "rosters");
  if (!existsSync(rostersDir)) return [];
  const names: string[] = [];
  for (const f of readdirSync(rostersDir).filter((f) => f.endsWith(".xml"))) {
    try {
      const m = readFileSync(join(rostersDir, f), "utf8").match(/<name>([^<]*)<\/name>/i);
      if (m) names.push(m[1]!.trim());
    } catch {
      /* skip unreadable */
    }
  }
  return names;
}

const normRace = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, " ").trim();

/**
 * BB2025 race name -> the fork's legacy roster name, for cases that aren't an exact
 * match after normalization. Deliberately a CURATED list, not fuzzy substring
 * matching: a naive "does either name contain the other" check false-positives
 * badly here (fork's generic "Orc" roster is a substring of "Black Orc" but is a
 * completely different roster) — that would silently hide exactly the gap this
 * check exists to catch. Add entries as the fork's roster set changes.
 */
const RACE_ALIASES: Record<string, string> = {
  "underworld denizens": "underworld",
  "shambling undead": "undead",
  "necromantic horror": "necromantic",
  "chaos chosen": "chaos",
  "elven union": "elf",
  lizardmen: "lizardman",
};

/** Does the fork have a roster that plausibly matches the given BB2025 race name? */
export function forkSupportsRace(raceName: string, rosterNames: string[]): boolean {
  const want = normRace(raceName);
  const have = new Set(rosterNames.map(normRace));
  if (have.has(want)) return true;
  const alias = RACE_ALIASES[want];
  return alias != null && have.has(alias);
}

/**
 * Fetch a FUMBBL team's XML and save it into the fork's teams dir as
 * `team_<coach>_<id>.xml`. The FFB game server must restart to load new team files.
 * Warns (doesn't block) when the team's race has no matching roster loaded on the
 * fork — the fork's roster set predates BB2025 and some races aren't imported yet.
 */
export async function copyForkTeam(cfg: ForkConfig, url: string): Promise<CopiedTeam> {
  const t = await fetchForkTeam(url);
  mkdirSync(cfg.teamsDir, { recursive: true });
  const path = join(cfg.teamsDir, `team_${safe(t.coach)}_${t.teamId}.xml`);
  writeFileSync(path, t.xml, "utf8");
  let raceWarning: string | undefined;
  if (t.raceName && !forkSupportsRace(t.raceName, forkRosterNames(cfg.teamsDir))) {
    raceWarning = `No fork roster matches "${t.raceName}" — this team likely won't load/play correctly until that roster is imported on the fork.`;
  }
  return { teamId: t.teamId, teamName: t.teamName, coach: t.coach, path, raceWarning };
}
