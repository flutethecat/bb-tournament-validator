/**
 * Privacy collector registry (spec 2026-10-31 §2 export, §3 delete): ONE place where every store that holds a coach's
 * data says what the export takes from it and what deletion does to it. A store added to the site must register here;
 * test/privacy.test.ts fails when a known store has no collector.
 *
 * Ownership and linkage: a file or record is the coach's ONLY through the identity-store key of the coach (the session
 * coach and the identity record's spelling, compared with the identity store's own key function) or a verified link
 * (a league row's coachId, a fork coach account field, the verified NAF link, the verified Discord link). Self-chosen
 * names (display name, NAF name, Discord username, an unverified NAF id) never select a record; a display column is
 * rewritten only on a record that is already linked. See src/privacy/anonymise.ts for the free-text rule.
 *
 * Every function reads the store files directly under the configured paths (no in-memory copies). In the delete path
 * only "nothing there" (ENOENT) counts as empty; any other read, parse or delete error fails the step so the journal
 * retries it. The export path is lenient (an unreadable unrelated file never blocks a download).
 */
import { RESET_IDENTITY_KEYS } from "../leagues/ladderReset.js";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { acquireFileWriteLock, atomicWriteTextFile, libraryWriteLockPath } from "@bb/fork-ops";
import { normalizeFfbCoachId, rawIdentityRecord, readIdentities, readIdentitiesStrict, removeIdentityRecord, type CoachIdentityRecord } from "../auth/identitiesStore.js";
import { deleteSessionsForCoach, sessionsForCoach } from "../auth/session.js";
import { coachAvatarId, coachAvatarKey, coachProxyCacheKeys, deleteCoachAvatarData } from "../coachAvatars.js";
import { avatarStoreFor } from "../teamAvatars.js";
import { notificationCoachKey, notificationFileName } from "../notifications.js";
import { socialFileName } from "../social/store.js";
import { ProposalStore } from "../schedule/store.js";
import { TemplateStore, templatesFile } from "../templates/store.js";
import { anonymiseLeagueRegistration, anonymiseRegistrationTrail, ownLeagueRegistrations } from "../registration/privacy.js";
import { createAnonymiser, createTextReplacer, nameKey, textAliases, type Anonymiser, type TextReplacer } from "./anonymise.js";
import { coachKeyHash, isReservedCoachName } from "./fence.js";
import { addToBlocklist, mapHash, markRecentDeletion, recordDeletedCoach, type StepStatus } from "./state.js";

// ---- deps / contexts --------------------------------------------------------------------------------------------

export interface PrivacyDeps {
  /** FORK_STATE_DIR: results, notifications, leagues, ratings, replays, privacy state. */
  stateDir: string;
  /** TOURNAMENTS_DIR (tournaments.json). */
  tournamentsDir: string;
  libraryDir: string;
  builderSavesDir: string;
  teamAvatarsDir: string;
  coachAvatarsDir: string;
  bugReportsDir: string;
  tabletopDir: string;
  /** organizers.json (legacy organiser list). */
  organizersFile?: string;
  /** PRIVACY_MAP_KEY: keys the deleted-coach map and the recent-deletion markers. Without it deletion is refused. */
  mapKey?: string;
  /** The server's Discord SSO pending store. */
  pendingSso?: { deleteWhere(match: (discordId: string) => boolean): number };
  /** Disables the coach's fork (game server) account. Undefined = no fork on this host (the step is skipped). Throws when
   *  the fork cannot be reached: the step stays pending and is retried. */
  disableForkAccount?: (coach: string) => Promise<void>;
  /** Portal mail (src/mail): the coach's prefs and deliveries. Undefined = no mail service on this host. */
  mail?: { exportFor(coach: string): unknown; forgetCoach(coach: string): void };
  /** The "coach deleted" event: store files were rewritten, every derived cache must be dropped. */
  onCoachDeleted?: () => void;
  env?: NodeJS.ProcessEnv;
}

export interface ExportFile { name: string; content: string | Buffer }

export interface ExportCtx {
  deps: PrivacyDeps;
  /** The coach's own spelling (identity record), else the session name. */
  coach: string;
  /** Identity-store keys of the coach (ownership). */
  keys: Set<string>;
  record?: Record<string, unknown>;
}

/** The names a job needs: stored only sealed in the journal (src/privacy/state.ts). */
export interface PlanSecrets {
  coach: string;
  /** Identity-store spellings that own files and link records (the session name and the identity record's spelling). */
  coachNames: string[];
  /** Display names found on records LINKED to the coach (league rows by coachId), for free text and coach honours. */
  displays: string[];
  /** The coach's NAF id, only when VERIFIED (identity connections.naf). */
  nafId?: string;
}

/** The plan line as stored: hashes and file keys in the clear, names sealed. */
export interface StoredPlan {
  jobId: string;
  /** coachKeyHash of the coach (deletion fence). */
  coachHash: string;
  pseudonym: string;
  /** sha256 of the Discord user id (matches pending SSO entries without storing the id). */
  discordHash?: string;
  /** HMAC(PRIVACY_MAP_KEY, Discord id): the 24 h recent-deletion marker. */
  discordMark?: string;
  /** Blocklist entry for a banned coach (HMAC of the Discord id). */
  blockHash?: string;
  /** Uploaded team logos to delete ("library:<id>" | "save:<id>"). */
  teamKeys: string[];
  /** Proxy-cache keys of the coach's Discord / admin-set avatar images. */
  proxyKeys: string[];
  /** The fork account step must run (a fork was configured when the job was planned): never skipped later. */
  forkRequired?: boolean;
  actor: string;
  at: string;
  sealed: string;
}

export type DeletePlan = Omit<StoredPlan, "sealed"> & PlanSecrets;

export interface DeleteCtx {
  deps: PrivacyDeps;
  plan: DeletePlan;
  an: Anonymiser;
  names: Set<string>;
  /** Free-text replacement (built on first use: needs the other coaches' names). */
  text: () => TextReplacer;
}

// ---- fs helpers -------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const vals = (v: unknown): Obj[] => (isObj(v) ? Object.values(v).filter(isObj) : []);
const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

/** Strict: undefined only when the file does not exist; unreadable or unparsable throws. */
function readJson<T>(path: string): T | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { if (isEnoent(e)) return undefined; throw e; }
  return JSON.parse(text) as T;
}
/** Lenient (export only). */
const readJsonLoose = <T>(path: string): T | undefined => { try { return readJson<T>(path); } catch { return undefined; } };
function listFiles(dir: string, ext: string): string[] {
  try { return readdirSync(dir).filter((n) => n.endsWith(ext)).map((n) => join(dir, n)); } catch (e) { if (isEnoent(e)) return []; throw e; }
}
function listDirs(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name)); } catch (e) { if (isEnoent(e)) return []; throw e; }
}
/** Only "already gone" is success; EACCES / EPERM / EBUSY fail the step. */
const unlinkIfExists = (path: string): void => {
  try { unlinkSync(path); } catch (e) { if (!isEnoent(e)) throw e; }
};
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const isMine = (keys: ReadonlySet<string>, value: unknown): boolean => typeof value === "string" && keys.has(nameKey(value));

/** Rewrite one JSON file through a store-specific anonymiser (atomic; untouched when nothing matched). */
function rewriteJson(path: string, fn: (data: Obj) => boolean): void {
  const data = readJson<unknown>(path);
  if (data === undefined) return;
  if (!isObj(data)) throw new Error(`not a JSON object: ${basename(path)}`);
  if (fn(data)) atomicWriteTextFile(path, json(data));
}

/** Same for an append-only NDJSON file (each line on its own; torn lines kept as they are). */
function rewriteNdjson(path: string, fn: (line: Obj) => boolean): void {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch (e) { if (isEnoent(e)) return; throw e; }
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (!line.trim()) return line;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { return line; }
    if (!isObj(obj) || !fn(obj)) return line;
    changed = true;
    return JSON.stringify(obj);
  });
  if (changed) atomicWriteTextFile(path, lines.join("\n"));
}

// ---- store readers (ownership by identity key only) ---------------------------------------------------------------

interface SaveFile { coach?: string; saves?: Array<Obj & { id?: string; shareToken?: string }> }

function ownSaveFiles(dir: string, names: ReadonlySet<string>, strict = true): Array<{ path: string; data: SaveFile }> {
  const read = strict ? readJson : readJsonLoose;
  return (strict ? listFiles(dir, ".json") : (() => { try { return listFiles(dir, ".json"); } catch { return []; } })())
    .map((path) => ({ path, data: read<SaveFile>(path) }))
    .filter((f): f is { path: string; data: SaveFile } => Boolean(f.data && isMine(names, f.data.coach)));
}

/** The coach's library rows, file by file: rows are the coach's by their owner field, never by the file name. */
function ownLibraryRows(dir: string, names: ReadonlySet<string>, strict = true): Array<{ path: string; mine: Obj[]; others: unknown[] }> {
  const read = strict ? readJson : readJsonLoose;
  const files = strict ? listFiles(dir, ".json") : (() => { try { return listFiles(dir, ".json"); } catch { return []; } })();
  const out: Array<{ path: string; mine: Obj[]; others: unknown[] }> = [];
  for (const path of files) {
    const teams = read<unknown>(path);
    if (!Array.isArray(teams)) continue;
    const mine = teams.filter((t): t is Obj => isObj(t) && isMine(names, t.coach));
    if (mine.length) out.push({ path, mine, others: teams.filter((t) => !(isObj(t) && isMine(names, t.coach))) });
  }
  return out;
}

function bugReportDirs(dir: string, names: ReadonlySet<string>, strict = true): Array<{ path: string; report: Obj }> {
  const read = strict ? readJson : readJsonLoose;
  const dirs = strict ? listDirs(dir) : (() => { try { return listDirs(dir); } catch { return []; } })();
  return dirs
    .map((path) => ({ path, report: read<Obj>(join(path, "report.json")) }))
    .filter((r): r is { path: string; report: Obj } => Boolean(r.report && isMine(names, r.report.coach)));
}

function readOrganizers(file: string | undefined, strict = true): string[] | undefined {
  if (!file) return undefined;
  const raw = (strict ? readJson : readJsonLoose)<{ organizers?: unknown }>(file);
  return Array.isArray(raw?.organizers) ? raw!.organizers.filter((x): x is string => typeof x === "string") : undefined;
}

type TournamentFile = {
  tournaments?: Record<string, Obj & { name?: string; status?: string; ownerCoachId?: string; organizerCoachId?: string; organizerCoachIds?: string[] }>;
  entrants?: Record<string, Obj & { tournamentId?: string; coach?: { ffbCoachId?: string; coachId?: string } }>;
  /** Registration (lane L4): pending, waitlisted, declined and withdrawn-before-acceptance entries (same row shape). */
  heldEntrants?: Record<string, Obj & { tournamentId?: string; coach?: { ffbCoachId?: string; coachId?: string } }>;
  scheduledMatches?: Record<string, Obj & { tournamentId?: string; home?: { coach?: { ffbCoachId?: string } }; away?: { coach?: { ffbCoachId?: string } } }>;
  /** Tournament Series (phase 5): creator and organisers are coach ids. */
  series?: Record<string, Obj & { name?: string; createdBy?: string; organisers?: string[]; tournaments?: string[] }>;
};
const tournamentsFile = (deps: PrivacyDeps): string => join(deps.tournamentsDir, "tournaments.json");
const organiserRequestsFile = (deps: PrivacyDeps): string => join(deps.stateDir, "organiser-requests.json");
const leagueDirs = (deps: PrivacyDeps, strict = true): string[] => (strict ? listDirs(join(deps.stateDir, "leagues")) : (() => { try { return listDirs(join(deps.stateDir, "leagues")); } catch { return []; } })());
/** Every league season / ladder record (export only: lenient, an unreadable file is skipped). */
const leagueSeasonFiles = (deps: PrivacyDeps): Obj[] => leagueDirs(deps, false).flatMap((dir) => { try { return listFiles(join(dir, "seasons"), ".json"); } catch { return []; } }).map((p) => readJsonLoose<Obj>(p)).filter((x): x is Obj => isObj(x));

/** A league row is linked to the coach by its account link (coachId); a row without one only by an exact coach id. */
const leagueRowLinked = (keys: ReadonlySet<string>, o: unknown): boolean => {
  if (!isObj(o)) return false;
  if (typeof o.coachId === "string" && o.coachId.trim()) return isMine(keys, o.coachId);
  return isMine(keys, o.coach);
};

/** A league award given on this site (league.json awards[]): linked by its recipient account, else by the coach shown. */
const customAwardLinked = (keys: ReadonlySet<string>, o: unknown): boolean => {
  if (!isObj(o)) return false;
  if (typeof o.toCoachId === "string" && o.toCoachId.trim()) return isMine(keys, o.toCoachId);
  return isMine(keys, o.toCoach);
};

