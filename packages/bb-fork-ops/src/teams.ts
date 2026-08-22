/**
 * FUMBBL team fetching / fork team-file handling — shared by the Discord bot's
 * `/bbbot 40k copyteam` and config-web's `/api/fork/library/ingest` (lifted here from
 * the bot's fork40k.ts once both apps needed it, per the "is this genuinely shared?"
 * test). Node-specific (fs + fetch), which is fine — this package already isn't
 * browser-safe (it depends on mysql2).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { xmlEscape, safe } from "./util.js";
import type { ForkConfig } from "./index.js";
import type { LibraryOwnershipSnapshot, LibraryTeam } from "./library.js";
import { readLibrary, replaceLibraryTeamOwnership, restoreLibraryOwnership, snapshotLibraryTeamOwnership } from "./library.js";
import { isLoadedOnFork, type ReloadResult } from "./forkReload.js";
import { acknowledgeForkCacheReload, acquireTeamNameWriteLock, acquireTeamWriteLock, atomicWriteTextFile, markForkCacheReloadRequired } from "./locks.js";

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

/**
 * Fetch the roster XML the fork actually needs for a given team, keyed BY TEAM ID
 * (`xml:roster?team=<teamId>` → `<roster team="<teamId>">…`) — not `api/roster/get/<rosterId>`,
 * which is a different JSON schema the fork's Java RosterCache can't parse. This is the fix
 * for the "team ingests but the game silently fails to start" bug: `RosterCache` resolves a
 * roster by team id OR roster id, and a copied/ingested team never had its roster installed
 * at all before this. Throws (doesn't return a partial/empty file) on any failure — the caller
 * must not write a broken roster.
 */
export async function fetchForkRoster(teamId: string): Promise<string> {
  const res = await fetch(`https://fumbbl.com/xml:roster?team=${teamId}`, { headers: { accept: "application/xml" } });
  if (!res.ok) throw new Error(`FUMBBL xml:roster?team=${teamId}: HTTP ${res.status}.`);
  const xml = await res.text();
  if (!/<roster\b/i.test(xml)) throw new Error(`FUMBBL xml:roster?team=${teamId} didn't return a <roster> document.`);
  return xml;
}

/** Where a team's roster XML lives — the sibling `rosters/` dir next to the fork's `teams/` dir. */
const rostersDirFor = (teamsDir: string): string => join(dirname(teamsDir), "rosters");

interface TeamFileTransactionJournal {
  version: 1;
  phase: "PREPARED" | "COMMITTED";
  teamId: string;
  targetPath: string;
  teamXml: string;
  priorTeams: Array<{ path: string; xml: string }>;
  rosterPath?: string;
  rosterXml?: string;
  priorRoster?: string | null;
  removeOtherTeamFiles?: boolean;
  library?: {
    baseDir: string;
    coach: string;
    team: LibraryTeam;
    prior: LibraryOwnershipSnapshot;
  };
}

const transactionDirectory = (teamsDir: string): string => join(teamsDir, ".team-transactions");
const transactionPath = (teamsDir: string, teamId: string): string =>
  join(transactionDirectory(teamsDir), `${createHash("sha256").update(teamId).digest("hex")}.json`);

function writeTransactionJournal(teamsDir: string, journal: TeamFileTransactionJournal): string {
  const path = transactionPath(teamsDir, journal.teamId);
  atomicWriteTextFile(path, JSON.stringify(journal));
  return path;
}

function beginTransactionJournal(teamsDir: string, journal: TeamFileTransactionJournal): string {
  const path = transactionPath(teamsDir, journal.teamId);
  if (existsSync(path)) throw new Error("A durable recovery transaction is already pending for this team; restart config-web to reconcile it.");
  return writeTransactionJournal(teamsDir, journal);
}

function validateJournal(value: unknown): value is TeamFileTransactionJournal {
  if (!value || typeof value !== "object") return false;
  const j = value as Partial<TeamFileTransactionJournal>;
  return j.version === 1 && (j.phase === "PREPARED" || j.phase === "COMMITTED") &&
    typeof j.teamId === "string" && typeof j.targetPath === "string" && typeof j.teamXml === "string" &&
    ((j.rosterPath === undefined && j.rosterXml === undefined && j.priorRoster === undefined) ||
      (typeof j.rosterPath === "string" && typeof j.rosterXml === "string" && (typeof j.priorRoster === "string" || j.priorRoster === null))) &&
    Array.isArray(j.priorTeams) && j.priorTeams.every((entry) => entry && typeof entry.path === "string" && typeof entry.xml === "string");
}

