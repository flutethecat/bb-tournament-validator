/**
 * File layer for the config pane. Reads/writes the SAME files the bot uses so
 * changes are instantly live: tournament-packages/*.json (the bot hot-loads the
 * directory) and the bot's validated-rosters.csv (the coaches dashboard).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadPackage, type DeepPartial, type SkillMeta, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";

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