/** Within one season: the coach's teams (linked rows) and the rows linked to them through the team. */
function seasonLinks(keys: ReadonlySet<string>, s: Obj): { teamIds: Set<string>; teamNames: Set<string>; linked: (o: unknown) => boolean } {
  const teams = objs(s.teams).filter((t) => leagueRowLinked(keys, t));
  const teamIds = new Set(teams.map((t) => t.id).filter((x): x is string => typeof x === "string"));
  const teamNames = new Set(teams.map((t) => t.name).filter((x): x is string => typeof x === "string" && x.trim().length > 0));
  const linked = (o: unknown): boolean => {
    if (!isObj(o)) return false;
    if (typeof o.coachId === "string" && o.coachId.trim()) return isMine(keys, o.coachId); // an explicit link always wins
    if (isMine(keys, o.coach)) return true;
    if (typeof o.teamId === "string" && o.teamId) return teamIds.has(o.teamId);
    return typeof o.team === "string" && teamNames.has(o.team);
  };
  return { teamIds, teamNames, linked };
}

/** Display names on rows linked to the coach (league coach / NAF user columns). Data, not self-chosen. */
export function linkedDisplays(deps: PrivacyDeps, keys: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  const take = (o: unknown) => { if (isObj(o)) for (const f of ["coach", "nafUser"]) if (typeof o[f] === "string" && (o[f] as string).trim()) out.add((o[f] as string).trim()); };
  for (const dir of leagueDirs(deps)) {
    const league = readJson<unknown>(join(dir, "league.json"));
    if (isObj(league)) for (const a of objs(league.awards)) if (customAwardLinked(keys, a) && typeof a.toCoach === "string" && a.toCoach.trim()) out.add(a.toCoach.trim());
    for (const p of listFiles(join(dir, "seasons"), ".json")) {
      const s = readJson<unknown>(p);
      if (!isObj(s)) continue;
      const { linked } = seasonLinks(keys, s);
      for (const t of objs(s.teams)) if (linked(t)) take(t);
      for (const f of objs(s.fixtures)) { if (linked(f.home)) take(f.home); if (linked(f.away)) take(f.away); }
      for (const p2 of objs(s.participants)) if (linked(p2)) take(p2);
      for (const a of objs(s.awards)) if (linked(a)) take(a);
    }
  }
  for (const k of keys) out.delete(k);
  return [...out].filter((d) => !keys.has(nameKey(d)));
}

/** Identity keys of everyone else the site knows as a coach or account: other identities, library owners, result coaches,
 *  tournament seats, tabletop coaches, league account links. A name of theirs is never a text alias. */
export function otherCoachKeys(deps: PrivacyDeps, keys: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v.trim()) out.add(nameKey(v)); };
  for (const r of Object.values(readIdentitiesStrict().coaches)) add(r.ffbCoachId);
  for (const p of listFiles(deps.libraryDir, ".json")) for (const t of objs(readJson<unknown>(p))) add(t.coach);
  for (const r of vals(readJson<Obj>(join(deps.stateDir, "tournament-results.json"))?.results)) { if (isObj(r.home)) add(r.home.coach); if (isObj(r.away)) add(r.away.coach); }
  const tFile = readJson<TournamentFile>(tournamentsFile(deps));
  for (const e of [...vals(tFile?.entrants), ...vals(tFile?.heldEntrants)]) if (isObj(e.coach)) add(e.coach.ffbCoachId);
  for (const p of listFiles(join(deps.tabletopDir, "matches"), ".json")) { const m = readJson<Obj>(p); if (m) { if (isObj(m.home)) add(m.home.coach); if (isObj(m.away)) add(m.away.coach); } }
  for (const dir of leagueDirs(deps)) for (const p of listFiles(join(dir, "seasons"), ".json")) for (const t of objs(readJson<Obj>(p)?.teams)) add(t.coachId);
  for (const k of keys) out.delete(k);
  return out;
}

// ---- ownership (delete is blocked while the coach owns a tournament or a league) ---------------------------------

export interface OwnedItem { kind: "tournament" | "league"; id: string; name: string }

/** Draft/active tournaments and leagues the coach OWNS (an organiser seat is removed instead, never blocks). */
export function ownedItems(deps: PrivacyDeps, names: ReadonlySet<string>): OwnedItem[] {
  const out: OwnedItem[] = [];
  const data = readJson<TournamentFile>(tournamentsFile(deps));
  for (const [id, t] of Object.entries(data?.tournaments ?? {})) {
    const owner = t.ownerCoachId ?? t.organizerCoachId;
    if ((t.status === "draft" || t.status === "active") && isMine(names, owner)) out.push({ kind: "tournament", id, name: String(t.name ?? id) });
  }
  for (const dir of leagueDirs(deps)) {
    const league = readJson<{ id?: string; name?: string; owner?: string; organisers?: unknown }>(join(dir, "league.json"));
    if (!league) continue;
    const organisers = Array.isArray(league.organisers) ? league.organisers.filter((x): x is string => typeof x === "string") : [];
    const owner = league.owner?.trim() || organisers[0]?.trim() || "";
    if (isMine(names, owner)) out.push({ kind: "league", id: String(league.id ?? ""), name: String(league.name ?? league.id ?? "") });
  }
  return out;
}

/** The avatar store folds names with NFC on top of the identity key; two identities that collide there share one slot. */
export function avatarSlotCollision(coach: string): boolean {
  const key = normalizeFfbCoachId(coach);
  const slot = coachAvatarId(coach);
  return Object.values(readIdentitiesStrict().coaches).some((r) => normalizeFfbCoachId(r.ffbCoachId) !== key && coachAvatarId(r.ffbCoachId) === slot);
}

// ---- the registry -----------------------------------------------------------------------------------------------

type ExportFn = (ctx: ExportCtx) => ExportFile[] | Promise<ExportFile[]>;
export interface StoreCollector {
  /** Store id (spec §0 inventory row, or a store found in the code). */
  id: string;
  /** Where it lives (env key / path), for the README and the report. */
  location: string;
  /** Files this store contributes to the export, or why it contributes none. */
  export: ExportFn | { none: string };
  /** The delete steps that act on it (ids in DELETE_STEPS), or why deletion leaves it alone. */
  erase: string[] | { none: string };
}

const strip = (o: Obj, ...fields: string[]): Obj => {
  const out = { ...o };
  for (const f of fields) delete out[f];
  return out;
};