function restorePreparedTransaction(journal: TeamFileTransactionJournal): void {
  for (const path of new Set([journal.targetPath, ...journal.priorTeams.map((entry) => entry.path)])) {
    if (existsSync(path)) unlinkSync(path);
  }
  for (const snapshot of journal.priorTeams) atomicWriteTextFile(snapshot.path, snapshot.xml);
  if (journal.rosterPath) {
    if (journal.priorRoster === null) {
      if (existsSync(journal.rosterPath)) unlinkSync(journal.rosterPath);
    } else if (journal.priorRoster !== undefined) {
      atomicWriteTextFile(journal.rosterPath, journal.priorRoster);
    }
  }
  if (journal.library) restoreLibraryOwnership(journal.library.baseDir, journal.library.prior);
}

function completeCommittedTransaction(teamsDir: string, journal: TeamFileTransactionJournal): void {
  atomicWriteTextFile(journal.targetPath, journal.teamXml);
  if (journal.rosterPath && journal.rosterXml !== undefined) atomicWriteTextFile(journal.rosterPath, journal.rosterXml);
  if (journal.removeOtherTeamFiles) removeExistingTeamFilesForId(teamsDir, journal.teamId, journal.targetPath);
  if (journal.library) replaceLibraryTeamOwnership(journal.library.baseDir, journal.library.coach, journal.library.team);
}

/**
 * Reconcile durable team/roster/library journals left by a process crash. PREPARED generations roll
 * back; COMMITTED generations complete idempotently. Unreadable journals remain quarantined in place
 * and are reported, so a later writer cannot silently treat an ambiguous generation as fresh.
 */
export function recoverTeamFileTransactions(
  teamsDir: string,
  opts?: { includeLibraryTransactions?: boolean },
): { recovered: string[]; errors: string[]; receipts: Array<{ teamId: string; path: string; hash: string }> } {
  const dir = transactionDirectory(teamsDir);
  if (!existsSync(dir)) return { recovered: [], errors: [], receipts: [] };
  const recovered: string[] = [];
  const errors: string[] = [];
  const receipts: Array<{ teamId: string; path: string; hash: string }> = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
    const path = join(dir, name);
    let journal: TeamFileTransactionJournal;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!validateJournal(parsed)) throw new Error("invalid transaction journal shape");
      journal = parsed;
      // The Discord copy process cannot safely refresh a config-web ingest generation that may
      // already have reached the fork cache. It recovers copy-only journals; config-web startup
      // owns library-bearing recovery and reloads the fork before accepting traffic.
      if (journal.library && opts?.includeLibraryTransactions === false) continue;
      const lock = acquireTeamWriteLock(teamsDir, journal.teamId, Date.now(), true);
      if (!lock) throw new Error("team is currently locked");
      try {
        if (journal.phase === "PREPARED") restorePreparedTransaction(journal);
        else completeCommittedTransaction(teamsDir, journal);
        recovered.push(journal.teamId);
        receipts.push({ teamId: journal.teamId, path, hash: createHash("sha256").update(raw).digest("hex") });
      } finally {
        lock.release();
      }
    } catch (error) {
      errors.push(`${name}: ${(error as Error).message}`);
    }
  }
  return { recovered, errors, receipts };
}

/** Remove only journals whose exact generation was reconciled and then cache-reloaded by the caller. */
export function acknowledgeRecoveredTeamTransactions(receipts: Array<{ path: string; hash: string }>): void {
  for (const receipt of receipts) {
    if (!existsSync(receipt.path)) continue;
    const current = readFileSync(receipt.path, "utf8");
    if (createHash("sha256").update(current).digest("hex") !== receipt.hash) {
      throw new Error(`Team transaction journal changed before reload acknowledgement: ${receipt.path}`);
    }
    unlinkSync(receipt.path);
  }
}

export interface TeamXmlTransactionHandle {
  teamsDir: string;
  journalPath: string;
  journal: TeamFileTransactionJournal;
}

