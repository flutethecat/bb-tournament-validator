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
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { acquireFileWriteLock, atomicWriteTextFile, libraryWriteLockPath } from "@bb/fork-ops";
import { normalizeFfbCoachId, rawIdentityRecord, readIdentities, readIdentitiesStrict, removeIdentityRecord, type CoachIdentityRecord } from "../auth/identitiesStore.js";
import { deleteSessionsForCoach, sessionsForCoach } from "../auth/session.js";
import { coachAvatarId, coachAvatarKey, coachProxyCacheKeys, deleteCoachAvatarData } from "../coachAvatars.js";
import { avatarStoreFor } from "../teamAvatars.js";
import { notificationCoachKey, notificationFileName } from "../notifications.js";
import { createAnonymiser, createTextReplacer, nameKey, textAliases, type Anonymiser, type TextReplacer } from "./anonymise.js";
import { coachKeyHash } from "./fence.js";
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
  scheduledMatches?: Record<string, Obj & { tournamentId?: string; home?: { coach?: { ffbCoachId?: string } }; away?: { coach?: { ffbCoachId?: string } } }>;
};
const tournamentsFile = (deps: PrivacyDeps): string => join(deps.tournamentsDir, "tournaments.json");
const leagueDirs = (deps: PrivacyDeps, strict = true): string[] => (strict ? listDirs(join(deps.stateDir, "leagues")) : (() => { try { return listDirs(join(deps.stateDir, "leagues")); } catch { return []; } })());