export const STORE_COLLECTORS: StoreCollector[] = [
  {
    id: "identities",
    location: "IDENTITIES_FILE (identities.json)",
    // The whole stored record (also fields this build does not know yet), plus roles; never session ids or secrets.
    export: (ctx) => {
      const organisers = readOrganizers(ctx.deps.organizersFile, false) ?? [];
      const account = {
        ...(ctx.record ?? { ffbCoachId: ctx.coach }),
        legacyOrganiser: organisers.some((o) => nameKey(o) === nameKey(ctx.coach)),
        sessions: sessionsForCoach(ctx.coach),
      };
      return [{ name: "account.json", content: json(account) }];
    },
    erase: ["identity"],
  },
  { id: "sessions", location: "SESSIONS_FILE (sessions.json)", export: { none: "Listed in account.json without the session ids." }, erase: ["sessions", "final-sweep"] },
  { id: "discord-sso", location: "data-store/discord-sso-{state,pending}.json", export: { none: "Ten-minute sign-in handshakes only." }, erase: ["sso-pending", "final-sweep"] },
  { id: "organizers", location: "ORGANIZERS_FILE (organizers.json)", export: { none: "Shown as legacyOrganiser in account.json." }, erase: ["organiser-roles"] },
  {
    id: "coach-avatars",
    location: "COACH_AVATARS_DIR (uploads + proxy-cache/)",
    export: (ctx) => {
      if (avatarSlotCollision(ctx.coach)) return []; // the slot is shared with another account: never hand it out
      const found = avatarStoreFor(ctx.deps.coachAvatarsDir).find(coachAvatarKey(ctx.coach));
      if (!found) return [];
      try { return [{ name: `avatar.${found.ext}`, content: readFileSync(found.path) }]; } catch { return []; }
    },
    erase: ["coach-avatar", "final-sweep"],
  },
  {
    id: "team-avatars",
    location: "TEAM_AVATARS_DIR",
    export: (ctx) => {
      const store = avatarStoreFor(ctx.deps.teamAvatarsDir);
      const out: ExportFile[] = [];
      for (const key of teamKeysFor(ctx.deps, ctx.keys, false)) {
        const found = store.find(key);
        if (!found) continue;
        try { out.push({ name: `team-logos/${key.replace(/[^\w-]/g, "_")}.${found.ext}`, content: readFileSync(found.path) }); } catch { /* gone */ }
      }
      return out;
    },
    erase: ["team-logos"],
  },
  {
    id: "builder-saves",
    location: "FORK_BUILDER_SAVES_DIR (+ shares/)",
    // Share tokens are capabilities: the export says a save is shared, never the token.
    export: (ctx) => {
      const saves = ownSaveFiles(ctx.deps.builderSavesDir, ctx.keys, false).flatMap((f) => f.data.saves ?? [])
        .map((s) => ({ ...strip(s, "shareToken"), ...(s.shareToken ? { shared: true } : {}) }));
      return [{ name: "builder-saves.json", content: json(saves) }];
    },
    erase: ["builder-saves", "final-sweep"],
  },
  {
    id: "team-library",
    location: "FORK_LIBRARY_DIR",
    export: (ctx) => [{ name: "team-library.json", content: json(ownLibraryRows(ctx.deps.libraryDir, ctx.keys, false).flatMap((f) => f.mine)) }],
    erase: ["library", "final-sweep"],
  },
  {
    id: "fork-db",
    location: "Fork server DB (FORK_DB_HOST)",
    export: { none: "Game records live on the game server; the results the site keeps are in results.json." },
    erase: ["fork-account", "deleted-map"],
  },
  {
    id: "tournaments",
    location: "TOURNAMENTS_DIR/tournaments.json",
    export: (ctx) => {
      const data = readJsonLoose<TournamentFile>(tournamentsFile(ctx.deps));
      const tName = (id?: string) => (id && data?.tournaments?.[id]?.name) || id || "";
      // The field and the held entries (pending, waitlisted, declined, withdrawn before acceptance: lane L4).
      const entries = [...Object.values(data?.entrants ?? {}), ...Object.values(data?.heldEntrants ?? {})].filter((e) => isMine(ctx.keys, e.coach?.ffbCoachId))
        .map((e) => ({ tournament: tName(e.tournamentId), ...e }));
      // Paid marks the coach made as a manager on other coaches' entries: the competition and the entry reference, what
      // they set and when (nothing else of that coach's entry).
      const paidActions = Object.values(data?.entrants ?? {})
        .filter((e) => isObj(e.paidUpdated) && isMine(ctx.keys, (e.paidUpdated as Obj).by))
        .map((e) => ({
          tournament: tName(e.tournamentId), tournamentId: e.tournamentId, entrantId: e.id,
          paid: isObj(e.flags) && (e.flags as Obj).paid === true, at: (e.paidUpdated as Obj).at,
        }));
      // A fixture shows the opponent as on the public page: coach name and team only (never their Discord id).
      const side = (s: { coach?: { ffbCoachId?: string } } | undefined) => (s ? { ...s, coach: { ffbCoachId: s.coach?.ffbCoachId } } : s);
      const matches = Object.values(data?.scheduledMatches ?? {})
        .filter((m) => isMine(ctx.keys, m.home?.coach?.ffbCoachId) || isMine(ctx.keys, m.away?.coach?.ffbCoachId))
        .map((m) => ({ tournament: tName(m.tournamentId), ...m, home: side(m.home), away: side(m.away) }));
      const managed = Object.entries(data?.tournaments ?? {})
        .filter(([, t]) => isMine(ctx.keys, t.ownerCoachId ?? t.organizerCoachId) || (t.organizerCoachIds ?? []).some((o) => isMine(ctx.keys, o)))
        .map(([id, t]) => ({ id, name: t.name, status: t.status, role: isMine(ctx.keys, t.ownerCoachId ?? t.organizerCoachId) ? "owner" : "organiser" }));
      // Tournament Series the coach created or organises (owner 10-31: exports cover every store).
      const series = Object.entries(data?.series ?? {})
        .filter(([, s]) => isMine(ctx.keys, s.createdBy) || (Array.isArray(s.organisers) ? s.organisers : []).some((o) => isMine(ctx.keys, o)))
        .map(([id, s]) => ({
          id, name: s.name, description: s.description, scoring: s.scoring, bestN: s.bestN, seeding: s.seeding,
          tournaments: (Array.isArray(s.tournaments) ? s.tournaments : []).map((t) => ({ id: t, name: tName(t) })),
          createdAt: s.createdAt,
          role: isMine(ctx.keys, s.createdBy) ? "creator" : "organiser",
        }));
      // Tournament awards given to the coach or by them (organiser awards on tournaments.json awards[]).
      const awards = Object.values(data?.tournaments ?? {}).flatMap((t) => objs(t.awards)
        .filter((a) => isMine(ctx.keys, a.toCoach) || isMine(ctx.keys, a.by))
        .map((a) => ({ tournament: t.name ?? a.tournamentId, ...a })));
      // Result edits the coach made as an organiser (each tournament's activity log, admin-stamped).
      const resultEdits = Object.values(data?.tournaments ?? {}).flatMap((t) => objs(t.activity)
        .filter((e) => isMine(ctx.keys, e.by))
        .map((e) => ({ tournament: t.name ?? "", ...e })));
      return [{ name: "tournament-entries.json", content: json({ entries, matches, managed, series, ...(awards.length ? { awards } : {}), ...(resultEdits.length ? { resultEdits } : {}), ...(paidActions.length ? { paidActions } : {}) }) }];
    },
    erase: ["organiser-roles", "anonymise-tournaments"],
  },
  {
    id: "leagues",
    location: "FORK_STATE_DIR/leagues/<id>/ (league.json, seasons/, tourplay-import.json; secrets.json never read)",
    export: (ctx) => {
      const leagues: unknown[] = [];
      for (const dir of leagueDirs(ctx.deps, false)) {
        const league = readJsonLoose<{ id?: string; name?: string; owner?: string; organisers?: string[]; awards?: unknown; hallOfFame?: unknown }>(join(dir, "league.json"));
        if (!league) continue;
        // Awards given on this site to or by the coach, and Hall of Fame entries they pinned.
        const awards = objs(league.awards).filter((a) => customAwardLinked(ctx.keys, a) || isMine(ctx.keys, a.by));
        const pins = objs(league.hallOfFame).filter((p) => isMine(ctx.keys, p.by));
        let files: string[] = [];
        try { files = listFiles(join(dir, "seasons"), ".json"); } catch { /* none */ }
        const rows = files.map((p) => readJsonLoose<Obj>(p)).filter(isObj).map((s) => {
          const { linked } = seasonLinks(ctx.keys, s);
          return {
            season: s.name, number: s.number,
            teams: objs(s.teams).filter(linked),
            // resultEdit names the organiser who overrode a result: never given to the fixture's participants (see resultEdits).
            // A fixture whose frozen (or cleared) game coach is this coach belongs to their export too.
            fixtures: objs(s.fixtures).filter((f) => [f.home, f.away].some((side) => linked(side) || (isObj(side) && [side.playedBy, side.clearedPlayedBy].some((p) => isObj(p) && linked({ coach: p.coach, coachId: p.coachId }))))).map(({ resultEdit: _e, forfeitDetail: _d, forfeitDraft: _r, ...f }) => f),
            // Result overrides this coach made as an organiser (the actor only).
            resultEdits: objs(s.fixtures).filter((f) => isObj(f.resultEdit) && isMine(ctx.keys, (f.resultEdit as Obj).by))
              .map((f) => ({ fixture: f.id, home: (f.home as Obj | undefined)?.team, away: (f.away as Obj | undefined)?.team, at: (f.resultEdit as Obj).at })),
            participants: objs(s.participants).filter(linked),
            // Advancement rolls waiting for a pick that this coach made on a team they don't coach (an organiser rolling on
            // the coach's behalf): the team, player and roll. Their own teams' pending rolls are in `teams`.
            advancementRolls: objs(s.teams).filter((t) => !linked(t)).flatMap((t) => objs(t.players)
              .filter((p) => isObj(p.pendingAdvance) && isMine(ctx.keys, (p.pendingAdvance as Obj).by))
              .map((p) => ({ team: t.name, player: p.name, roll: p.pendingAdvance }))),
            standings: objs(s.phases).flatMap((p) => objs(p.standings).filter(linked)),
            awards: objs(s.awards).filter(linked),
            registrations: ownLeagueRegistrations(s, (v) => isMine(ctx.keys, v)),
            takeoverApplications: ownLeagueRegistrations({ registrations: s.takeoverApplications }, (v) => isMine(ctx.keys, v)),
            // Paid marks the coach made as an organiser: the team reference, what they set and when.
            paidActions: objs(s.participants).filter((p) => isObj(p.paidUpdated) && isMine(ctx.keys, (p.paidUpdated as Obj).by))
              .map((p) => ({ ...(typeof p.teamId === "string" ? { teamId: p.teamId } : {}), team: p.team, paid: p.paid === true, at: (p.paidUpdated as Obj).at })),
          };
        }).filter((r) => r.teams.length + r.fixtures.length + r.resultEdits.length + r.participants.length + r.advancementRolls.length + r.standings.length + r.awards.length + r.registrations.length + r.takeoverApplications.length + r.paidActions.length > 0);
        const role = isMine(ctx.keys, league.owner) ? "owner" : (league.organisers ?? []).some((o) => isMine(ctx.keys, o)) ? "organiser" : undefined;
        // TourPlay import (lane L8): the private rows linked to the coach (their TourPlay name, NAF user and number) and
        // the claims they made. Rows of other coaches never.
        const tourplay = tourplayImportExport(ctx.keys, readJsonLoose<Obj>(join(dir, "tourplay-import.json")));
        if (rows.length || role || awards.length || pins.length || tourplay)
          leagues.push({ league: league.name ?? league.id, id: league.id, ...(role ? { role } : {}), seasons: rows, ...(awards.length ? { awards } : {}), ...(pins.length ? { hallOfFame: pins } : {}), ...(tourplay ? { tourplayImport: tourplay } : {}) });
      }
      return [{ name: "league-teams.json", content: json(leagues) }];
    },
    erase: ["organiser-roles", "anonymise-leagues"],
  },
  {
    id: "tabletop",
    location: "TABLETOP_DIR (matches/, events/, journals/, dice/)",
    export: (ctx) => {
      const out: unknown[] = [];
      let matchFiles: string[] = [];
      try { matchFiles = listFiles(join(ctx.deps.tabletopDir, "matches"), ".json"); } catch { /* none */ }
      for (const path of matchFiles) {
        const m = readJsonLoose<Obj & { id?: string; home?: { coach?: string }; away?: { coach?: string }; createdBy?: string }>(path);
        const forfeitBy = isObj(m?.forfeit) ? (m!.forfeit as Obj).by : undefined;
        const pendingBy = isObj(m?.forfeitPending) ? (m!.forfeitPending as Obj).by : undefined;
        if (!m || !(isMine(ctx.keys, m.home?.coach) || isMine(ctx.keys, m.away?.coach) || isMine(ctx.keys, m.createdBy) || isMine(ctx.keys, forfeitBy) || isMine(ctx.keys, pendingBy))) continue;
        let events: unknown[] = [];
        try {
          events = readFileSync(join(ctx.deps.tabletopDir, "events", `${String(m.id).replace(/[^\w-]/g, "_")}.ndjson`), "utf8")
            .split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as unknown]; } catch { return []; } });
        } catch { /* no events */ }
        out.push({ ...m, events });
      }
      let teamFiles: string[] = [];
      try { teamFiles = listFiles(join(ctx.deps.tabletopDir, "teams"), ".json"); } catch { /* none */ }
      const teams = teamFiles.map((p) => readJsonLoose<{ coach?: string }>(p)).filter((c) => c && isMine(ctx.keys, c.coach));
      // The dice log (src/dice/log.ts): every roll this coach made, and every block-die choice they submitted.
      const diceRolls: unknown[] = [];
      for (const path of listFiles(join(ctx.deps.tabletopDir, "dice"), ".ndjson")) {
        let text = "";
        try { text = readFileSync(path, "utf8"); } catch { continue; }
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let o: unknown;
          try { o = JSON.parse(line); } catch { continue; }
          if (isObj(o) && isMine(ctx.keys, o.by)) diceRolls.push(o);
        }
      }
      return [{ name: "tabletop-matches.json", content: json({ matches: out, teamRevisions: teams, ...(diceRolls.length ? { diceRolls } : {}) }) }];
    },
    erase: ["anonymise-tabletop"],
  },
  {
    id: "tournament-results",
    location: "FORK_STATE_DIR/tournament-results.json",
    export: (ctx) => {
      const store = readJsonLoose<{ results?: Record<string, { home?: { coach?: string }; away?: { coach?: string } }> }>(join(ctx.deps.stateDir, "tournament-results.json"));
      const rows = Object.values(store?.results ?? {}).filter((r) => isMine(ctx.keys, r.home?.coach) || isMine(ctx.keys, r.away?.coach));
      const titles = readJsonLoose<{ titles?: Record<string, unknown> }>(join(ctx.deps.stateDir, "coach-titles.json"))?.titles ?? {};
      const title = Object.entries(titles).find(([k]) => ctx.keys.has(nameKey(k)))?.[1];
      const nafId = verifiedNafId(ctx.record as Partial<CoachIdentityRecord> | undefined);
      const naf = nafId ? readJsonLoose<{ coaches?: Record<string, unknown> }>(join(ctx.deps.stateDir, "naf-games.json"))?.coaches?.[nafId] : undefined;
      return [{ name: "results.json", content: json({ results: rows, ...(title ? { title } : {}), ...(naf ? { nafRecord: naf } : {}) }) }];
    },
    erase: ["anonymise-results", "deleted-map"],
  },
  { id: "tournament-matches", location: "FORK_STATE_DIR/tournament-matches.json", export: { none: "Match metadata only; the games are in results.json." }, erase: ["anonymise-results"] },
  { id: "naf-games", location: "FORK_STATE_DIR/naf-games.json", export: { none: "Included in results.json (nafRecord, verified NAF link only)." }, erase: ["anonymise-naf"] },
  { id: "coach-titles", location: "FORK_STATE_DIR/coach-titles.json", export: { none: "Included in results.json (title)." }, erase: ["anonymise-ratings"] },
  { id: "replay-moments", location: "FORK_STATE_DIR/replay-moments/", export: { none: "Public game highlights derived from the game server; no data beyond results.json." }, erase: ["anonymise-replays"] },
  {
    id: "notifications",
    location: "FORK_STATE_DIR/notifications/<coach>.json",
    export: (ctx) => {
      const file = readJsonLoose<{ notifications?: unknown[] }>(join(ctx.deps.stateDir, "notifications", notificationFileName(notificationCoachKey(ctx.coach))));
      return [{ name: "notifications.json", content: json(file?.notifications ?? []) }];
    },
    erase: ["notifications", "anonymise-notifications", "final-sweep"],
  },
  // Friends, private messages and blocks (landing spec §4.3-4.5, src/social/store.ts). A file only when the coach has data.
  {
    id: "friends",
    location: "FORK_STATE_DIR/friends/<coach>.json",
    export: (ctx) => {
      const f = readJsonLoose<Obj>(join(ctx.deps.stateDir, "friends", socialFileName(ctx.coach)));
      if (!f) return [];
      return [{ name: "friends.json", content: json({ friends: objs(f.friends), incoming: objs(f.incoming), outgoing: objs(f.outgoing) }) }];
    },
    erase: ["social", "final-sweep"],
  },
  {
    id: "blocks",
    location: "FORK_STATE_DIR/blocks/<coach>.json",
    export: (ctx) => {
      const b = readJsonLoose<Obj>(join(ctx.deps.stateDir, "blocks", socialFileName(ctx.coach)));
      return b ? [{ name: "blocks.json", content: json({ blocked: objs(b.blocked) }) }] : [];
    },
    erase: ["social", "final-sweep"],
  },
  {
    id: "messages",
    location: "FORK_STATE_DIR/messages/threads/<id>.json, FORK_STATE_DIR/messages/index/<coach>.json, FORK_STATE_DIR/messages/pairs/<hash>.json",
    export: (ctx) => {
      // Every thread the coach is one of the two coaches of (by identity key), with both coaches' messages.
      let paths: string[] = [];
      try { paths = listFiles(join(ctx.deps.stateDir, "messages", "threads"), ".json"); } catch { paths = []; }
      const threads = paths
        .map((p) => readJsonLoose<Obj>(p))
        .filter((t): t is Obj => Boolean(t) && Array.isArray(t!.coaches) && (t!.coaches as unknown[]).some((c) => isMine(ctx.keys, c)))
        .map((t) => ({ id: t.id, coaches: t.coaches, organiser: t.organiser === true, createdAt: t.createdAt, messages: objs(t.messages) }));
      const index = readJsonLoose<Obj>(join(ctx.deps.stateDir, "messages", "index", socialFileName(ctx.coach)));
      if (!threads.length && !index) return [];
      return [{ name: "messages.json", content: json({ threads, inbox: objs(index?.threads) }) }];
    },
    erase: ["social", "anonymise-messages", "final-sweep"],
  },
  {
    // Game-time proposals (src/schedule/store.ts): every proposal the coach sent or was sent, with both coaches' names
    // and the candidate times. The agreed time itself lives on the fixture (league / tournament records).
    id: "schedule-proposals",
    location: "FORK_STATE_DIR/schedule/proposals.json",
    export: (ctx) => {
      let rows: unknown[] = [];
      try { rows = new ProposalStore(ctx.deps.stateDir).all().filter((p) => isMine(ctx.keys, p.from) || isMine(ctx.keys, p.to)); } catch { rows = []; }
      return rows.length ? [{ name: "game-proposals.json", content: json(rows) }] : [];
    },
    erase: ["schedule-proposals", "final-sweep"],
  },
  {
    // Fixture lobbies (src/fixtureLobby): the chat is kept with the fixture. Every lobby the coach is one of the two
    // coaches of (by account) or wrote in, with its whole chat and both sides' lobby state.
    id: "fixture-lobbies",
    location: "FORK_STATE_DIR/fixture-lobbies/<sha256>.json",
    export: (ctx) => {
      let paths: string[] = [];
      try { paths = listFiles(join(ctx.deps.stateDir, "fixture-lobbies"), ".json"); } catch { paths = []; }
      const lobbies = paths
        .map((p) => readJsonLoose<Obj>(p))
        .filter((l): l is Obj => Boolean(l) && ((Array.isArray(l!.coaches) && (l!.coaches as unknown[]).some((c) => isMine(ctx.keys, c))) || objs(l!.chat).some((m) => isMine(ctx.keys, m.from))
          || (isObj(l!.askedOrganiser) && isMine(ctx.keys, (l!.askedOrganiser as Obj).by))))
        .map((l) => ({ key: l.key, coaches: l.coaches, sides: l.sides, hold: l.hold ?? null, started: l.started ?? null, askedOrganiser: l.askedOrganiser ?? null, chat: objs(l.chat) }));
      return lobbies.length ? [{ name: "fixture-lobbies.json", content: json(lobbies) }] : [];
    },
    erase: ["anonymise-fixture-lobbies"],
  },
  {
    id: "bug-reports",
    location: "BUG_REPORTS_DIR",
    export: (ctx) => [{
      name: "bug-reports-index.json",
      content: json(bugReportDirs(ctx.deps.bugReportsDir, ctx.keys, false).map(({ path, report }) => ({
        id: path.split(/[\\/]/).pop(), submittedAt: report.submittedAt, kind: report.kind, gameId: report.gameId ?? null, description: report.description ?? "",
      }))),
    }],
    erase: ["bug-reports"],
  },
  {
    // "Become an organiser" requests (src/organiserRequests.ts): the coach's own rows, without who decided.
    id: "organiser-requests",
    location: "FORK_STATE_DIR/organiser-requests.json",
    export: (ctx) => {
      const rows = objs(readJsonLoose<Obj>(organiserRequestsFile(ctx.deps))?.requests).filter((r) => isMine(ctx.keys, r.coach)).map((r) => strip(r, "decidedBy"));
      return rows.length ? [{ name: "organiser-requests.json", content: json(rows) }] : [];
    },
    erase: ["organiser-requests"],
  },
  {
    // Competition templates (src/templates/store.ts): the coach's own templates in full (settings and who they shared
    // them with), and the templates other organisers shared with them (name, kind, owner, when).
    id: "competition-templates",
    location: "FORK_STATE_DIR/competition-templates.json",
    export: (ctx) => {
      const all = objs(readJsonLoose<Obj>(templatesFile(ctx.deps.stateDir))?.templates);
      const own = all.filter((t) => isMine(ctx.keys, t.owner));
      const shared = all.filter((t) => !isMine(ctx.keys, t.owner)).flatMap((t) => {
        const grant = objs(t.sharedWith).find((g) => isMine(ctx.keys, g.coach));
        return grant ? [{ id: t.id, kind: t.kind, name: t.name, owner: t.owner, sharedAt: grant.at }] : [];
      });
      return own.length || shared.length ? [{ name: "templates.json", content: json({ own, sharedWithYou: shared }) }] : [];
    },
    erase: ["competition-templates", "final-sweep"],
  },
  {
    // Coach clubs (src/clubs/store.ts): the clubs the coach created or belongs to, their requests, former-member rows and
    // notification choices; plus the club picks on their league / tournament entries (those records are exported with
    // the tournament and league files too). Never the clubs' webhooks.
    id: "clubs",
    location: "FORK_STATE_DIR/clubs/clubs.json (secrets.json: club webhooks, no coach data; crests/)",
    export: (ctx) => {
      const file = readJsonLoose<Obj>(join(ctx.deps.stateDir, "clubs", "clubs.json"));
      const clubs = vals(file?.clubs);
      const memberships = clubs.flatMap((c) => objs(c.members).filter((m) => isMine(ctx.keys, m.coach)).map((m) => ({ club: c.id, name: c.name, role: m.role, joinedAt: m.joinedAt, notify: m.notify ?? {} })));
      const requests = clubs.flatMap((c) => objs(c.requests).filter((r) => isMine(ctx.keys, r.coach)).map((r) => ({ club: c.id, name: c.name, at: r.at, ...(r.message ? { message: r.message } : {}) })));
      const former = clubs.flatMap((c) => objs(c.former).filter((f) => isMine(ctx.keys, f.coach)).map((f) => ({ club: c.id, name: c.name, joinedAt: f.joinedAt, leftAt: f.leftAt, reason: f.reason })));
      const created = clubs.filter((c) => isMine(ctx.keys, c.createdBy)).map((c) => ({ club: c.id, name: c.name, createdAt: c.createdAt }));
      const picks: Obj[] = [];
      const t = readJsonLoose<Obj>(join(ctx.deps.tournamentsDir, "tournaments.json"));
      for (const e of [...vals(t?.entrants), ...vals(t?.heldEntrants)]) {
        if (typeof e.clubId === "string" && isObj(e.coach) && isMine(ctx.keys, (e.coach as Obj).ffbCoachId)) picks.push({ kind: "tournament", competition: e.tournamentId, entry: e.id, club: e.clubId });
      }
      for (const season of leagueSeasonFiles(ctx.deps)) {
        for (const r of objs(season.registrations)) if (typeof r.clubId === "string" && isMine(ctx.keys, r.coach)) picks.push({ kind: season.competition === "ladder" ? "ladder" : "league", competition: `${String(season.leagueId ?? "")}/${String(season.id ?? "")}`, entry: r.id, club: r.clubId });
      }
      if (!memberships.length && !requests.length && !former.length && !created.length && !picks.length) return [];
      return [{ name: "clubs.json", content: json({ memberships, requests, former, created, picks }) }];
    },
    erase: ["clubs"],
  },
  {
    // Club boards (src/boards/board.ts): every post and reply the coach wrote, with its thread.
    id: "club-boards",
    location: "FORK_STATE_DIR/boards/<sha256>.json",
    export: (ctx) => {
      const posts: Obj[] = [];
      for (const p of listFiles(join(ctx.deps.stateDir, "boards"), ".json")) {
        const b = readJsonLoose<Obj>(p);
        for (const t of objs(b?.threads)) {
          if (isMine(ctx.keys, t.author)) posts.push({ board: b?.scope, thread: t.id, title: t.title, id: t.id, text: t.text, at: t.at, ...(t.editedAt ? { editedAt: t.editedAt } : {}) });
          for (const r of objs(t.replies)) if (isMine(ctx.keys, r.author)) posts.push({ board: b?.scope, thread: t.id, id: r.id, text: r.text, at: r.at, ...(r.editedAt ? { editedAt: r.editedAt } : {}) });
        }
      }
      const out = posts.length ? [{ name: "club-board-posts.json", content: json(posts) }] : [];
      // League and tournament boards (moderation, owner 11-04): the reports the coach filed, mutes on them, and the
      // moderation log entries they made or that are about them. (Their posts on those boards are in the file above.)
      const reports: Obj[] = [];
      const mutes: Obj[] = [];
      const log: Obj[] = [];
      for (const p of listFiles(join(ctx.deps.stateDir, "boards"), ".json")) {
        const b = readJsonLoose<Obj>(p);
        for (const r of objs(b?.reports)) if (isMine(ctx.keys, r.reporter)) reports.push({ board: b?.scope, id: r.id, post: r.postId, reason: r.reason, at: r.at, ...(isObj(r.resolved) ? { outcome: r.resolved.outcome } : {}) });
        if (isObj(b?.mutes)) for (const m of Object.values(b!.mutes as Obj)) if (isObj(m) && (isMine(ctx.keys, m.coach) || isMine(ctx.keys, m.by))) mutes.push({ board: b?.scope, ...m });
        for (const e of objs(b?.log)) if (isMine(ctx.keys, e.by) || isMine(ctx.keys, e.coach)) log.push({ board: b?.scope, ...e });
      }
      if (reports.length || mutes.length || log.length) out.push({ name: "board-moderation.json", content: json({ reports, mutes, log }) });
      return out;
    },
    erase: ["club-boards"],
  },
  {
    id: "mail",
    location: "FORK_STATE_DIR/mail/ (outbox/journal.jsonl, prefs.json, suppression.json, audit.jsonl)",
    export: (ctx) => (ctx.deps.mail ? [{ name: "mail.json", content: json(ctx.deps.mail.exportFor(ctx.coach)) }] : []),
    erase: ["mail", "final-sweep"],
  },
  { id: "test-games", location: "FORK_STATE_DIR/test-games.json", export: { none: "Game ids only." }, erase: { none: "No personal data." } },
  { id: "logs", location: "config-web.*.log, data-store/config-web.log", export: { none: "Operational logs, rotated; not per coach." }, erase: { none: "Expire with log rotation (spec §4)." } },
  {
    id: "fork-teams-xml",
    location: "FORK_TEAMS_DIR/<teamId>.xml (game server team files)",
    export: { none: "Game server records; team data is in team-library.json." },
    erase: { none: "Kept as game records (spec §3.3); the coach name inside stays with the fork's game history." },
  },
  {
    id: "bot-registry",
    location: "COACH_REGISTRY_JSON (discord-bot data-store/coaches.json) and VALIDATED_CSV (validated-rosters.csv)",
    export: { none: "Owned by the Discord bot, not this site." },
    erase: { none: "Owned by the Discord bot; flagged for the owner." },
  },
  { id: "privacy-blocklist", location: "FORK_STATE_DIR/privacy/blocklist.json", export: { none: "Salted hashes only." }, erase: ["blocklist"] },
  // Fields of the identity record the onboarding lane adds: exported and deleted with the whole record.
  { id: "contact-details", location: "identities.json (profile.preferredName, contact.*)", export: { none: "In account.json (the whole identity record)." }, erase: ["identity"] },
  { id: "consents", location: "identities.json (consent.*)", export: { none: "In account.json (the whole identity record)." }, erase: ["identity"] },
  { id: "tabletop-teams", location: "TABLETOP_DIR/teams/<sha256>.json (team revision chains)", export: { none: "In tabletop-matches.json (teamRevisions)." }, erase: ["tabletop-teams"] },
  // Memory only (never written to disk): nothing to export, gone on expiry or restart.
  { id: "lobby-chat", location: "server memory (Start Game lobby)", export: { none: "Memory only; expires within 24 hours." }, erase: { none: "Memory only; expires within 24 hours or on restart." } },
  { id: "desktop-claims", location: "server memory (desktop sign-in)", export: { none: "Memory only; expires within 10 minutes." }, erase: { none: "Memory only; expires within 10 minutes." } },
  { id: "translation-cache", location: "server memory (chat translation cache)", export: { none: "Memory only; not kept per coach." }, erase: { none: "Memory only; expires within 24 hours." } },
];