/** Begin a crash-recoverable single-team XML/library mutation. Caller already holds the team lock. */
export function beginTeamXmlTransaction(input: {
  teamsDir: string;
  teamId: string;
  targetPath: string;
  teamXml: string;
  library?: { baseDir: string; coach: string; team: LibraryTeam };
}): TeamXmlTransactionHandle {
  const priorTeams = existsSync(input.targetPath) ? [{ path: input.targetPath, xml: readFileSync(input.targetPath, "utf8") }] : [];
  const journal: TeamFileTransactionJournal = {
    version: 1,
    phase: "PREPARED",
    teamId: input.teamId,
    targetPath: input.targetPath,
    teamXml: input.teamXml,
    priorTeams,
    ...(input.library ? {
      library: {
        ...input.library,
        prior: snapshotLibraryTeamOwnership(input.library.baseDir, input.teamId),
      },
    } : {}),
  };
  const journalPath = beginTransactionJournal(input.teamsDir, journal);
  try {
    markForkCacheReloadRequired(input.teamsDir, `Team ${input.teamId} mutation requires a fork cache reload.`);
  } catch (error) {
    // PREPARED remains authoritative and startup recovery will restore/reload the old generation.
    throw error;
  }
  return { teamsDir: input.teamsDir, journalPath, journal };
}

/** COMMITTED is the point of no return; cleanup failures leave startup enough state to complete safely. */
export function commitTeamXmlTransaction(handle: TeamXmlTransactionHandle, cacheReloaded = true): void {
  writeTransactionJournal(handle.teamsDir, { ...handle.journal, phase: "COMMITTED" });
  if (cacheReloaded) {
    try { acknowledgeForkCacheReload(handle.teamsDir); } catch { /* startup will retry */ }
  }
  try { unlinkSync(handle.journalPath); } catch { /* startup will complete COMMITTED */ }
}

export function updateTeamXmlTransactionLibraryTeam(handle: TeamXmlTransactionHandle, team: LibraryTeam): void {
  if (!handle.journal.library) throw new Error("This team transaction has no library generation.");
  handle.journal.library.team = team;
  writeTransactionJournal(handle.teamsDir, handle.journal);
}

/** Restore PREPARED disk/library state. A successful cache reload must follow before acknowledgement. */
export function restoreTeamXmlTransaction(handle: TeamXmlTransactionHandle): void {
  restorePreparedTransaction(handle.journal);
}

export function acknowledgeRestoredTeamXmlTransaction(handle: TeamXmlTransactionHandle): void {
  acknowledgeForkCacheReload(handle.teamsDir);
  if (existsSync(handle.journalPath)) unlinkSync(handle.journalPath);
}

/**
 * Fetch + write the roster for `teamId` into the fork's rosters dir as
 * `roster_team_<teamId>.xml` — keyed by team id (the attribute RosterCache actually reads),
 * so this is correct regardless of coach, FUMBBL rosterId, or race-name matching.
 */
