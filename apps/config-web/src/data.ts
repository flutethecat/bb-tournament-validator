/**
 * File layer for the config pane. Reads/writes the SAME files the bot uses so
 * changes are instantly live: tournament-packages/*.json (the bot hot-loads the
 * directory) and the bot's validated-rosters.csv (the coaches dashboard).
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/** Every roster's positions (name, type, dataset keywords) for the Tournament Creator's stat-increase rules picker. */
export function positionList(): Array<{ race: string; positions: Array<{ name: string; type: string; keywords: string[] }> }> {
  return Object.values(bb2025.rosters)
    .map((r) => ({ race: r.name, positions: r.positions.map((p) => ({ name: p.name, type: p.type, keywords: [...(p.keywords ?? [])] })) }))
    .sort((a, b) => a.race.localeCompare(b.race));
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

/** Every trait in the dataset (the custom star creator prints them on a star: Loner, Take Root...). */
export function traitCatalog(): SkillRow[] {
  return Object.entries(bb2025.skills as Record<string, SkillMeta>)
    .filter(([, meta]) => meta.trait)
    .map(([name, meta]) => ({ name, category: meta.category ?? "Trait", elite: false }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- packages ----------

/** A save refused because it would clobber something: another package's file, or a newer
 *  revision of the same package (optimistic concurrency via If-Match). */
export class PackageConflictError extends Error {
  constructor(message: string, readonly revision?: string) {
    super(message);
  }
}

interface PackageEntry {
  raw: Partial<TournamentPackage>;
  path: string;
  /** sha256 of the file text: the optimistic-concurrency token GET hands out and POST checks. */
  revision: string;
  text: string;
}

const canonical = (name: unknown): string => String(name ?? "").normalize("NFC").trim().toLowerCase();
/** The key a package name is matched by (save, replace, extends): trimmed, NFC, case-folded. */
export const packageNameKey = canonical;

/** The file operations a package write uses — injectable so tests can fail a write midway. */
export interface PackageWriteIo {
  writeFileDurable(path: string, text: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

/** The fd-level calls a durable write makes — injectable so tests can simulate short writes. */
export interface DurableFs {
  openSync(path: string, flags: string): number;
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  fstatSync(fd: number): { size: number };
  closeSync(fd: number): void;
}

const nodeDurableFs: DurableFs = {
  openSync: (path, flags) => openSync(path, flags),
  writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsyncSync: (fd) => fsyncSync(fd),
  fstatSync: (fd) => fstatSync(fd),
  closeSync: (fd) => closeSync(fd),
};

/**
 * Write every byte (writeSync may write fewer than asked: loop until done, and treat a write
 * of 0 as a failure), check the file's size equals the buffer before fsync, then fsync — so a
 * short or lying write throws instead of being renamed over the package.
 */
export function writeFileDurable(path: string, text: string, fs: DurableFs = nodeDurableFs): void {
  const buffer = Buffer.from(text, "utf8");
  const fd = fs.openSync(path, "w");
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
      if (!Number.isInteger(written) || written <= 0) throw new Error(`Short write to ${path}: ${offset} of ${buffer.length} bytes.`);
      offset += written;
    }
    const size = fs.fstatSync(fd).size;
    if (size !== buffer.length) throw new Error(`Incomplete write to ${path}: ${size} of ${buffer.length} bytes on disk.`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export const defaultPackageWriteIo: PackageWriteIo = {
  writeFileDurable: (path, text) => writeFileDurable(path, text),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
};

export class PackageFiles {
  constructor(
    private readonly dir: string,
    private readonly io: PackageWriteIo = defaultPackageWriteIo,
  ) {}

  private files(): PackageEntry[] {
    if (!existsSync(this.dir)) return [];
    const out: PackageEntry[] = [];
    for (const file of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      const path = join(this.dir, file);
      try {
        const text = readFileSync(path, "utf8");
        const raw = JSON.parse(text) as Partial<TournamentPackage>;
        out.push({ raw, path, text, revision: createHash("sha256").update(text).digest("hex") });
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  }

  /** Raw (unresolved) package documents keyed by package name AND file stem. */
  private raws(): Map<string, Partial<TournamentPackage>> {
    const out = new Map<string, Partial<TournamentPackage>>();
    for (const entry of this.files()) {
      out.set(entry.raw.name ?? basename(entry.path, ".json"), entry.raw);
      out.set(basename(entry.path, ".json"), entry.raw);
    }
    return out;
  }

  /** Lookup for reads: package name or file stem, exact first, then case-insensitive. */
  private find(name: string): PackageEntry | undefined {
    const files = this.files();
    const key = (entry: PackageEntry) => [entry.raw.name ?? basename(entry.path, ".json"), basename(entry.path, ".json")];
    return files.find((entry) => key(entry).includes(name)) ?? files.find((entry) => key(entry).some((k) => k.toLowerCase() === name.toLowerCase()));
  }

  /** Lookup for writes: the package with exactly this canonical NAME (never a file-stem match). */
  private byName(name: string): PackageEntry | undefined {
    const want = canonical(name);
    return this.files().find((entry) => canonical(entry.raw.name ?? basename(entry.path, ".json")) === want);
  }

  list(): { name: string; date?: string; description?: string; format?: "sevens" }[] {
    const seen = new Set<string>();
    const rows: { name: string; date?: string; description?: string; format?: "sevens" }[] = [];
    const raws = this.raws();
    for (const raw of raws.values()) {
      const name = raw.name ?? "(unnamed)";
      if (seen.has(name)) continue;
      seen.add(name);
      // `format` (additive, Sevens only): the nearest format along the extends chain, so a layer over a Sevens package is
      // listed as Sevens too (the Roster Builder's card badge).
      const sevens = this.formatOf(raw, raws) === "sevens";
      rows.push({ name, date: raw.date, description: raw.description, ...(sevens ? { format: "sevens" as const } : {}) });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The nearest `format` set along a raw document's extends chain (cycle-safe); undefined when none sets one. */
  private formatOf(raw: Partial<TournamentPackage>, raws: Map<string, Partial<TournamentPackage>>): string | undefined {
    const seen = new Set<Partial<TournamentPackage>>();
    let at: Partial<TournamentPackage> | undefined = raw;
    while (at && !seen.has(at)) {
      seen.add(at);
      if (typeof at.format === "string") return at.format;
      at = typeof at.extends === "string" && at.extends ? raws.get(at.extends) : undefined;
    }
    return undefined;
  }

  get(name: string): { pkg: TournamentPackage; problems: string[] } | undefined {
    const raws = this.raws();
    const found = this.find(name);
    if (!found) return undefined;
    return loadPackage(found.raw, { resolveExtends: (n) => raws.get(n) });
  }

  /** The package document exactly as authored (no defaults / `extends` merged) plus its revision —
   *  what the organiser's editor loads, so a load → save round trip leaves the file unchanged. */
  getRaw(name: string): { raw: Partial<TournamentPackage>; revision: string } | undefined {
    const found = this.find(name);
    return found ? { raw: JSON.parse(found.text) as Partial<TournamentPackage>, revision: found.revision } : undefined;
  }

  /** The stored name of the package `name` matches the way save / replace match it (trim, NFC, case), or undefined. */
  storedName(name: string): string | undefined {
    const hit = this.byName(name);
    return hit ? String(hit.raw.name ?? basename(hit.path, ".json")) : undefined;
  }

  /** Whether a package with this `extends` name exists. */
  hasPackage(name: string): boolean {
    return this.raws().has(name);
  }

  /** Resolve a document (defaults ← `extends` base ← document) against the saved packages. */
  resolve(input: DeepPartial<TournamentPackage>): { pkg: TournamentPackage; problems: string[] } {
    const raws = this.raws();
    return loadPackage(input, { resolveExtends: (n) => raws.get(n) });
  }

  /**
   * Write a document AS SENT (the editor sends the raw package, so defaults and inherited `extends`
   * fields never get baked into the file); it is resolved only to report problems. Callers validate
   * first (packagesApi). Target rules:
   *   - the request may REPLACE a file only when it explicitly targets that package: the document's
   *     name is the package's canonical name, or `replace` names it; the write then needs `ifMatch`
   *     equal to the file's current revision (else PackageConflictError carrying the current one);
   *   - otherwise the document is new: `<name-stem>.json`, and a stem that collides with ANY existing
   *     file (e.g. "small/gods" → small-gods.json) is a conflict, never an overwrite.
   * The written file keeps the replaced file's line endings / trailing newline.
   */
  save(
    input: DeepPartial<TournamentPackage>,
    opts: { replace?: string; ifMatch?: string } = {},
  ): { path: string; pkg: TournamentPackage; problems: string[]; revision: string } {
    const { pkg, problems } = this.resolve(input);
    mkdirSync(this.dir, { recursive: true });
    const target = opts.replace ? this.byName(opts.replace) : typeof input.name === "string" ? this.byName(input.name) : undefined;
    if (opts.replace && !target) throw new PackageConflictError(`No saved package named "${opts.replace}" to replace.`);
    let path: string;
    if (target) {
      if (opts.ifMatch !== target.revision) {
        throw new PackageConflictError(
          `"${target.raw.name ?? basename(target.path)}" changed on the server since it was opened. Reload it, then reapply your edits.`,
          target.revision,
        );
      }
      path = target.path;
    } else {
      const stem = (pkg.name || "package").replace(/[^\w.-]+/g, "-").toLowerCase();
      path = join(this.dir, `${stem}.json`);
      if (existsSync(path)) {
        const other = this.files().find((entry) => entry.path === path);
        throw new PackageConflictError(`${stem}.json already holds the package "${other?.raw.name ?? stem}"; choose a different name.`);
      }
    }
    const before = target?.text ?? "";
    const crlf = before.includes("\r\n");
    let text = JSON.stringify(input, null, 2) + (target && !before.endsWith("\n") ? "" : "\n");
    if (crlf) text = text.replace(/\n/g, "\r\n");
    this.writeAtomic(path, text);
    return { path, pkg, problems, revision: createHash("sha256").update(text).digest("hex") };
  }

  /** Write to a temp file in the SAME directory, fsync it, then rename it over the target (atomic on
   *  one volume, Windows included for an existing target). Any failure leaves the old file intact and
   *  removes the temp file. */
  private writeAtomic(path: string, text: string): void {
    const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      this.io.writeFileDurable(temp, text);
      this.io.rename(temp, path);
    } catch (error) {
      try {
        this.io.remove(temp);
      } catch {
        /* best effort */
      }
      throw error;
    }
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