/** Every store the site is known to keep (spec §0 rows + stores found in the code). The registry must cover each. */
export const KNOWN_STORES = [
  "identities", "contact-details", "consents", "sessions", "discord-sso", "organizers", "coach-avatars", "team-avatars", "builder-saves",
  "team-library", "fork-db", "tournaments", "leagues", "tabletop", "tabletop-teams", "tournament-results", "tournament-matches", "naf-games",
  "coach-titles", "replay-moments", "notifications", "bug-reports", "test-games", "logs", "fork-teams-xml", "bot-registry",
  "privacy-blocklist", "lobby-chat", "desktop-claims", "translation-cache", "mail", "friends", "blocks", "messages",
  "fixture-lobbies", "schedule-proposals", "organiser-requests", "competition-templates", "clubs", "club-boards",
] as const;

/**
 * Registry store -> the privacy notice inventory rows it stands behind (spa/src/privacy/inventory.ts INVENTORY ids).
 * Internal stores the notice does not list map to []. test/privacy.test.ts checks every inventory row is covered.
 */
export const INVENTORY_ROWS: Record<(typeof KNOWN_STORES)[number], string[]> = {
  identities: ["identities"], "contact-details": ["contact-details"], consents: ["consents"], sessions: ["sessions"],
  "discord-sso": ["discord-sso"], organizers: ["organizers"], "coach-avatars": ["coach-avatars"], "team-avatars": ["team-avatars"],
  "builder-saves": ["builder-saves"], "team-library": ["team-library"], "fork-db": ["fork-db"], tournaments: ["tournaments"],
  leagues: ["leagues"], tabletop: ["tabletop"], "tabletop-teams": ["tabletop-teams"], "tournament-results": ["results"],
  "tournament-matches": ["tournament-matches"], "naf-games": ["results"], "coach-titles": ["results"], "replay-moments": ["results"],
  notifications: ["notifications"], "bug-reports": ["bug-reports"], "test-games": [], logs: ["logs"], "fork-teams-xml": ["fork-teams-xml"],
  "bot-registry": ["bot-registry"], "privacy-blocklist": [], "lobby-chat": ["lobby-chat"], "desktop-claims": ["desktop-claims"],
  "translation-cache": ["translation-cache"], mail: ["mail"], friends: ["friends"], blocks: ["blocks"], messages: ["messages"],
  "fixture-lobbies": ["fixture-lobbies"], "schedule-proposals": ["schedule-proposals"], "organiser-requests": ["organiser-requests"],
  "competition-templates": ["competition-templates"],
  clubs: ["clubs"], "club-boards": ["club-boards"],
};