export async function installForkRoster(teamsDir: string, teamId: string): Promise<string> {
  const xml = await fetchForkRoster(teamId);
  const dir = rostersDirFor(teamsDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `roster_team_${safe(teamId)}.xml`);
  const generationLock = acquireTeamNameWriteLock(teamsDir);
  if (!generationLock) throw new Error("Another team/cache generation update is already in progress.");
  const lock = acquireTeamWriteLock(teamsDir, teamId);
  if (!lock) {
    generationLock.release();
    throw new Error("Another update is already in progress for this team.");
  }
  try {
    markForkCacheReloadRequired(teamsDir, `Installed roster ${teamId} requires a fork cache reload.`);
    atomicWriteTextFile(path, xml);
  } finally { lock.release(); generationLock.release(); }
  return path;
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
 * A teamId must map to EXACTLY ONE file. Remove any pre-existing `team_<anyCoach>_<id>.xml`
 * before writing a fresh one, so re-ingesting the same team under a different coach can't
 * leave two files with the same id. The fork's team cache keys on the teamId alone, so a
 * duplicate-id file (different coach prefix) makes it resolve the team to the WRONG owner →
 * startGame CHECK_OWNERSHIP fails with "Not Your Team" and the join silently aborts (the
 * owner-reported 1272390 Kalimar-vs-flutethecat collision, 2026-07-15). Returns the removed names.
 */
function removeExistingTeamFilesForId(teamsDir: string, teamId: string, keepPath?: string): string[] {
  if (!existsSync(teamsDir)) return [];
  const suffix = `_${teamId}.xml`;
  const removed: string[] = [];
  for (const f of readdirSync(teamsDir)) {
    if (f.startsWith("team_") && f.endsWith(suffix)) {
      const candidate = join(teamsDir, f);
      if (keepPath && candidate === keepPath) continue;
      unlinkSync(candidate);
      removed.push(f);
    }
  }
  return removed;
}

function duplicateStoredTeamName(teamsDir: string, teamName: string, excludeTeamId: string): string | undefined {
  const wanted = teamName.trim().toLowerCase();
  if (!wanted || !existsSync(teamsDir)) return undefined;
  for (const file of readdirSync(teamsDir).filter((name) => name.startsWith("team_") && name.endsWith(".xml"))) {
    const stored = readFileSync(join(teamsDir, file), "utf8");
    const id = (stored.match(/<team\b[^>]*\bid="([^"]+)"/i)?.[1] ?? stored.match(/<id>([^<]*)<\/id>/i)?.[1] ?? "").trim();
    if (id === excludeTeamId) continue;
    const name = stored.match(/<name>([^<]*)<\/name>/i)?.[1]?.trim();
    if (name?.toLowerCase() === wanted) return id || file;
  }
  return undefined;
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
export async function copyForkTeam(
  cfg: ForkConfig,
  url: string,
  opts?: { asCoach?: string; allowReplaceProgressed?: boolean; isTeamActive?: (teamId: string) => Promise<boolean> },
): Promise<CopiedTeam> {
  const t = await fetchForkTeam(url);
  const rosterXml = await fetchForkRoster(t.teamId);
  const owner = opts?.asCoach?.trim() || t.coach;
  const xml = recoachXml(t.xml, owner);
  mkdirSync(cfg.teamsDir, { recursive: true });
  const nameLock = acquireTeamNameWriteLock(cfg.teamsDir);
  if (!nameLock) throw new Error("Another team name update is already in progress.");
  const lock = acquireTeamWriteLock(cfg.teamsDir, t.teamId);
  if (!lock) {
    nameLock.release();
    throw new Error("Another update is already in progress for this team.");
  }
  const path = join(cfg.teamsDir, `team_${safe(owner)}_${t.teamId}.xml`);
  try {
    const duplicateId = duplicateStoredTeamName(cfg.teamsDir, t.teamName, t.teamId);
    if (duplicateId) throw new Error(`A different local team (${duplicateId}) already uses the name "${t.teamName}".`);
    if (!opts?.isTeamActive) throw new Error("Team activity cannot be verified on this host; copy is unavailable.");
    let active: boolean;
    try { active = await opts.isTeamActive(t.teamId); }
    catch { throw new Error("Team activity cannot be verified on this host; copy is unavailable."); }
    if (active) throw new Error("This team has a game in progress and cannot be copied or replaced.");
    const suffix = `_${t.teamId}.xml`;
    const existingFiles = readdirSync(cfg.teamsDir).filter((file) => file.startsWith("team_") && file.endsWith(suffix));
    const snapshots = existingFiles.map((file) => ({ path: join(cfg.teamsDir, file), xml: readFileSync(join(cfg.teamsDir, file), "utf8") }));
    if (!opts?.allowReplaceProgressed && snapshots.some((snapshot) => teamXmlHasProgressionOrHistory(snapshot.xml))) {
      throw new Error("This local team has progression or match history and cannot be destructively copied. Use an explicit organizer recovery/merge path.");
    }
    const rosterPath = join(rostersDirFor(cfg.teamsDir), `roster_team_${safe(t.teamId)}.xml`);
    const rosterBefore = existsSync(rosterPath) ? readFileSync(rosterPath, "utf8") : undefined;
    const journal: TeamFileTransactionJournal = {
      version: 1, phase: "PREPARED", teamId: t.teamId, targetPath: path, teamXml: xml,
      priorTeams: snapshots, rosterPath, rosterXml, priorRoster: rosterBefore ?? null,
    };
    const journalPath = beginTransactionJournal(cfg.teamsDir, journal);
    markForkCacheReloadRequired(cfg.teamsDir, `Copying team ${t.teamId} requires a fork cache reload.`);
    try {
      atomicWriteTextFile(path, xml);
      atomicWriteTextFile(rosterPath, rosterXml);
      removeExistingTeamFilesForId(cfg.teamsDir, t.teamId, path);
      let stillActive: boolean;
      try { stillActive = await opts.isTeamActive(t.teamId); }
      catch { throw new Error("Team activity cannot be verified after the copy; the replacement was rolled back."); }
      if (stillActive) throw new Error("A game started during the team copy; the replacement was rolled back.");
      writeTransactionJournal(cfg.teamsDir, { ...journal, phase: "COMMITTED" });
      try { unlinkSync(journalPath); } catch { /* COMMITTED is the point of no return; startup completes it */ }
    } catch (error) {
      try {
        restorePreparedTransaction(journal);
        acknowledgeForkCacheReload(cfg.teamsDir);
        if (existsSync(journalPath)) unlinkSync(journalPath);
      } catch (rollbackError) {
        throw new Error(`${(error as Error).message}; durable rollback remains pending: ${(rollbackError as Error).message}`);
      }
      throw error;
    }
  } finally {
    lock.release();
    nameLock.release();
  }
  let raceWarning: string | undefined;
  if (t.raceName && !forkSupportsRace(t.raceName, forkRosterNames(cfg.teamsDir))) {
    raceWarning = `No fork roster matches "${t.raceName}" by name — the by-team-id roster is installed, so this is informational only, not blocking.`;
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
  const builderDialect = num("teamRating") !== undefined || num("teamStrength") !== undefined;
  const rawTv = num("currentTeamValue") ?? num("teamValue") ?? num("teamRating") ?? 0;
  const teamValue = builderDialect ? Math.round(rawTv * 10) : rawTv >= 10000 ? Math.round(rawTv / 1000) : rawTv;
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
 * XML AND its roster XML (by-team-id — see `installForkRoster`; this is the fix for the
 * "team ingests but the game silently fails to start" bug) into the fork's dirs, and
 * upsert a LibraryTeam row into `libDir`. `forkLoadable`/`needsRestart` reflect whether
 * the CURRENTLY RUNNING fork has actually loaded this ingest yet (via `stateDir`'s reload
 * marker — see forkReload.ts) — a fresh ingest is never loadable until a reload happens,
 * even though the files are written immediately. The caller (config-web) is expected to
 * trigger a reload right after this and re-upsert once it succeeds.
 */
export async function ingestForkTeam(
  cfg: ForkConfig,
  libDir: string,
  requestingCoach: string,
  teamUrl: string,
  stateDir: string,
  opts?: {
    allowReplaceProgressed?: boolean;
    fetchedTeam?: ForkTeam;
    reload?: () => Promise<ReloadResult>;
    isTeamActive?: (teamId: string) => Promise<boolean>;
    /** Caller already holds the shared global name lock across its final collision recheck. */
    teamNameLockHeld?: boolean;
  },
): Promise<{ team: LibraryTeam; raceWarning?: string; needsRestart: boolean; reload?: ReloadResult }> {
  const coach = requestingCoach.trim();
  if (!coach) throw new Error("A coach name is required.");
  const t = opts?.fetchedTeam ?? await fetchForkTeam(teamUrl);
  const rosterXml = await fetchForkRoster(t.teamId);
  const meta = parseTeamXmlMeta(t.xml);
  mkdirSync(cfg.teamsDir, { recursive: true });
  const xml = recoachXml(t.xml, coach);
  const path = join(cfg.teamsDir, `team_${safe(coach)}_${t.teamId}.xml`);
  const nameLock = opts?.teamNameLockHeld ? undefined : acquireTeamNameWriteLock(cfg.teamsDir);
  if (!opts?.teamNameLockHeld && !nameLock) throw new Error("Another team name update is already in progress.");
  const lock = acquireTeamWriteLock(cfg.teamsDir, t.teamId);
  if (!lock) {
    nameLock?.release();
    throw new Error("Another update is already in progress for this team.");
  }
  try {
    if (!opts?.isTeamActive) {
      throw new Error("Team activity cannot be verified on this host; ingest is unavailable.");
    }
    let active: boolean;
    try {
      active = await opts.isTeamActive(t.teamId);
    } catch {
      throw new Error("Team activity cannot be verified on this host; ingest is unavailable.");
    }
    if (active) {
      throw new Error("This team has a game in progress and cannot be ingested or replaced.");
    }
    const suffix = `_${t.teamId}.xml`;
    const existingFiles = readdirSync(cfg.teamsDir).filter((file) => file.startsWith("team_") && file.endsWith(suffix));
    if (!opts?.allowReplaceProgressed && existingFiles.some((file) => teamXmlHasProgressionOrHistory(readFileSync(join(cfg.teamsDir, file), "utf8")))) {
      throw new Error("This local team has progression or match history and cannot be destructively re-ingested. Ask an organizer to use the explicit recovery/merge path.");
    }
    const snapshots = existingFiles.map((file) => ({ path: join(cfg.teamsDir, file), xml: readFileSync(join(cfg.teamsDir, file), "utf8") }));
    const rosterPath = join(rostersDirFor(cfg.teamsDir), `roster_team_${safe(t.teamId)}.xml`);
    const rosterBefore = existsSync(rosterPath) ? readFileSync(rosterPath, "utf8") : undefined;
    const ingestedAt = new Date().toISOString();
    const forkLoadable = isLoadedOnFork(stateDir, ingestedAt);
    const raceWarning =
      t.raceName && !forkSupportsRace(t.raceName, forkRosterNames(cfg.teamsDir))
        ? `No fork roster matches "${t.raceName}" by name — the by-team-id roster is installed regardless, so this is informational only.`
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
      ingestedAt,
    };
    const journal: TeamFileTransactionJournal = {
      version: 1, phase: "PREPARED", teamId: t.teamId, targetPath: path, teamXml: xml,
      priorTeams: snapshots, rosterPath, rosterXml, priorRoster: rosterBefore ?? null,
      library: { baseDir: libDir, coach, team, prior: snapshotLibraryTeamOwnership(libDir, t.teamId) },
    };
    const journalPath = beginTransactionJournal(cfg.teamsDir, journal);
    markForkCacheReloadRequired(cfg.teamsDir, `Ingesting team ${t.teamId} requires a fork cache reload.`);
    try {
      atomicWriteTextFile(path, xml);
      atomicWriteTextFile(rosterPath, rosterXml);
      removeExistingTeamFilesForId(cfg.teamsDir, t.teamId, path);
      replaceLibraryTeamOwnership(libDir, coach, team);
      let stillActive: boolean;
      try { stillActive = await opts.isTeamActive(t.teamId); }
      catch { throw new Error("Team activity cannot be verified before ingest reload; the replacement was rolled back."); }
      if (stillActive) throw new Error("A game started during team ingest; the replacement was rolled back.");
      const reload = opts?.reload ? await opts.reload() : undefined;
      if (reload?.reloaded) {
        team.forkLoadable = true;
        replaceLibraryTeamOwnership(libDir, coach, team);
      }
      const committed: TeamFileTransactionJournal = {
        ...journal,
        phase: "COMMITTED",
        library: { ...journal.library!, team },
      };
      writeTransactionJournal(cfg.teamsDir, committed);
      if (reload?.reloaded) {
        try { acknowledgeForkCacheReload(cfg.teamsDir); } catch { /* COMMITTED journal remains authoritative */ }
      }
      try { unlinkSync(journalPath); } catch { /* COMMITTED is the point of no return; startup completes it */ }
      return { team, raceWarning, needsRestart: !team.forkLoadable, ...(reload ? { reload } : {}) };
    } catch (error) {
      try {
        restorePreparedTransaction(journal);
      } catch (rollbackError) {
        throw new Error(`${(error as Error).message}; durable rollback remains pending: ${(rollbackError as Error).message}`);
      }
      if (opts?.reload) {
        try {
          const restored = await opts.reload();
          if (!restored.reloaded) throw new Error(restored.reason ?? "restored generation reload refused");
          acknowledgeForkCacheReload(cfg.teamsDir);
        } catch (reloadError) {
          markForkCacheReloadRequired(cfg.teamsDir, `Rollback of team ${t.teamId} could not be loaded: ${(reloadError as Error).message}`);
          throw new Error(`${(error as Error).message}; restored generation awaits startup recovery: ${(reloadError as Error).message}`);
        }
      }
      if (existsSync(journalPath)) unlinkSync(journalPath);
      throw error;
    }
  } finally {
    lock.release();
    nameLock?.release();
  }
}

export function teamXmlHasProgressionOrHistory(xml: string): boolean {
  if (/<(?:pendingAdvancement|advancement)\b/i.test(xml)) return true;
  if (/<injury\b/i.test(xml)) return true;
  // In stored team XML, player-level skills are additions; intrinsic position skills live in the
  // roster XML. Treat even a zero-SPP added skill as progression and require explicit recovery.
  if (/<player\b[^>]*>[\s\S]*?<skill\b/i.test(xml)) return true;
  if (/<(?:playerStatistics|starPlayerPoints)\b[^>]*(?:currentSpps|earnedSpps|current|earned)="[1-9]\d*"/i.test(xml)) return true;
  return /<(?:playedGames|games|completions|touchdowns|interceptions|casualties|mvps|passing|rushing|blocks|fouls)>\s*[1-9]\d*\s*<\//i.test(xml);
}
