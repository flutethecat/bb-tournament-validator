/**
 * File layer for the config pane. Reads/writes the SAME files the bot uses so
 * changes are instantly live: tournament-packages/*.json (the bot hot-loads the
 * directory) and the bot's validated-rosters.csv (the coaches dashboard).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadPackage, type DeepPartial, type SkillMeta, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { libraryCoaches, readLibrary, type LibraryTeam } from "@bb/fork-ops";

// ---------- skills ----------

export interface SkillRow {
  name: string;
  category: string;
  elite: boolean;
}

/** BB2025 team list (name + suggested tier) for tier configuration. */
export function teamList() {
  return bb2025.teams;
}

export type AdminTeamSearchMode = "name" | "id" | "coach";

export interface AdminTeamSearchRow {
  teamId: string;
  name: string;
  coach: string;
  roster?: string;
  status?: string;
}

const normalizedSearchValue = (value: unknown): string => String(value ?? "").trim().toLowerCase();

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = previous[0]!;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = previous[rightIndex]!;
      previous[rightIndex] = Math.min(
        above + 1,
        previous[rightIndex - 1]! + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

function textMatchRank(value: string, query: string): number | undefined {
  if (value === query) return 0;
  if (value.startsWith(query)) return 100 + value.length;
  const wordIndex = value.split(/\s+/).findIndex((word) => word.startsWith(query));
  if (wordIndex >= 0) return 200 + wordIndex + value.length;
  const substringIndex = value.indexOf(query);
  return substringIndex >= 0 ? 300 + substringIndex + value.length : undefined;
}

/** Rank already-normalized stored-team rows for the admin search endpoint. */
export function rankAdminTeamSearch(
  rows: readonly AdminTeamSearchRow[],
  rawQuery: string,
  mode: AdminTeamSearchMode,
): AdminTeamSearchRow[] {
  const query = normalizedSearchValue(rawQuery);
  if (!query) return [];

  const scored = rows.flatMap((row, index) => {
    const name = normalizedSearchValue(row.name);
    const teamId = normalizedSearchValue(row.teamId);
    const coach = normalizedSearchValue(row.coach);
    let score: number | undefined;
    if (mode === "id") {
      const textRank = textMatchRank(teamId, query);
      score = textRank ?? 1_000 + editDistance(teamId, query) * 100 + Math.abs(teamId.length - query.length);
    } else {
      score = textMatchRank(mode === "coach" ? coach : name, query);
    }
    return score === undefined ? [] : [{ row, score, index, coach }];
  });

  // An exact coach query means one coach's complete library, never similarly named coaches.
  const exactCoach = mode === "coach" && scored.some((entry) => entry.coach === query);
  return scored
    .filter((entry) => !exactCoach || entry.coach === query)
    .sort((left, right) =>
      left.score - right.score ||
      left.row.name.localeCompare(right.row.name, undefined, { sensitivity: "base" }) ||
      left.row.teamId.localeCompare(right.row.teamId, undefined, { numeric: true }) ||
      left.index - right.index,
    )
    .slice(0, mode === "coach" ? undefined : 50)
    .map((entry) => entry.row);
}

function adminSearchRow(team: LibraryTeam, coachKey: string): AdminTeamSearchRow | undefined {
  const teamId = String(team?.teamId ?? "").trim();
  const name = String(team?.teamName ?? "").trim();
  const coach = String(team?.coach ?? "").trim() || coachKey;
  if (!teamId || !name || !coach) return undefined;
  return {
    teamId,
    name,
    coach,
    ...(team.race ? { roster: team.race } : {}),
    status: team.retired ? "retired" : team.forkLoadable ? "loaded" : "not loaded",
  };
}

/** Read every stored fork library defensively; a missing/unreadable store is an empty index. */
export function searchStoredAdminTeams(
  libraryDir: string,
  query: string,
  mode: AdminTeamSearchMode,
): AdminTeamSearchRow[] {
  try {
    const rows = libraryCoaches(libraryDir).flatMap((coachKey) =>
      readLibrary(libraryDir, coachKey).flatMap((team) => {
        const row = adminSearchRow(team, coachKey);
        return row ? [row] : [];
      }),
    );
    return rankAdminTeamSearch(rows, query, mode);
  } catch {
    return [];
  }
}

/** Star player names (+ teams, cost) for the banned-star autocomplete. */
export function starList() {
  return bb2025.stars;
}

/** All selectable BB2025 skills (traits excluded), split Elite vs General. */
export function skillCatalog(): { elite: SkillRow[]; general: SkillRow[] } {
  const elite: SkillRow[] = [];
  const general: SkillRow[] = [];
  for (const [name, meta] of Object.entries(bb2025.skills as Record<string, SkillMeta>)) {
    if (meta.trait || !meta.category) continue;
    const row: SkillRow = { name, category: meta.category, elite: !!meta.elite };
    (meta.elite ? elite : general).push(row);
  }
  const byName = (a: SkillRow, b: SkillRow) => a.name.localeCompare(b.name);
  return { elite: elite.sort(byName), general: general.sort(byName) };
}

// ---------- packages ----------

export class PackageFiles {
  constructor(private readonly dir: string) {}

  private raws(): Map<string, Partial<TournamentPackage>> {
    const out = new Map<string, Partial<TournamentPackage>>();
    if (!existsSync(this.dir)) return out;
    for (const file of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, file), "utf8")) as Partial<TournamentPackage>;
        out.set(raw.name ?? basename(file, ".json"), raw);
        out.set(basename(file, ".json"), raw);
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  }

  list(): { name: string; date?: string; description?: string }[] {
    const seen = new Set<string>();
    const rows: { name: string; date?: string; description?: string }[] = [];
    for (const raw of this.raws().values()) {
      const name = raw.name ?? "(unnamed)";
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({ name, date: raw.date, description: raw.description });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): { pkg: TournamentPackage; problems: string[] } | undefined {
    const raws = this.raws();
    const raw =
      raws.get(name) ?? [...raws.entries()].find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    if (!raw) return undefined;
    return loadPackage(raw, { resolveExtends: (n) => raws.get(n) });
  }

  /** Validate + normalize + write. Returns the saved file path. */
  save(input: DeepPartial<TournamentPackage>): { path: string; pkg: TournamentPackage; problems: string[] } {
    const { pkg, problems } = loadPackage(input);
    mkdirSync(this.dir, { recursive: true });
    const stem = (pkg.name || "package").replace(/[^\w.-]+/g, "-").toLowerCase();
    const path = join(this.dir, `${stem}.json`);
    writeFileSync(path, JSON.stringify(pkg, null, 2), "utf8");
    return { path, pkg, problems };
  }
}