/** Team keys whose logos belong to the coach: their builder saves and library teams. */
export function teamKeysFor(deps: PrivacyDeps, names: ReadonlySet<string>, strict = true): string[] {
  const keys = new Set<string>();
  for (const f of ownSaveFiles(deps.builderSavesDir, names, strict)) for (const s of f.data.saves ?? []) if (typeof s.id === "string") keys.add(`save:${s.id}`);
  for (const f of ownLibraryRows(deps.libraryDir, names, strict)) for (const t of f.mine) if (typeof t.teamId === "string") keys.add(`library:${t.teamId}`);
  return [...keys];
}

/** The NAF id only while the identity's verified NAF connection still names it (an editable nafId alone is not enough). */
export function verifiedNafId(record: Partial<CoachIdentityRecord> | undefined): string | undefined {
  const id = record?.identities?.nafId;
  const naf = record?.connections?.naf;
  return id && naf && naf.nafId === id && naf.nafName === record?.identities?.nafName ? id : undefined;
}

// ---- export -----------------------------------------------------------------------------------------------------

export const EXPORT_README = `Super FUMBBL - your data
=========================

This archive holds the personal data Super FUMBBL keeps about your account, as JSON (machine readable).

account.json            Your account record: coach name, Discord username and id, verified email, display name,
                        avatar setting, FUMBBL/NAF links, contact details and consents (when given), roles, ban flag,
                        schedule, and your active sign-ins (method and times only, never the session ids).
avatar.<ext>            The avatar image you uploaded (if any).
builder-saves.json      Your saved rosters (Roster Builder). "shared": true marks a save with a public link.
team-library.json       Your teams for Play on Super FUMBBL.
team-logos/             Team logos you uploaded.
tournament-entries.json Your tournament entries, fixtures, the tournaments you run, and tournament awards to or by you.
league-teams.json       League teams, fixtures, standings and awards linked to your account, awards you gave,
                        Hall of Fame entries you pinned, leagues you run, and TourPlay import rows linked to you
                        (your TourPlay name, NAF name and number from an organiser's upload) and your claims.
tabletop-matches.json   Tabletop matches you played or recorded, with their event logs, your tabletop team history, and
                        the dice you rolled in the match recorder (the dice log).
results.json            Game results with you as home or away coach, your rating title, and your cached NAF games
                        (when your NAF link is verified).
notifications.json      Your notifications.
friends.json            Your friends and friend requests (coach names only).
blocks.json             The coaches you blocked.
messages.json           Your private conversations (both coaches' messages) and your conversation list.
fixture-lobbies.json    The fixture lobbies of your league fixtures: the lobby chat (both coaches' and organisers'
                        messages), roster and inducement locks, and the start record.
game-proposals.json     Game times you proposed to an opponent or were offered, and the answers (accepted,
                        countered, declined).
mail.json               Your email settings (confirmed address, an open confirmation, league email choice), your
                        Discord message choice, your Filter profanity choice, and the emails and Discord messages queued or recently sent to you.
bug-reports-index.json  The bug reports and feedback you sent (id, date, description).

Other coaches' private data (their emails, Discord ids) is never included. Opponent names appear where they are public
on the site (results, fixtures). Questions: see the privacy notice at /app/privacy.
`;

export const EXPORT_MAX_BYTES = 64 * 1024 * 1024;

export async function collectExport(deps: PrivacyDeps, sessionCoach: string): Promise<ExportFile[]> {
  const record = rawIdentityRecord(sessionCoach);
  const coach = typeof record?.ffbCoachId === "string" ? record.ffbCoachId : sessionCoach.trim();
  // Ownership: the identity-store key only (never NAF or display names).
  const keys = new Set([nameKey(coach), nameKey(sessionCoach)]);
  const ctx: ExportCtx = { deps, coach, keys, ...(record ? { record } : {}) };
  const files: ExportFile[] = [];
  for (const store of STORE_COLLECTORS) {
    if (typeof store.export !== "function") continue;
    files.push(...(await store.export(ctx)));
  }
  files.push({ name: "README.txt", content: EXPORT_README });
  return files;
}

// ---- delete plan ------------------------------------------------------------------------------------------------

export interface PlanInput {
  sessionCoach: string;
  jobId: string;
  pseudonym: string;
  actor: string;
  now: Date;
  mapKey: string;
  blockHashOf: (discordId: string) => string;
  discordAvatarUrl: (id: string, hash: string | undefined) => string | null | undefined;
}

export function buildPlan(deps: PrivacyDeps, input: PlanInput): DeletePlan {
  const store = readIdentitiesStrict(); // an unreadable store refuses the plan (never an empty one by mistake)
  const record = store.coaches[normalizeFfbCoachId(input.sessionCoach)];
  const coach = record?.ffbCoachId ?? input.sessionCoach.trim();
  // the identity record's spelling first (free text is matched case-sensitively on it); the session spelling only when it differs
  const coachNames = [coach, input.sessionCoach.trim()].filter((n, i, all) => all.findIndex((m) => nameKey(m) === nameKey(n)) === i);
  const names = new Set(coachNames.map(nameKey));
  const discordId = record?.identities?.discordUserId;
  const nafId = verifiedNafId(record);
  return {
    jobId: input.jobId,
    coachHash: coachKeyHash(coach),
    coach,
    coachNames,
    displays: linkedDisplays(deps, names),
    pseudonym: input.pseudonym,
    ...(discordId ? { discordHash: sha256(discordId), discordMark: mapHash(input.mapKey, "discord", discordId.trim()) } : {}),
    ...(discordId && record?.banned ? { blockHash: input.blockHashOf(discordId) } : {}),
    ...(nafId ? { nafId } : {}),
    teamKeys: teamKeysFor(deps, names),
    proxyKeys: coachProxyCacheKeys(record, input.discordAvatarUrl),
    forkRequired: Boolean(deps.disableForkAccount),
    actor: input.actor,
    at: input.now.toISOString(),
  };
}

export const splitPlan = (plan: DeletePlan): { stored: Omit<StoredPlan, "sealed">; secrets: PlanSecrets } => {
  const { coach, coachNames, displays, nafId, ...stored } = plan;
  return { stored, secrets: { coach, coachNames, displays, ...(nafId ? { nafId } : {}) } };
};

// ---- per-store anonymisation (linked records, explicit fields) ---------------------------------------------------

function anonymiseResultRow(an: Anonymiser, row: unknown): boolean {
  if (!isObj(row)) return false;
  const a = an.fields(row.home, ["coach"]);
  const b = an.fields(row.away, ["coach"]);
  return a || b;
}

function anonymiseTournaments(an: Anonymiser, tx: TextReplacer, data: Obj): boolean {
  let changed = false;
  const mark = (v: boolean) => { if (v) changed = true; };
  for (const t of vals(data.tournaments)) {
    mark(an.fields(t, ["ownerCoachId", "organizerCoachId"], []));
    mark(an.list(t.organizerCoachIds));
    for (const n of objs(t.news)) { mark(an.fields(n, ["by"], [])); mark(tx.texts(n, ["title", "body"])); }
    // Awards: recipient and giver accounts become the pseudonym; the organisers' free text loses the coach's names.
    for (const a of objs(t.awards)) { mark(an.fields(a, ["by", "toCoach"], [])); mark(tx.texts(a, ["title", "note"])); }
    // Organiser result edits (activity log): the acting manager becomes the pseudonym, the reason loses the coach's names.
    for (const e of objs(t.activity)) { mark(an.fields(e, ["by"], [])); mark(tx.texts(e, ["reason"])); }
  }
  const identity = ["coachId", "ffbCoachId"];
  // The field and the held entries (registration lane L4) are the same row shape.
  for (const e of [...vals(data.entrants), ...vals(data.heldEntrants)]) {
    // The coach's own NAF answers at registration (NAF number, "not a NAF member") go with the entry's identity.
    if (isObj(e.coach) && an.matches(e.coach.ffbCoachId)) {
      for (const k of ["nafNumber", "notNafMember", "nafPending", "nafSnapshot"]) if (k in e) { delete e[k]; changed = true; }
    }
    mark(an.fields(e.coach, identity, ["discordUserId"]));
    // Participants: the manager who last marked the entry paid (or not).
    if (isObj(e.paidUpdated)) mark(an.fields(e.paidUpdated, ["by"], []));
    // Who checked the coach in (the coach, or an organiser).
    if (isObj(e.checkedInBy)) mark(an.fields(e.checkedInBy, ["by"], []));
    // Registration core (src/registration): the organiser decision and the audited transitions.
    mark(anonymiseRegistrationTrail(an, tx, e));
  }
  for (const m of vals(data.scheduledMatches)) {
    for (const s of [m.home, m.away]) if (isObj(s)) mark(an.fields(s.coach, identity, ["discordUserId"]));
    mark(an.fields(m.edited, ["byCoachId"], []));
    if (isObj(m.edited)) mark(tx.texts(m.edited, ["reason"]));
  }
  for (const st of vals(data.standings)) for (const r of objs(st.rows)) mark(an.fields(r, ["coachId"], []));
  // Tournament Series: the creator becomes the pseudonym (organiser seats were removed by organiser-roles; any left over
  // are renamed), and the organisers' free text loses the coach's names. Standings are derived, never stored.
  for (const s of vals(data.series)) {
    mark(an.fields(s, ["createdBy"], []));
    mark(an.list(s.organisers));
    mark(tx.texts(s, ["name", "description"]));
  }
  // Waiting-room leases are keyed "<matchId>\0<coach>" and short-lived: drop the coach's, never rename them.
  if (isObj(data.waitingPresence)) {
    for (const [k, lease] of Object.entries(data.waitingPresence)) {
      if (isObj(lease) && an.matches(lease.coachId)) { delete data.waitingPresence[k]; changed = true; }
    }
  }
  return changed;
}

/** A linked league row: coach display and account link become the pseudonym, the NAF user goes. */
const LINKED_ROW = (an: Anonymiser, o: Obj): boolean => {
  const a = an.overwrite(o, ["coach"]);
  const b = typeof o.coachId === "string" && o.coachId ? (o.coachId = an.swap(o.coachId as string), true) : false;
  return a || b;
};

/** The TourPlay import record's rows linked to the coach (by the account the row links) and the coach's claims. */
function tourplayImportExport(keys: ReadonlySet<string>, file: Obj | undefined): { coaches: Obj[]; claims: Obj[] } | undefined {
  if (!file) return undefined;
  const rows = vals(file.coaches);
  const linkedTo = (r: Obj): boolean => isMine(keys, r.coachId) || (isObj(r.decision) && isMine(keys, (r.decision as Obj).coachId))
    || (Array.isArray(r.linked) && r.linked.some((x) => isMine(keys, x))) || vals(r.seasonLinks).some((x) => isMine(keys, x.coachId));
  const coaches = rows.filter(linkedTo).map((r) => ({
    name: r.name, ...(r.nafUser ? { nafUser: r.nafUser } : {}), ...(r.nafNumber ? { nafNumber: r.nafNumber } : {}),
    seasons: objs(r.seasons).map((x) => ({ number: x.number, teams: x.teams })), status: r.status, ...(r.basis ? { basis: r.basis } : {}),
    ...(isObj(r.decision) ? { decision: { via: (r.decision as Obj).via, at: (r.decision as Obj).at } } : {}),
  }));
  // Assignments the coach made as an organiser (a decision or a Teams-tab seat): the row and when.
  const assignmentsMade = rows.flatMap((r) => [
    ...(isObj(r.decision) && isMine(keys, (r.decision as Obj).by) ? [{ name: r.name, at: (r.decision as Obj).at, via: (r.decision as Obj).via }] : []),
    ...Object.entries(isObj(r.seasonLinks) ? (r.seasonLinks as Obj) : {}).filter(([, x]) => isObj(x) && isMine(keys, (x as Obj).by)).map(([season, x]) => ({ name: r.name, season, at: (x as Obj).at })),
  ]);
  const claims = objs(file.claims).filter((c) => isMine(keys, c.coach)).map((c) => ({
    name: rows.find((r) => r.id === c.row)?.name ?? "", state: c.state, at: c.at, ...(c.decidedAt ? { decidedAt: c.decidedAt } : {}),
  }));
  return coaches.length || claims.length || assignmentsMade.length ? { coaches, claims, ...(assignmentsMade.length ? { assignmentsMade } : {}) } : undefined;
}

