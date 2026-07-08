/**
 * FUMBBL team fetching / fork team-file handling — shared by the Discord bot's
 * `/bbbot 40k copyteam` and config-web's `/api/fork/library/ingest` (lifted here from
 * the bot's fork40k.ts once both apps needed it, per the "is this genuinely shared?"
 * test). Node-specific (fs + fetch), which is fine — this package already isn't
 * browser-safe (it depends on mysql2).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { xmlEscape, safe } from "./util.js";
import type { ForkConfig } from "./index.js";
import type { LibraryTeam } from "./library.js";
import { upsertLibraryTeam } from "./library.js";

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
 *
 * `opts.asCoach` re-coaches the saved XML to that coach (used by the library ingest so
 * the requesting coach — not the team's original FUMBBL owner — can join with it).
 */
export async function copyForkTeam(cfg: ForkConfig, url: string, opts?: { asCoach?: string }): Promise<CopiedTeam> {
  const t = await fetchForkTeam(url);
  const owner = opts?.asCoach?.trim() || t.coach;
  const xml = recoachXml(t.xml, owner);
  mkdirSync(cfg.teamsDir, { recursive: true });
  const path = join(cfg.teamsDir, `team_${safe(owner)}_${t.teamId}.xml`);
  writeFileSync(path, xml, "utf8");
  let raceWarning: string | undefined;
  if (t.raceName && !forkSupportsRace(t.raceName, forkRosterNames(cfg.teamsDir))) {
    raceWarning = `No fork roster matches "${t.raceName}" — this team likely won't load/play correctly until that roster is imported on the fork.`;
  }
  return { teamId: t.teamId, teamName: t.teamName, coach: owner, path, raceWarning };
}

/** Rewrite the <coach> in a team XML export (plain-text element; XML-escaped). No-op if absent. */
export function recoachXml(xml: string, coach: string): string {
  return xml.replace(/<coach>[^<]*<\/coach>/i, `<coach>${xmlEscape(coach)}</coach>`);
}

/**
 * Parse the roster-card metadata off a FUMBBL team XML export. `teamValue` is
 * normalized to "thousands" (raw currentTeamValue ÷ 1000 when it's clearly in gold,
 * i.e. ≥ 10000) to match the client's expected TV display; `gold` (treasury) stays raw.
 * BB2025 exports carry <dedicatedFans>; older ones <fanFactor> — accept either.
 */
export function parseTeamXmlMeta(xml: string): {
  teamValue: number;
  gold: number;
  rerolls?: number;
  fanFactor?: number;
  apothecary?: boolean;
} {
  const num = (tag: string): number | undefined => {
    const m = xml.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, "i"));
    return m ? Number(m[1]) : undefined;
  };
  const rawTv = num("currentTeamValue") ?? num("teamValue") ?? 0;
  const teamValue = rawTv >= 10000 ? Math.round(rawTv / 1000) : rawTv;
  const gold = num("treasury") ?? 0;
  const apo = num("apothecaries");
  return {
    teamValue,
    gold,
    rerolls: num("reRolls"),
    fanFactor: num("fanFactor") ?? num("dedicatedFans"),
    apothecary: apo == null ? undefined : apo > 0,
  };
}

/**
 * Full library ingest: fetch a FUMBBL team, re-coach it to `requestingCoach`, save its
 * XML into the fork's teams dir, compute fork-load compatibility, and upsert a
 * LibraryTeam row into `libDir`. Returns the row plus a race warning and a
 * `needsRestart` flag (a newly-written team file only becomes joinable after the FFB
 * server restarts — the fork has no hot team-cache reload; see the resume-prompt notes).
 */
export async function ingestForkTeam(
  cfg: ForkConfig,
  libDir: string,
  requestingCoach: string,
  teamUrl: string,
): Promise<{ team: LibraryTeam; raceWarning?: string; needsRestart: boolean }> {
  const coach = requestingCoach.trim();
  if (!coach) throw new Error("A coach name is required.");
  const t = await fetchForkTeam(teamUrl);
  const meta = parseTeamXmlMeta(t.xml);
  mkdirSync(cfg.teamsDir, { recursive: true });
  const xml = recoachXml(t.xml, coach);
  const path = join(cfg.teamsDir, `team_${safe(coach)}_${t.teamId}.xml`);
  writeFileSync(path, xml, "utf8");

  const forkLoadable = !t.raceName || forkSupportsRace(t.raceName, forkRosterNames(cfg.teamsDir));
  const raceWarning =
    t.raceName && !forkLoadable
      ? `No fork roster matches "${t.raceName}" — this team likely won't load/play correctly until that roster is imported on the fork.`
      : undefined;

  const team: LibraryTeam = {
    teamId: t.teamId,
    teamName: t.teamName,
    race: t.raceName ?? "Unknown",
    coach,
    teamValue: meta.teamValue,
    gold: meta.gold,
    rerolls: meta.rerolls,
    fanFactor: meta.fanFactor,
    apothecary: meta.apothecary,
    forkLoadable,
    ingestedAt: new Date().toISOString(),
  };
  upsertLibraryTeam(libDir, coach, team);
  return { team, raceWarning, needsRestart: true };
}