/** A league row is linked to the coach by its account link (coachId); a row without one only by an exact coach id. */
const leagueRowLinked = (keys: ReadonlySet<string>, o: unknown): boolean => {
  if (!isObj(o)) return false;
  if (typeof o.coachId === "string" && o.coachId.trim()) return isMine(keys, o.coachId);
  return isMine(keys, o.coach);
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
  for (const e of vals(readJson<TournamentFile>(tournamentsFile(deps))?.entrants)) if (isObj(e.coach)) add(e.coach.ffbCoachId);
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
      const entries = Object.values(data?.entrants ?? {}).filter((e) => isMine(ctx.keys, e.coach?.ffbCoachId))
        .map((e) => ({ tournament: tName(e.tournamentId), ...e }));
      // A fixture shows the opponent as on the public page: coach name and team only (never their Discord id).
      const side = (s: { coach?: { ffbCoachId?: string } } | undefined) => (s ? { ...s, coach: { ffbCoachId: s.coach?.ffbCoachId } } : s);
      const matches = Object.values(data?.scheduledMatches ?? {})
        .filter((m) => isMine(ctx.keys, m.home?.coach?.ffbCoachId) || isMine(ctx.keys, m.away?.coach?.ffbCoachId))
        .map((m) => ({ tournament: tName(m.tournamentId), ...m, home: side(m.home), away: side(m.away) }));
      const managed = Object.entries(data?.tournaments ?? {})
        .filter(([, t]) => isMine(ctx.keys, t.ownerCoachId ?? t.organizerCoachId) || (t.organizerCoachIds ?? []).some((o) => isMine(ctx.keys, o)))
        .map(([id, t]) => ({ id, name: t.name, status: t.status, role: isMine(ctx.keys, t.ownerCoachId ?? t.organizerCoachId) ? "owner" : "organiser" }));
      return [{ name: "tournament-entries.json", content: json({ entries, matches, managed }) }];
    },
    erase: ["organiser-roles", "anonymise-tournaments"],
  },
  {
    id: "leagues",
    location: "FORK_STATE_DIR/leagues/<id>/ (league.json, seasons/; secrets.json never read)",
    export: (ctx) => {
      const leagues: unknown[] = [];
      for (const dir of leagueDirs(ctx.deps, false)) {
        const league = readJsonLoose<{ id?: string; name?: string; owner?: string; organisers?: string[] }>(join(dir, "league.json"));
        if (!league) continue;
        let files: string[] = [];
        try { files = listFiles(join(dir, "seasons"), ".json"); } catch { /* none */ }
        const rows = files.map((p) => readJsonLoose<Obj>(p)).filter(isObj).map((s) => {
          const { linked } = seasonLinks(ctx.keys, s);
          return {
            season: s.name, number: s.number,
            teams: objs(s.teams).filter(linked),
            fixtures: objs(s.fixtures).filter((f) => linked(f.home) || linked(f.away)),
            participants: objs(s.participants).filter(linked),
            standings: objs(s.phases).flatMap((p) => objs(p.standings).filter(linked)),
            awards: objs(s.awards).filter(linked),
          };
        }).filter((r) => r.teams.length + r.fixtures.length + r.participants.length + r.standings.length + r.awards.length > 0);
        const role = isMine(ctx.keys, league.owner) ? "owner" : (league.organisers ?? []).some((o) => isMine(ctx.keys, o)) ? "organiser" : undefined;
        if (rows.length || role) leagues.push({ league: league.name ?? league.id, id: league.id, ...(role ? { role } : {}), seasons: rows });
      }
      return [{ name: "league-teams.json", content: json(leagues) }];
    },
    erase: ["organiser-roles", "anonymise-leagues"],
  },
  {
    id: "tabletop",
    location: "TABLETOP_DIR (matches/, events/, journals/)",
    export: (ctx) => {
      const out: unknown[] = [];
      let matchFiles: string[] = [];
      try { matchFiles = listFiles(join(ctx.deps.tabletopDir, "matches"), ".json"); } catch { /* none */ }
      for (const path of matchFiles) {
        const m = readJsonLoose<Obj & { id?: string; home?: { coach?: string }; away?: { coach?: string }; createdBy?: string }>(path);
        if (!m || !(isMine(ctx.keys, m.home?.coach) || isMine(ctx.keys, m.away?.coach) || isMine(ctx.keys, m.createdBy))) continue;
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
      return [{ name: "tabletop-matches.json", content: json({ matches: out, teamRevisions: teams }) }];
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
  "privacy-blocklist", "lobby-chat", "desktop-claims", "translation-cache", "mail",
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
  "translation-cache": ["translation-cache"], mail: ["mail"],
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
tournament-entries.json Your tournament entries, fixtures, and the tournaments you run.
league-teams.json       League teams, fixtures, standings and awards linked to your account, and leagues you run.
tabletop-matches.json   Tabletop matches you played or recorded, with their event logs, and your tabletop team history.
results.json            Game results with you as home or away coach, your rating title, and your cached NAF games
                        (when your NAF link is verified).
notifications.json      Your notifications.
mail.json               Your email settings (confirmed address, an open confirmation, league email choice) and the
                        emails queued or recently sent to you.
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
  }
  const identity = ["coachId", "ffbCoachId"];
  for (const e of vals(data.entrants)) {
    // The coach's own NAF answers at registration (NAF number, "not a NAF member") go with the entry's identity.
    if (isObj(e.coach) && an.matches(e.coach.ffbCoachId)) {
      for (const k of ["nafNumber", "notNafMember"]) if (k in e) { delete e[k]; changed = true; }
    }
    mark(an.fields(e.coach, identity, ["discordUserId"]));
  }
  for (const m of vals(data.scheduledMatches)) {
    for (const s of [m.home, m.away]) if (isObj(s)) mark(an.fields(s.coach, identity, ["discordUserId"]));
    mark(an.fields(m.edited, ["byCoachId"], []));
  }
  for (const st of vals(data.standings)) for (const r of objs(st.rows)) mark(an.fields(r, ["coachId"], []));
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

function anonymiseSeason(an: Anonymiser, tx: TextReplacer, displays: ReadonlySet<string>, s: Obj): boolean {
  let changed = false;
  const mark = (v: boolean) => { if (v) changed = true; };
  const { linked } = seasonLinks(an.ids, s);
  for (const t of objs(s.teams)) {
    if (linked(t)) mark(LINKED_ROW(an, t));
    if (isObj(t.coachAssigned)) mark(an.fields(t.coachAssigned, ["by"], []));
  }
  for (const f of objs(s.fixtures)) {
    for (const side of [f.home, f.away]) if (linked(side)) mark(LINKED_ROW(an, side as Obj));
    if (isObj(f.fork)) {
      for (const ft of vals(f.fork.teams)) mark(an.fields(ft, ["coach"], []));
      mark(an.fields(f.fork, ["generatedBy"], []));
      for (const l of objs(f.fork.log)) { mark(an.fields(l, ["by"], [])); mark(tx.texts(l, ["text"])); }
    }
  }
  for (const p of objs(s.participants)) if (linked(p)) mark(LINKED_ROW(an, p));
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
  mark(an.keyedMap(m.confirmations)); // coach -> confirmation time: a known coach-keyed map
  mark(tx.texts(m, ["note"]));
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
        rewriteJson(join(dir, "league.json"), (l) => [an.fields(l, ["owner"], []), an.list(l.organisers)].some(Boolean));
        for (const p of listFiles(join(dir, "seasons"), ".json")) rewriteJson(p, (s) => anonymiseSeason(an, tx, displays, s));
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