/**
 * The TourPlay import record (private, lane L8): a row linked to the coach (its account link or the decided coach, also
 * one set on the Teams tab) is erased (TourPlay name, NAF user and NAF number: private data, not public history) with the
 * league's re-import snapshots; the coach's pending claims go and decided ones keep the pseudonym; their name
 * as a candidate, a decision's organiser, a claim's decider or an importer becomes the pseudonym or is removed.
 */
function anonymiseTourplayImport(an: Anonymiser, f: Obj): boolean {
  let changed = false;
  const coaches = isObj(f.coaches) ? (f.coaches as Obj) : {};
  for (const [key, r] of Object.entries(coaches)) {
    if (!isObj(r)) continue;
    const decision = isObj(r.decision) ? (r.decision as Obj) : undefined;
    if (an.matches(r.coachId) || an.matches(decision?.coachId) || (Array.isArray(r.linked) && r.linked.some((x) => an.matches(x))) || vals(r.seasonLinks).some((x) => an.matches(x.coachId))) {
      delete coaches[key];
      // the re-import snapshots hold the export's names too: dropped (the next re-import treats every difference as a conflict)
      delete f.snapshots;
      changed = true;
      continue;
    }
    if (isObj(r.candidates)) for (const k of ["byName", "byNumber"]) {
      const list = (r.candidates as Obj)[k];
      if (Array.isArray(list) && list.some((x) => an.matches(x))) { (r.candidates as Obj)[k] = list.filter((x) => !an.matches(x)); changed = true; }
    }
    if (decision && an.fields(decision, ["by"], [])) changed = true;
    // who made a Teams-tab seat (the seated coach of a row kept here is someone else: rows linked to the coach are gone)
    for (const x of vals(r.seasonLinks)) if (an.fields(x, ["by"], [])) changed = true;
  }
  if (Array.isArray(f.claims)) {
    const before = (f.claims as unknown[]).length;
    f.claims = (f.claims as unknown[]).filter((c) => !(isObj(c) && an.matches(c.coach) && c.state === "pending"));
    if ((f.claims as unknown[]).length !== before) changed = true;
    for (const c of objs(f.claims)) if (an.fields(c, ["coach", "decidedBy"], [])) changed = true;
  }
  for (const i of objs(f.imports)) if (an.fields(i, ["by"], [])) changed = true;
  return changed;
}

/** league.json: owner, organisers, and the awards / Hall of Fame pins given on this site (recipient, giver, free text). */
function anonymiseLeagueFile(an: Anonymiser, tx: TextReplacer, l: Obj): boolean {
  let changed = false;
  const mark = (v: boolean) => { if (v) changed = true; };
  mark(an.fields(l, ["owner"], []));
  mark(an.list(l.organisers));
  for (const a of objs(l.awards)) {
    if (customAwardLinked(an.ids, a)) {
      mark(an.overwrite(a, ["toCoach"], []));
      if (typeof a.toCoachId === "string" && a.toCoachId) { a.toCoachId = an.swap(a.toCoachId); changed = true; }
    }
    mark(an.fields(a, ["by"], []));
    mark(tx.texts(a, ["title", "note"]));
  }
  for (const p of objs(l.hallOfFame)) { mark(an.fields(p, ["by"], [])); mark(tx.texts(p, ["text", "note"])); }
  return changed;
}

/** Team page v2 (teamPage.ts) on a team record or a redraft snapshot of one: who changed the status, the team history
 *  (author and change text), injury authors and who rolled a pending advancement. */
function anonymiseTeamRecords(an: Anonymiser, tx: TextReplacer, t: Obj): boolean {
  let changed = false;
  const mark = (v: boolean) => { if (v) changed = true; };
  if (isObj(t.statusChanged)) mark(an.fields(t.statusChanged, ["by"], []));
  for (const h of objs(t.history)) {
    mark(an.fields(h, ["by"], []));
    for (const c of objs(h.changes)) mark(tx.texts(c, ["what", "from", "to"]));
  }
  for (const p of objs(t.players)) {
    for (const i of objs(p.injuries)) mark(an.fields(i, ["by"], []));
    // an advancement roll waiting for its pick (leagues/teamAdvance.ts): who rolled it
    if (isObj(p.pendingAdvance)) mark(an.fields(p.pendingAdvance, ["by"], []));
  }
  return changed;
}

function anonymiseSeason(an: Anonymiser, tx: TextReplacer, displays: ReadonlySet<string>, s: Obj): boolean {
  let changed = false;
  const mark = (v: boolean) => { if (v) changed = true; };
  const { linked } = seasonLinks(an.ids, s);
  for (const t of objs(s.teams)) {
    if (linked(t)) mark(LINKED_ROW(an, t));
    if (isObj(t.coachAssigned)) mark(an.fields(t.coachAssigned, ["by"], []));
    mark(anonymiseTeamRecords(an, tx, t));
    // Team library lane: who listed the team for takeover; the entry history's holders (by their own coach / account
    // only: a span never links through the team), who made each change, and the replaced rosters kept with it.
    if (isObj(t.takeover)) { mark(an.fields(t.takeover, ["by"], [])); mark(tx.texts(t.takeover, ["note"])); }
    if (isObj(t.swapRequest)) mark(an.fields(t.swapRequest, ["by"], []));
    for (const span of objs(t.entryHistory)) {
      if (linked({ coach: span.coach, coachId: span.coachId })) mark(LINKED_ROW(an, span));
      mark(an.fields(span, ["by"], []));
      if (isObj(span.outgoing)) {
        if (linked(span.outgoing)) mark(LINKED_ROW(an, span.outgoing));
        if (isObj(span.outgoing.coachAssigned)) mark(an.fields(span.outgoing.coachAssigned, ["by"], []));
        mark(anonymiseTeamRecords(an, tx, span.outgoing));
      }
    }
  }
  for (const f of objs(s.fixtures)) {
    for (const side of [f.home, f.away]) if (linked(side)) mark(LINKED_ROW(an, side as Obj));
    // The coach frozen with the result (records follow the coach of each game): linked by its own coach / account only.
    // A cleared result's kept stamp too, so a later restore can never bring the identity back.
    for (const side of [f.home, f.away]) {
      for (const key of ["playedBy", "clearedPlayedBy"]) {
        const played = isObj(side) ? (side as Obj)[key] : undefined;
        if (isObj(played) && linked({ coach: played.coach, coachId: played.coachId })) { mark(an.overwrite(played, ["coach"], ["nafUser"])); if (typeof played.coachId === "string" && played.coachId) { played.coachId = an.swap(played.coachId); changed = true; } }
      }
    }
    if (isObj(f.fork)) {
      for (const ft of vals(f.fork.teams)) mark(an.fields(ft, ["coach"], []));
      mark(an.fields(f.fork, ["generatedBy"], []));
      for (const l of objs(f.fork.log)) { mark(an.fields(l, ["by"], [])); mark(tx.texts(l, ["text"])); }
    }
    // Deadlines (deadlines.ts): the organiser who decided the fixture's deadline outcome.
    if (isObj(f.deadlineOutcome)) mark(an.fields(f.deadlineOutcome, ["by"], []));
    // The organiser who overrode the fixture's result (resultEdit).
    if (isObj(f.resultEdit)) mark(an.fields(f.resultEdit, ["by"], []));
    // Team page v2: the organiser who decided the fixture of an inactive team.
    if (isObj(f.inactiveDecision)) mark(an.fields(f.inactiveDecision, ["by"], []));
    // The organiser who entered a forfeit, or rolled its defections (leagues/forfeit.ts).
    if (isObj(f.forfeitDetail)) {
      mark(an.fields(f.forfeitDetail, ["by"], []));
      // The undo snapshot holds both rosters and the fixture result as they were: anonymised like the live ones, so an
      // undo can never bring a deleted coach's identity back.
      const undo = f.forfeitDetail.undo;
      if (isObj(undo)) {
        for (const t of vals(undo.teams)) {
          if (!isObj(t)) continue;
          if (linked(t)) mark(LINKED_ROW(an, t));
          if (isObj(t.coachAssigned)) mark(an.fields(t.coachAssigned, ["by"], []));
          mark(anonymiseTeamRecords(an, tx, t));
        }
        if (isObj(undo.fixture)) {
          if (isObj(undo.fixture.resultEdit)) mark(an.fields(undo.fixture.resultEdit, ["by"], []));
          if (isObj(undo.fixture.deadlineOutcome)) mark(an.fields(undo.fixture.deadlineOutcome, ["by"], []));
        }
      }
    }
    if (isObj(f.forfeitDraft)) mark(an.fields(f.forfeitDraft, ["by"], []));
  }
  if (isObj(s.deadlinePolicy)) mark(an.fields(s.deadlinePolicy, ["updatedBy"], []));
  for (const p of objs(s.participants)) {
    if (linked(p)) mark(LINKED_ROW(an, p));
    // Participants tab: the organiser who last changed the row's flags.
    if (isObj(p.flagsUpdated)) mark(an.fields(p.flagsUpdated, ["by"], []));
    if (isObj(p.paidUpdated)) mark(an.fields(p.paidUpdated, ["by"], []));
  }
  // League registrations (src/registration): the coach's own rows, and every decision / transition they made.
  for (const r of objs(s.registrations)) mark(anonymiseLeagueRegistration(an, tx, r));
  // Takeover applications (team library lane): the same field names as a registration row.
  for (const r of objs(s.takeoverApplications)) mark(anonymiseLeagueRegistration(an, tx, r));
  for (const ph of objs(s.phases)) for (const r of objs(ph.standings)) if (linked(r)) mark(LINKED_ROW(an, r));
  for (const h of objs(s.honours)) {
    for (const r of objs(h.rows)) {
      if (h.kind === "coach") {
        // a coach honour's row name IS the coach: linked by the display names found on the coach's linked rows
        if (typeof r.name === "string" && (displays.has(r.name.trim()) || an.matches(r.name))) mark(an.overwrite(r, ["name", "coach"], []));
      } else if (linked(r)) mark(an.overwrite(r, ["coach"], []));
    }
  }
  for (const a of objs(s.awards)) if (linked(a)) mark(LINKED_ROW(an, a));
  // Tournament-style ladder reset snapshots (ladderReset.ts): players and roster only. A snapshot stored with coach identity
  // (before that rule) loses it here, so a later reset can never bring a deleted coach's data back.
  for (const m of objs(isObj(s.ladder) ? s.ladder.members : undefined)) {
    const roster = isObj(m.reset) ? m.reset.roster : undefined;
    if (!isObj(roster)) continue;
    for (const k of RESET_IDENTITY_KEYS) if (k in roster) { delete roster[k]; changed = true; }
    mark(anonymiseTeamRecords(an, tx, roster));
  }
  // The podium record holds team refs only (its places are the awards above) plus who finished the season.
  if (isObj(s.podium)) mark(an.fields(s.podium, ["by"], []));
  for (const n of objs(s.news)) { mark(an.fields(n, ["by"], [])); mark(tx.texts(n, ["title", "body"])); }
  for (const l of objs(s.log)) { mark(an.fields(l, ["by"], [])); mark(tx.texts(l, ["text"])); }
  if (isObj(s.redraft)) {
    mark(an.fields(s.redraft, ["byCoach", "closedBy"], []));
    for (const t of objs(s.redraft.teams)) {
      const mine = leagueRowLinked(an.ids, t);
      if (mine) mark(LINKED_ROW(an, t));
      mark(an.fields(t, ["submittedBy"], []));
      if (isObj(t.rest)) mark(an.fields(t.rest, ["by"], []));
      if (isObj(t.override)) mark(an.fields(t.override, ["by"], []));
      if (mine && isObj(t.draft) && isObj(t.draft.team)) mark(LINKED_ROW(an, t.draft.team));
      // The draft roster carries the team's records into the next season (applyPendingDrafts): sanitised here too, for
      // every team, since an organiser's name can sit in any team's history.
      if (isObj(t.draft) && isObj(t.draft.team)) {
        if (isObj(t.draft.team.coachAssigned)) mark(an.fields(t.draft.team.coachAssigned, ["by"], []));
        mark(anonymiseTeamRecords(an, tx, t.draft.team));
      }
    }
    for (const l of objs(s.redraft.log)) { mark(an.fields(l, ["by"], [])); mark(tx.texts(l, ["text"])); }
  }
  return changed;
}