// ---------- coaches (validated-rosters.csv) ----------

export interface CoachRow {
  discordUserId: string;
  coachName: string;
  teamName: string;
  rosterRace: string;
  packageName: string;
  messageLink: string;
  validatedAt: string;
}

function csvSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const FIELDS: (keyof CoachRow)[] = [
  "discordUserId",
  "coachName",
  "teamName",
  "rosterRace",
  "packageName",
  "messageLink",
  "validatedAt",
];

export function readCoaches(csvPath: string, packageName?: string): CoachRow[] {
  if (!existsSync(csvPath)) return [];
  const lines = readFileSync(csvPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = csvSplit(line);
    const row = {} as Record<keyof CoachRow, string>;
    FIELDS.forEach((f, i) => (row[f] = cells[i] ?? ""));
    return row as CoachRow;
  });
  return packageName ? rows.filter((r) => r.packageName === packageName) : rows;
}

// ---------- tournament coach registry (discord-bot's coaches.json) ----------

/**
 * Mirrors `apps/discord-bot/src/store/coachRegistry.ts`'s `CoachEntry` shape. Read-only
 * here and deliberately NOT imported from the discord-bot package: this reads the same
 * JSON file the bot's `FileCoachRegistry` owns (same pattern as `VALIDATED_CSV` already
 * pointing into discord-bot/data-store), so the users panel sees the bot's live data
 * without config-web taking a code dependency on the bot app.
 */
export interface CoachRegistryEntry {
  id: string;
  discordUserId?: string;
  fumbblName?: string;
  nafName?: string;
  nafId?: string;
  teams: { tournament: string; teamName: string; rosterRace: string }[];
  updatedAt: string;
}

export function readCoachRegistry(jsonPath: string): CoachRegistryEntry[] {
  if (!existsSync(jsonPath)) return [];
  try {
    return JSON.parse(readFileSync(jsonPath, "utf8")) as CoachRegistryEntry[];
  } catch {
    return [];
  }
}