function anonymiseTabletopMatch(an: Anonymiser, tx: TextReplacer, m: Obj): boolean {
  let changed = false;
  const mark = (v: boolean) => { if (v) changed = true; };
  mark(an.fields(m.home, ["coach"], []));
  mark(an.fields(m.away, ["coach"], []));
  mark(an.fields(m, ["createdBy", "publishedBy"], []));
  mark(an.fields(m.confirmedBy, ["by"], []));
  // The organiser who entered a forfeit for the match (and the pending marker written before it applied).
  mark(an.fields(m.forfeit, ["by"], []));
  mark(an.fields(m.forfeitPending, ["by"], []));
  mark(an.keyedMap(m.confirmations)); // coach -> confirmation time: a known coach-keyed map
  mark(tx.texts(m, ["note"]));
  // Coach's comments (keyed by side, so the seat above carries the coach): their text, and who hid one.
  if (isObj(m.comments)) for (const c of [m.comments.home, m.comments.away]) { mark(tx.texts(c, ["text"])); if (isObj(c)) mark(an.fields(c.hidden, ["by"], [])); }
  return changed;
}

function anonymiseTabletopEvent(an: Anonymiser, e: Obj): boolean {
  let changed = an.fields(e, ["by"], []);
  if (isObj(e.payload)) {
    // seats / coin events carry the coaches of both sides
    if (an.fields(e.payload, ["caller", "coach"], [])) changed = true;
    for (const side of [e.payload.home, e.payload.away]) if (an.fields(side, ["coach"], [])) changed = true;
  }
  return changed;
}

// ---- delete steps (run in this order; each idempotent) -----------------------------------------------------------

export interface DeleteStep { id: string; run: (ctx: DeleteCtx) => Promise<StepStatus> | StepStatus }

const removeLibraryRows = (deps: PrivacyDeps, names: ReadonlySet<string>): void => {
  for (const f of ownLibraryRows(deps.libraryDir, names)) {
    const lock = acquireFileWriteLock(libraryWriteLockPath(deps.libraryDir, basename(f.path, ".json")));
    if (!lock) throw new Error("library file is locked");
    try {
      // re-read under the lock: only the coach's rows go, other owners' rows in the same file stay
      const rows = readJson<unknown>(f.path);
      if (!Array.isArray(rows)) continue;
      const keep = rows.filter((t) => !(isObj(t) && isMine(names, t.coach)));
      if (keep.length === rows.length) continue;
      if (keep.length === 0) unlinkIfExists(f.path); else atomicWriteTextFile(f.path, JSON.stringify(keep, null, 2));
    } finally {
      lock.release();
    }
  }
};

const removeSaves = (deps: PrivacyDeps, names: ReadonlySet<string>): void => {
  for (const f of ownSaveFiles(deps.builderSavesDir, names)) {
    for (const s of f.data.saves ?? []) if (typeof s.shareToken === "string" && /^[0-9a-f]{32}$/.test(s.shareToken)) unlinkIfExists(join(deps.builderSavesDir, "shares", `${s.shareToken}.json`));
    unlinkIfExists(f.path);
    unlinkIfExists(join(deps.builderSavesDir, ".locks", `${basename(f.path, ".json")}.lock`));
  }
  // share index entries that still point at the coach (a crash between the unlinks above)
  for (const p of listFiles(join(deps.builderSavesDir, "shares"), ".json")) if (isMine(names, readJson<{ coach?: string }>(p)?.coach)) unlinkIfExists(p);
};

const removeNotifications = (deps: PrivacyDeps, plan: DeletePlan): void => {
  for (const n of plan.coachNames) unlinkIfExists(join(deps.stateDir, "notifications", notificationFileName(notificationCoachKey(n))));
};

/** The coach's own friends / blocks / inbox files, and every other coach's friend and block rows naming them. */
const removeSocial = (deps: PrivacyDeps, plan: DeletePlan, names: ReadonlySet<string>): void => {
  for (const n of plan.coachNames) {
    unlinkIfExists(join(deps.stateDir, "friends", socialFileName(n)));
    unlinkIfExists(join(deps.stateDir, "blocks", socialFileName(n)));
    unlinkIfExists(join(deps.stateDir, "messages", "index", socialFileName(n)));
  }
  const drop = (o: Obj, field: string): boolean => {
    const rows = objs(o[field]);
    const kept = rows.filter((r) => !isMine(names, r.coach));
    if (kept.length === rows.length) return false;
    o[field] = kept;
    return true;
  };
  for (const p of listFiles(join(deps.stateDir, "friends"), ".json")) rewriteJson(p, (f) => [drop(f, "friends"), drop(f, "incoming"), drop(f, "outgoing")].some(Boolean));
  for (const p of listFiles(join(deps.stateDir, "blocks"), ".json")) rewriteJson(p, (b) => drop(b, "blocked"));
};

const removeSsoPending = (deps: PrivacyDeps, plan: DeletePlan): StepStatus => {
  if (!plan.discordHash || !deps.pendingSso) return "skipped";
  deps.pendingSso.deleteWhere((id) => sha256(id) === plan.discordHash);
  return "done";
};

export const DELETE_STEPS: DeleteStep[] = [
  {
    id: "sessions",
    run: ({ plan }) => { for (const n of plan.coachNames) deleteSessionsForCoach(n); return "done"; },
  },
  {
    id: "blocklist",
    run: ({ deps, plan }) => { if (!plan.blockHash) return "skipped"; addToBlocklist(deps.stateDir, plan.blockHash); return "done"; },
  },
  {
    // Results, replays and NAF games written later (the fork keeps the original names) are anonymised on write; a late
    // Discord callback for this account is refused for 24 h.
    id: "deleted-map",
    run: ({ deps, plan }) => {
      if (!deps.mapKey) throw new Error("PRIVACY_MAP_KEY missing");
      recordDeletedCoach(deps.stateDir, deps.mapKey, plan.coachNames.map(nameKey), plan.pseudonym, plan.nafId);
      if (plan.discordMark) markRecentDeletion(deps.stateDir, plan.discordMark);
      return "done";
    },
  },
  { id: "sso-pending", run: ({ deps, plan }) => removeSsoPending(deps, plan) },
  {
    id: "coach-avatar",
    run: async ({ deps, plan }): Promise<StepStatus> => { for (const n of plan.coachNames) await deleteCoachAvatarData(deps.coachAvatarsDir, n, plan.proxyKeys); return "done"; },
  },
  {
    id: "team-logos",
    run: async ({ deps, plan }): Promise<StepStatus> => {
      const store = avatarStoreFor(deps.teamAvatarsDir);
      for (const key of plan.teamKeys) await store.remove(key);
      for (const n of plan.coachNames) {
        try { rmdirSync(join(deps.teamAvatarsDir, sha256(n))); } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw e;
        }
      }
      return "done";
    },
  },
  { id: "builder-saves", run: ({ deps, names }) => { removeSaves(deps, names); return "done"; } },
  { id: "library", run: ({ deps, names }) => { removeLibraryRows(deps, names); return "done"; } },
  { id: "notifications", run: ({ deps, plan }) => { removeNotifications(deps, plan); return "done"; } },
  { id: "social", run: ({ deps, plan, names }) => { removeSocial(deps, plan, names); return "done"; } },
  {
    // Clubs: the coach's memberships and their own pending requests (with the note they wrote) go; a club that loses its
    // last admin gets its longest-standing member as admin, and one left without members is archived. Former-member rows
    // and "created by" stay under the pseudonym (the club's history). Free text that may name the coach - every club's
    // description and home region, and the notes on other coaches' pending requests - gets the free-text pass (exact
    // mentions of the coach's names and linked display names become the pseudonym). A club the coach created gets
    // `review` set, so admins know its text may need a look. The club picks on entries are anonymised with those
    // records (tournaments / leagues steps).
    id: "clubs",
    run: ({ deps, an, text }) => {
      const tx = text();
      rewriteJson(join(deps.stateDir, "clubs", "clubs.json"), (file) => vals(file.clubs).map((c) => {
        let changed = false;
        if (tx.texts(c, ["description", "homeRegion"])) changed = true;
        const members = objs(c.members);
        const kept = members.filter((m) => !an.matches(m.coach));
        if (kept.length !== members.length) {
          changed = true;
          if (kept.length && !kept.some((m) => m.role === "admin")) {
            const next = [...kept].sort((a, b) => String(a.joinedAt ?? "").localeCompare(String(b.joinedAt ?? "")))[0]!;
            next.role = "admin";
          }
          if (!kept.length && typeof c.archivedAt !== "string") c.archivedAt = new Date().toISOString();
          c.members = kept;
        }
        const requests = objs(c.requests);
        const keptRequests = requests.filter((r) => !an.matches(r.coach));
        if (keptRequests.length !== requests.length) { c.requests = keptRequests; changed = true; }
        for (const r of keptRequests) if (tx.texts(r, ["message"])) changed = true;
        for (const f of objs(c.former)) if (an.fields(f, ["coach"], [])) changed = true;
        if (an.fields(c, ["createdBy"], [])) { changed = true; c.review = { reason: "creator-deleted", at: new Date().toISOString() }; }
        if (changed && typeof c.revision === "number") c.revision += 1;
        return changed;
      }).some(Boolean));
      return "done";
    },
  },
  {
    // Club boards: the coach's posts stay (the thread keeps its shape) under their pseudonym, every post gets the
    // free-text pass, and their "last opened" / "told" marks go.
    id: "club-boards",
    run: ({ deps, an, text }) => {
      const tx = text();
      for (const path of listFiles(join(deps.stateDir, "boards"), ".json")) {
        rewriteJson(path, (b) => {
          const posts = objs(b.threads).flatMap((t) => [t, ...objs(t.replies)]);
          const changed = posts.map((p) => [an.fields(p, ["author"], []), tx.texts(p, ["text", "title"])].some(Boolean)).some(Boolean);
          let marks = false;
          for (const field of ["seen", "notified"] as const) {
            const map = b[field];
            if (!isObj(map)) continue;
            for (const k of Object.keys(map)) if (an.matches(k)) { delete map[k]; marks = true; }
          }
          // Moderation (league / tournament boards): the coach's reports and the mutes on them go; marks they set, mutes
          // and report decisions they made, and log entries by or about them stay under the pseudonym (the free-text pass
          // runs over every reason).
          if (Array.isArray(b.reports)) {
            const keep = objs(b.reports).filter((r) => !an.matches(r.reporter));
            if (keep.length !== b.reports.length) { b.reports = keep; marks = true; }
            for (const r of keep) if ([isObj(r.resolved) ? an.fields(r.resolved, ["by"], []) : false, tx.texts(r, ["reason"])].some(Boolean)) marks = true;
          }
          if (isObj(b.mutes)) {
            for (const [k, m] of Object.entries(b.mutes)) {
              if (an.matches(k) || (isObj(m) && an.matches(m.coach))) { delete (b.mutes as Obj)[k]; marks = true; continue; }
              if (isObj(m) && [an.fields(m, ["by"], []), tx.texts(m, ["reason"])].some(Boolean)) marks = true;
            }
          }
          for (const e of objs(b.log)) if ([an.fields(e, ["by", "coach"], []), tx.texts(e, ["reason"])].some(Boolean)) marks = true;
          for (const t of objs(b.threads)) {
            for (const p of [t, ...objs(t.replies)]) if (isObj(p.hidden) && an.fields(p.hidden, ["by"], [])) marks = true;
            for (const f of ["pinned", "locked"] as const) if (isObj(t[f]) && an.fields(t[f], ["by"], [])) marks = true;
          }
          return changed || marks;
        });
      }
      return "done";
    },
  },
  // Game-time proposals: every proposal naming the coach goes (both directions; the other coach loses the pending offer).
  { id: "schedule-proposals", run: ({ deps, names }) => { new ProposalStore(deps.stateDir).removeCoach(names); return "done"; } },
  {
    // Private threads stay for the other coach, with this coach shown as their pseudonym ("Deleted coach #n"); a thread
    // whose two coaches are both deleted goes.
    id: "anonymise-messages",
    run: ({ deps, an, text }) => {
      const tx = text();
      for (const path of listFiles(join(deps.stateDir, "messages", "threads"), ".json")) {
        // Organiser metadata (the competition name a message carries) gets the same free-text pass as the text.
        rewriteJson(path, (t) => [
          an.list(t.coaches),
          ...objs(t.messages).map((m) => [an.fields(m, ["from"], []), tx.texts(m, ["text"]), isObj(m.organiser) ? tx.texts(m.organiser, ["name"]) : false].some(Boolean)),
        ].some(Boolean));
        const after = readJson<Obj>(path);
        if (after && Array.isArray(after.coaches) && after.coaches.length > 0 && after.coaches.every((c) => isReservedCoachName(c))) unlinkIfExists(path);
      }
      // The pair map: a pair naming the deleted coach goes (a new account with the old name never reaches the old thread).
      for (const path of listFiles(join(deps.stateDir, "messages", "pairs"), ".json")) {
        const pair = readJson<Obj>(path);
        if (pair && Array.isArray(pair.coaches) && pair.coaches.some((c) => an.matches(c))) unlinkIfExists(path);
      }
      for (const path of listFiles(join(deps.stateDir, "messages", "index"), ".json")) {
        rewriteJson(path, (idx) => objs(idx.threads).map((e) => [an.fields(e, ["with", "lastFrom"], []), tx.texts(e, ["preview"])].some(Boolean)).some(Boolean));
      }
      return "done";
    },
  },
  {
    // Fixture lobby chats stay with the fixture (league history) with this coach shown as their pseudonym, in the
    // coach list, as the writer, on side stamps and in the text. System lines are templates ({home} / {away} /
    // {actor}): their names live only in structured fields (from, actor) and the league fixture, so no name survives
    // in them whatever its length.
    id: "anonymise-fixture-lobbies",
    run: ({ deps, an, text }) => {
      const tx = text();
      for (const path of listFiles(join(deps.stateDir, "fixture-lobbies"), ".json")) {
        rewriteJson(path, (l) => [
          an.list(l.coaches),
          ...objs(l.chat).map((m) => [an.fields(m, ["from", "actor"], []), tx.texts(m, ["text"])].some(Boolean)),
          ...vals(l.sides).map((st) => an.fields(st, ["by"], [])),
          isObj(l.started) ? an.fields(l.started, ["by"], []) : false,
          isObj(l.starting) ? an.fields(l.starting, ["by"], []) : false,
          isObj(l.askedOrganiser) ? an.fields(l.askedOrganiser, ["by"], []) : false,
        ].some(Boolean));
      }
      return "done";
    },
  },
  {
    // Mail prefs and deliveries go; the league-message audit keeps its counts with the sender anonymised. Suppression
    // hashes of bounced / complaining addresses stay (they hold no name and only stop mail to that address).
    id: "mail",
    run: ({ deps, plan, an }) => {
      rewriteNdjson(join(deps.stateDir, "mail", "audit.jsonl"), (e) => an.fields(e, ["sender"], []));
      if (!deps.mail) return "skipped";
      for (const n of plan.coachNames) deps.mail.forgetCoach(n);
      return "done";
    },
  },
  {
    id: "bug-reports",
    run: ({ deps, names }) => { for (const r of bugReportDirs(deps.bugReportsDir, names)) rmSync(r.path, { recursive: true, force: true }); return "done"; },
  },
  // Competition templates: the coach's own templates go, and every share grant naming them (strict: retried on failure).
  { id: "competition-templates", run: ({ deps, names }) => { new TemplateStore(deps.stateDir).removeCoach(names); return "done"; } },
  {
    // Organiser requests: the coach's rows stay (status and dates, for the admin audit) under the pseudonym with every
    // free-text field cleared; an admin's name on a decision becomes their pseudonym; other coaches' notes and reasons get
    // the free-text pass.
    id: "organiser-requests",
    run: ({ deps, an, text }) => {
      const tx = text();
      rewriteJson(organiserRequestsFile(deps), (d) => objs(d.requests).map((r) => {
        if (an.matches(r.coach)) {
          an.fields(r, ["coach", "decidedBy"], []); // both, when either names the coach (a self-decided request)
          Object.assign(r, { competition: "", region: "", note: "", links: [] });
          delete r.reason;
          return true;
        }
        return [an.fields(r, ["decidedBy"], []), tx.texts(r, ["competition", "region", "note", "reason"])].some(Boolean);
      }).some(Boolean));
      return "done";
    },
  },
  {
    id: "organiser-roles",
    run: ({ deps, names }) => {
      const list = readOrganizers(deps.organizersFile);
      if (list && list.some((o) => isMine(names, o))) {
        const raw = readJson<Obj>(deps.organizersFile!) ?? {};
        atomicWriteTextFile(deps.organizersFile!, json({ ...raw, organizers: list.filter((o) => !isMine(names, o)) }));
      }
      const tf = tournamentsFile(deps);
      const data = readJson<TournamentFile & Obj>(tf);
      if (data?.tournaments) {
        let changed = false;
        for (const t of Object.values(data.tournaments)) {
          if (Array.isArray(t.organizerCoachIds) && t.organizerCoachIds.some((o) => isMine(names, o))) {
            t.organizerCoachIds = t.organizerCoachIds.filter((o) => !isMine(names, o));
            changed = true;
          }
        }
        for (const series of Object.values(data.series ?? {})) {
          if (Array.isArray(series.organisers) && series.organisers.some((o) => isMine(names, o))) {
            series.organisers = series.organisers.filter((o) => !isMine(names, o));
            changed = true;
          }
        }
        if (changed) atomicWriteTextFile(tf, json(data));
      }
      for (const dir of leagueDirs(deps)) {
        const path = join(dir, "league.json");
        const league = readJson<Obj & { owner?: string; organisers?: unknown }>(path);
        if (!league || !Array.isArray(league.organisers)) continue;
        const organisers = league.organisers.filter((x): x is string => typeof x === "string");
        const owner = league.owner?.trim() || organisers[0]?.trim() || "";
        if (isMine(names, owner)) continue; // an owner blocks the delete before it starts
        if (!organisers.some((o) => isMine(names, o))) continue;
        const next = organisers.filter((o) => !isMine(names, o));
        // keep the owner explicit when the first organiser was the implicit owner
        atomicWriteTextFile(path, json({ ...league, ...(league.owner ? {} : owner ? { owner } : {}), organisers: next }));
      }
      return "done";
    },
  },
  {
    id: "tabletop-teams",
    run: ({ deps, names }) => {
      for (const p of listFiles(join(deps.tabletopDir, "teams"), ".json")) if (isMine(names, readJson<{ coach?: string }>(p)?.coach)) unlinkIfExists(p);
      return "done";
    },
  },
  {
    id: "anonymise-results",
    run: ({ deps, an }) => {
      rewriteJson(join(deps.stateDir, "tournament-results.json"), (d) => vals(d.results).map((r) => anonymiseResultRow(an, r)).some(Boolean));
      rewriteJson(join(deps.stateDir, "tournament-matches.json"), (d) =>
        vals(d.matches).map((m) => [an.fields(m.home, ["ffbCoachId"], []), an.fields(m.away, ["ffbCoachId"], [])].some(Boolean)).some(Boolean));
      return "done";
    },
  },
  { id: "anonymise-tournaments", run: ({ deps, an, text }) => { rewriteJson(tournamentsFile(deps), (d) => anonymiseTournaments(an, text(), d)); return "done"; } },
  {
    id: "anonymise-leagues",
    run: ({ deps, an, text, plan }) => {
      const tx = text();
      const others = otherCoachKeys(deps, an.ids);
      const displays = new Set(plan.displays.map((d) => d.trim()).filter((d) => d && !others.has(nameKey(d))));
      for (const dir of leagueDirs(deps)) {
        rewriteJson(join(dir, "league.json"), (l) => anonymiseLeagueFile(an, tx, l));
        for (const p of listFiles(join(dir, "seasons"), ".json")) rewriteJson(p, (s) => anonymiseSeason(an, tx, displays, s));
        rewriteJson(join(dir, "tourplay-import.json"), (f) => anonymiseTourplayImport(an, f));
      }
      return "done";
    },
  },
  {
    id: "anonymise-tabletop",
    run: ({ deps, an, text }) => {
      const tx = text();
      for (const p of listFiles(join(deps.tabletopDir, "matches"), ".json")) rewriteJson(p, (m) => anonymiseTabletopMatch(an, tx, m));
      for (const p of listFiles(join(deps.tabletopDir, "journals"), ".json")) {
        rewriteJson(p, (j) => {
          const parts = [
            an.fields(j, ["by"], []),
            isObj(j.match) ? anonymiseTabletopMatch(an, tx, j.match) : false,
            isObj(j.result) ? anonymiseResultRow(an, j.result.put) : false,
            ...[j.homeChain, j.awayChain].map((c) => (isObj(c) ? an.fields(c.target, ["coach"], []) : false)),
          ];
          return parts.some(Boolean);
        });
      }
      for (const p of listFiles(join(deps.tabletopDir, "events"), ".ndjson")) rewriteNdjson(p, (e) => anonymiseTabletopEvent(an, e));
      // The dice log: the roller of a roll and the coach who chose a block die (the rolls themselves stay).
      for (const p of listFiles(join(deps.tabletopDir, "dice"), ".ndjson")) rewriteNdjson(p, (e) => an.fields(e, ["by"], []));
      return "done";
    },
  },
  {
    id: "anonymise-ratings",
    run: ({ deps, an }) => { rewriteJson(join(deps.stateDir, "coach-titles.json"), (d) => an.keyedMap(d.titles)); return "done"; },
  },
  {
    id: "anonymise-naf",
    run: ({ deps, plan, an }) => {
      // Only a VERIFIED NAF id links NAF data to the coach; names never do. Without one the cache is left alone.
      const nafId = plan.nafId;
      if (!nafId) return "skipped";
      const path = join(deps.stateDir, "naf-games.json");
      const data = readJson<{ version?: number; coaches?: Record<string, Obj & { games?: Obj[] }> }>(path);
      if (!data?.coaches) return "skipped";
      let changed = false;
      if (Object.hasOwn(data.coaches, nafId)) { delete data.coaches[nafId]; changed = true; }
      for (const rec of Object.values(data.coaches)) {
        for (const g of objs(rec.games)) {
          const coaches = Array.isArray(g.coaches) ? (g.coaches as unknown[]) : [];
          const ids = Array.isArray(g.coachIds) ? (g.coachIds as unknown[]) : [];
          if (!ids.includes(nafId)) continue;
          g.coaches = coaches.map((c, i) => (ids[i] === nafId ? an.pseudonym : c));
          g.coachIds = ids.map((id) => (id === nafId ? null : id)); // only this coach's slot; the other keeps their link
          changed = true;
        }
      }
      if (changed) atomicWriteTextFile(path, json(data));
      return "done";
    },
  },
  {
    id: "anonymise-replays",
    run: ({ deps, an }) => {
      for (const p of listFiles(join(deps.stateDir, "replay-moments"), ".json")) {
        rewriteJson(p, (r) => isObj(r.teams) ? [an.fields(r.teams.home, ["coach"], []), an.fields(r.teams.away, ["coach"], [])].some(Boolean) : false);
      }
      return "done";
    },
  },
  {
    id: "anonymise-notifications",
    run: ({ deps, an, text }) => {
      const tx = text();
      // Other coaches' notifications that mention the deleted coach keep the event, with the name swapped.
      for (const path of listFiles(join(deps.stateDir, "notifications"), ".json")) {
        rewriteJson(path, (file) => objs(file.notifications).map((n) => [an.fields(n, ["from"], []), tx.texts(n, ["title", "body"])].some(Boolean)).some(Boolean));
      }
      deps.onCoachDeleted?.();
      return "done";
    },
  },
  {
    id: "identity",
    run: ({ plan }) => {
      // Last: the earlier steps no longer need the record. The identities write listeners drop the avatar upload too.
      const record = readIdentitiesStrict().coaches[normalizeFfbCoachId(plan.coach)];
      for (const n of plan.coachNames) removeIdentityRecord(n, record?.identities?.discordUserId);
      return "done";
    },
  },
  // The fork (game server) account comes last: nothing above ever waits on the fork DB. A fork that is down leaves only this
  // step and the final sweep pending (retried; the coach stays fenced).
  {
    id: "fork-account",
    run: async ({ deps, plan }): Promise<StepStatus> => {
      // Skipped only when no fork existed for this job at plan time; a fork configured then must be reached, so a host that
      // lost its fork config (or a fork that is down) keeps the step pending.
      if (!deps.disableForkAccount) {
        if (plan.forkRequired === false) return "skipped";
        throw new Error("fork not configured");
      }
      await deps.disableForkAccount(plan.coach); // throws when unreachable: the step stays pending
      return "done";
    },
  },
  {
    // Writes authorised before the fence that landed during the job: the private stores are swept once more.
    id: "final-sweep",
    run: async ({ deps, plan, names }): Promise<StepStatus> => {
      for (const n of plan.coachNames) deleteSessionsForCoach(n);
      removeSsoPending(deps, plan);
      removeSaves(deps, names);
      removeLibraryRows(deps, names);
      removeNotifications(deps, plan);
      removeSocial(deps, plan, names);
      new ProposalStore(deps.stateDir).removeCoach(names);
      new TemplateStore(deps.stateDir).removeCoach(names);
      if (deps.mail) for (const n of plan.coachNames) deps.mail.forgetCoach(n);
      for (const n of plan.coachNames) await deleteCoachAvatarData(deps.coachAvatarsDir, n, plan.proxyKeys);
      return "done";
    },
  },
];

export const deleteContext = (deps: PrivacyDeps, plan: DeletePlan): DeleteCtx => {
  const an = createAnonymiser(plan.coachNames, plan.pseudonym);
  const names = new Set(plan.coachNames.map(nameKey));
  let tx: TextReplacer | undefined;
  return {
    deps, plan, an, names,
    text: () => {
      if (tx) return tx;
      const others = otherCoachKeys(deps, names);
      return (tx = createTextReplacer(textAliases([...plan.coachNames, ...plan.displays], others), plan.pseudonym, [...others]));
    },
  };
};
