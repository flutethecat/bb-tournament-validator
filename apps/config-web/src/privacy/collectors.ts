/**
 * Privacy collector registry (spec 2026-10-31 §2 export, §3 delete): ONE place where every store that holds a coach's
 * data says what the export takes from it and what deletion does to it. A store added to the site must register here;
 * test/privacy.test.ts fails when a known store has no collector.
 *
 * Ownership (which files and rows are the coach's, for the export and for deletion) is decided ONLY by the identity
 * store key of the coach (the session coach and the identity record's spelling, compared with the identity store's own
 * key function) and by verified links (an organiser-assigned / fork account coachId on league rows). Display names and
 * NAF names are aliases: they are used to anonymise public history, never to pick files to export or delete.
 *
 * Every function reads the store files directly under the configured paths (no in-memory copies), so the export and the
 * delete job behave the same inside the server and in tests. Only "already gone" (ENOENT) counts as a successful delete;
 * any other filesystem error fails the step so the journal retries it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { normalizeFfbCoachId, rawIdentityRecord, readIdentities, removeIdentityRecord } from "../auth/identitiesStore.js";
import { deleteSessionsForCoach, sessionsForCoach } from "../auth/session.js";
import { coachAvatarKey, coachProxyCacheKeys, deleteCoachAvatarData } from "../coachAvatars.js";
import { avatarStoreFor } from "../teamAvatars.js";
import { notificationCoachKey, notificationFileName } from "../notifications.js";
import { createAnonymiser, nameKey, type Anonymiser } from "./anonymise.js";
import { coachKeyHash } from "./fence.js";
import { addToBlocklist, recordDeletedCoach, type StepStatus } from "./state.js";

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
  /** The server's Discord SSO pending store. */
  pendingSso?: { deleteWhere(match: (discordId: string) => boolean): number };
  /** Disables the coach's fork (game server) account. Undefined = no fork on this host (the step is skipped). Throws when
   *  the fork cannot be reached: the step stays pending and is retried. */
  disableForkAccount?: (coach: string) => Promise<void>;
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
  /** Identity-store spellings that OWN files (the session name and the identity record's spelling). */
  coachNames: string[];
  /** Names replaced by the pseudonym in public history (coach names, display / NAF / Discord names unless another coach
   *  is called that). Never used to select files. */
  aliases: string[];
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
  /** Blocklist entry for a banned coach (HMAC of the Discord id). */
  blockHash?: string;
  /** Uploaded team logos to delete ("library:<id>" | "save:<id>"). */
  teamKeys: string[];
  /** Proxy-cache keys of the coach's Discord / admin-set avatar images. */
  proxyKeys: string[];
  actor: string;
  at: string;
  sealed: string;
}

export type DeletePlan = Omit<StoredPlan, "sealed"> & PlanSecrets;

export interface DeleteCtx { deps: PrivacyDeps; plan: DeletePlan; an: Anonymiser; names: Set<string> }

// ---- small fs helpers -------------------------------------------------------------------------------------------

const readJson = <T>(path: string): T | undefined => {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
};
const listFiles = (dir: string, ext: string): string[] => {
  try { return readdirSync(dir).filter((n) => n.endsWith(ext)).map((n) => join(dir, n)); } catch { return []; }
};
const listDirs = (dir: string): string[] => {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name)); } catch { return []; }
};
/** Only "already gone" is success; EACCES / EPERM / EBUSY fail the step. */
const unlinkIfExists = (path: string): void => {
  try { unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
};
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const isMine = (keys: Set<string>, value: unknown): boolean => typeof value === "string" && keys.has(nameKey(value));
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const vals = (v: unknown): Obj[] => (isObj(v) ? Object.values(v).filter(isObj) : []);

/** Rewrite one JSON file through a store-specific anonymiser (atomic; untouched when nothing matched). */
function rewriteJson(path: string, fn: (data: Obj) => boolean): void {
  if (!existsSync(path)) return;
  const data = readJson<unknown>(path);
  if (!isObj(data)) return;
  if (fn(data)) atomicWriteTextFile(path, json(data));
}

/** Same for an append-only NDJSON file (each line on its own; torn lines kept as they are). */
function rewriteNdjson(path: string, fn: (line: Obj) => boolean): void {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return; }
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (!line.trim()) return line;
    try {
      const obj = JSON.parse(line) as unknown;
      if (!isObj(obj) || !fn(obj)) return line;
      changed = true;
      return JSON.stringify(obj);
    } catch { return line; }
  });
  if (changed) atomicWriteTextFile(path, lines.join("\n"));
}

// ---- store readers shared by export and plan (ownership by identity key only) -----------------------------------

interface SaveFile { coach?: string; saves?: Array<Obj & { id?: string; shareToken?: string }> }

function ownSaveFiles(dir: string, names: Set<string>): Array<{ path: string; data: SaveFile }> {
  return listFiles(dir, ".json")
    .map((path) => ({ path, data: readJson<SaveFile>(path) }))
    .filter((f): f is { path: string; data: SaveFile } => Boolean(f.data && isMine(names, f.data.coach)));
}

/** A library file is the coach's only when it has rows and EVERY row's owner field is the coach (the file name is a
 *  sanitised hint that two coaches can share, so it never decides). */
function ownLibraryFiles(dir: string, names: Set<string>): Array<{ path: string; teams: Array<Obj & { teamId?: string }> }> {
  const out: Array<{ path: string; teams: Array<Obj & { teamId?: string }> }> = [];
  for (const path of listFiles(dir, ".json")) {
    const teams = readJson<unknown>(path);
    if (!Array.isArray(teams) || teams.length === 0) continue;
    const rows = teams as Array<Obj & { teamId?: string }>;
    if (rows.every((t) => isObj(t) && isMine(names, t.coach))) out.push({ path, teams: rows });
  }
  return out;
}

function bugReportDirs(dir: string, names: Set<string>): Array<{ path: string; report: Obj }> {
  return listDirs(dir)
    .map((path) => ({ path, report: readJson<Obj>(join(path, "report.json")) }))
    .filter((r): r is { path: string; report: Obj } => Boolean(r.report && isMine(names, r.report.coach)));
}

function readOrganizers(file: string | undefined): string[] | undefined {
  if (!file) return undefined;
  const raw = readJson<{ organizers?: unknown }>(file);
  return Array.isArray(raw?.organizers) ? raw!.organizers.filter((x): x is string => typeof x === "string") : undefined;
}

type TournamentFile = {
  tournaments?: Record<string, Obj & { name?: string; status?: string; ownerCoachId?: string; organizerCoachId?: string; organizerCoachIds?: string[] }>;
  entrants?: Record<string, Obj & { tournamentId?: string; coach?: { ffbCoachId?: string; coachId?: string } }>;
  scheduledMatches?: Record<string, Obj & { tournamentId?: string; home?: { coach?: { ffbCoachId?: string } }; away?: { coach?: { ffbCoachId?: string } } }>;
};
const tournamentsFile = (deps: PrivacyDeps): string => join(deps.tournamentsDir, "tournaments.json");
const leagueDirs = (deps: PrivacyDeps): string[] => listDirs(join(deps.stateDir, "leagues"));

/** A league row is the coach's by its verified account link (coachId); a row with no link only by an exact coach id. */
const leagueRowMine = (keys: Set<string>, o: unknown): boolean => {
  if (!isObj(o)) return false;
  if (typeof o.coachId === "string" && o.coachId.trim()) return isMine(keys, o.coachId);
  return isMine(keys, o.coach);
};

// ---- ownership (delete is blocked while the coach owns a tournament or a league) ---------------------------------

export interface OwnedItem { kind: "tournament" | "league"; id: string; name: string }

/** Draft/active tournaments and leagues the coach OWNS (an organiser seat is removed instead, never blocks). */
export function ownedItems(deps: PrivacyDeps, names: Set<string>): OwnedItem[] {
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
      const organisers = readOrganizers(ctx.deps.organizersFile) ?? [];
      const account = {
        ...(ctx.record ?? { ffbCoachId: ctx.coach }),
        legacyOrganiser: organisers.some((o) => nameKey(o) === nameKey(ctx.coach)),
        sessions: sessionsForCoach(ctx.coach),
      };
      return [{ name: "account.json", content: json(account) }];
    },
    erase: ["identity"],
  },
  { id: "sessions", location: "SESSIONS_FILE (sessions.json)", export: { none: "Listed in account.json without the session ids." }, erase: ["sessions"] },
  { id: "discord-sso", location: "data-store/discord-sso-{state,pending}.json", export: { none: "Ten-minute sign-in handshakes only." }, erase: ["sso-pending"] },
  { id: "organizers", location: "ORGANIZERS_FILE (organizers.json)", export: { none: "Shown as legacyOrganiser in account.json." }, erase: ["organiser-roles"] },
  {
    id: "coach-avatars",
    location: "COACH_AVATARS_DIR (uploads + proxy-cache/)",
    export: (ctx) => {
      const found = avatarStoreFor(ctx.deps.coachAvatarsDir).find(coachAvatarKey(ctx.coach));
      if (!found) return [];
      try { return [{ name: `avatar.${found.ext}`, content: readFileSync(found.path) }]; } catch { return []; }
    },
    erase: ["coach-avatar"],
  },
  {
    id: "team-avatars",
    location: "TEAM_AVATARS_DIR",
    export: (ctx) => {
      const store = avatarStoreFor(ctx.deps.teamAvatarsDir);
      const out: ExportFile[] = [];
      for (const key of teamKeysFor(ctx.deps, ctx.keys)) {
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
      const saves = ownSaveFiles(ctx.deps.builderSavesDir, ctx.keys).flatMap((f) => f.data.saves ?? [])
        .map((s) => ({ ...strip(s, "shareToken"), ...(s.shareToken ? { shared: true } : {}) }));
      return [{ name: "builder-saves.json", content: json(saves) }];
    },
    erase: ["builder-saves"],
  },
  {
    id: "team-library",
    location: "FORK_LIBRARY_DIR",
    export: (ctx) => [{ name: "team-library.json", content: json(ownLibraryFiles(ctx.deps.libraryDir, ctx.keys).flatMap((f) => f.teams)) }],
    erase: ["library"],
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
      const data = readJson<TournamentFile>(tournamentsFile(ctx.deps));
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
      const mine = (o: unknown) => leagueRowMine(ctx.keys, o);
      const leagues: unknown[] = [];
      for (const dir of leagueDirs(ctx.deps)) {
        const league = readJson<{ id?: string; name?: string; owner?: string; organisers?: string[] }>(join(dir, "league.json"));
        if (!league) continue;
        const seasons = listFiles(join(dir, "seasons"), ".json").map((p) => readJson<Obj>(p)).filter(isObj);
        const rows = seasons.map((s) => ({
          season: s.name, number: s.number,
          teams: objs(s.teams).filter(mine),
          fixtures: objs(s.fixtures).filter((f) => mine(f.home) || mine(f.away)),
          participants: objs(s.participants).filter(mine),
          standings: objs(s.phases).flatMap((p) => objs(p.standings).filter(mine)),
          awards: objs(s.awards).filter(mine),
        })).filter((r) => r.teams.length + r.fixtures.length + r.participants.length + r.standings.length + r.awards.length > 0);
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
      for (const path of listFiles(join(ctx.deps.tabletopDir, "matches"), ".json")) {
        const m = readJson<Obj & { id?: string; home?: { coach?: string }; away?: { coach?: string }; createdBy?: string }>(path);
        if (!m || !(isMine(ctx.keys, m.home?.coach) || isMine(ctx.keys, m.away?.coach) || isMine(ctx.keys, m.createdBy))) continue;
        let events: unknown[] = [];
        try {
          events = readFileSync(join(ctx.deps.tabletopDir, "events", `${String(m.id).replace(/[^\w-]/g, "_")}.ndjson`), "utf8")
            .split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as unknown]; } catch { return []; } });
        } catch { /* no events */ }
        out.push({ ...m, events });
      }
      const teams = listFiles(join(ctx.deps.tabletopDir, "teams"), ".json").map((p) => readJson<{ coach?: string }>(p)).filter((c) => c && isMine(ctx.keys, c.coach));
      return [{ name: "tabletop-matches.json", content: json({ matches: out, teamRevisions: teams }) }];
    },
    erase: ["anonymise-tabletop"],
  },
  {
    id: "tournament-results",
    location: "FORK_STATE_DIR/tournament-results.json",
    export: (ctx) => {
      const store = readJson<{ results?: Record<string, { home?: { coach?: string }; away?: { coach?: string } }> }>(join(ctx.deps.stateDir, "tournament-results.json"));
      const rows = Object.values(store?.results ?? {}).filter((r) => isMine(ctx.keys, r.home?.coach) || isMine(ctx.keys, r.away?.coach));
      const titles = readJson<{ titles?: Record<string, unknown> }>(join(ctx.deps.stateDir, "coach-titles.json"))?.titles ?? {};
      const title = Object.entries(titles).find(([k]) => ctx.keys.has(nameKey(k)))?.[1];
      const nafId = typeof (ctx.record?.identities as Obj | undefined)?.nafId === "string" ? String((ctx.record!.identities as Obj).nafId) : "";
      const naf = nafId ? readJson<{ coaches?: Record<string, unknown> }>(join(ctx.deps.stateDir, "naf-games.json"))?.coaches?.[nafId] : undefined;
      return [{ name: "results.json", content: json({ results: rows, ...(title ? { title } : {}), ...(naf ? { nafRecord: naf } : {}) }) }];
    },
    erase: ["anonymise-results", "deleted-map"],
  },
  { id: "tournament-matches", location: "FORK_STATE_DIR/tournament-matches.json", export: { none: "Match metadata only; the games are in results.json." }, erase: ["anonymise-results"] },
  { id: "naf-games", location: "FORK_STATE_DIR/naf-games.json", export: { none: "Included in results.json (nafRecord)." }, erase: ["anonymise-naf"] },
  { id: "coach-titles", location: "FORK_STATE_DIR/coach-titles.json", export: { none: "Included in results.json (title)." }, erase: ["anonymise-ratings"] },
  { id: "replay-moments", location: "FORK_STATE_DIR/replay-moments/", export: { none: "Public game highlights derived from the game server; no data beyond results.json." }, erase: ["anonymise-replays"] },
  {
    id: "notifications",
    location: "FORK_STATE_DIR/notifications/<coach>.json",
    export: (ctx) => {
      const file = readJson<{ notifications?: unknown[] }>(join(ctx.deps.stateDir, "notifications", notificationFileName(notificationCoachKey(ctx.coach))));
      return [{ name: "notifications.json", content: json(file?.notifications ?? []) }];
    },
    erase: ["notifications", "anonymise-notifications"],
  },
  {
    id: "bug-reports",
    location: "BUG_REPORTS_DIR",
    export: (ctx) => [{
      name: "bug-reports-index.json",
      content: json(bugReportDirs(ctx.deps.bugReportsDir, ctx.keys).map(({ path, report }) => ({
        id: path.split(/[\\/]/).pop(), submittedAt: report.submittedAt, kind: report.kind, gameId: report.gameId ?? null, description: report.description ?? "",
      }))),
    }],
    erase: ["bug-reports"],
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
  "privacy-blocklist", "lobby-chat", "desktop-claims", "translation-cache",
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
  "translation-cache": ["translation-cache"],
};

/** Team keys whose logos belong to the coach: their builder saves and library teams. */
export function teamKeysFor(deps: PrivacyDeps, names: Set<string>): string[] {
  const keys = new Set<string>();
  for (const f of ownSaveFiles(deps.builderSavesDir, names)) for (const s of f.data.saves ?? []) if (typeof s.id === "string") keys.add(`save:${s.id}`);
  for (const f of ownLibraryFiles(deps.libraryDir, names)) for (const t of f.teams) if (typeof t.teamId === "string") keys.add(`library:${t.teamId}`);
  return [...keys];
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
results.json            Game results with you as home or away coach, your rating title, and your cached NAF games.
notifications.json      Your notifications.
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
  blockHashOf: (discordId: string) => string;
  discordAvatarUrl: (id: string, hash: string | undefined) => string | null | undefined;
}

export function buildPlan(deps: PrivacyDeps, input: PlanInput): DeletePlan {
  const store = readIdentities();
  const record = store.coaches[normalizeFfbCoachId(input.sessionCoach)];
  const coach = record?.ffbCoachId ?? input.sessionCoach.trim();
  const coachNames = [...new Map([coach, input.sessionCoach.trim()].map((n) => [nameKey(n), n])).values()];
  const others = new Set(Object.values(store.coaches).map((r) => nameKey(r.ffbCoachId)).filter((k) => k !== nameKey(coach)));
  const extra = [record?.profile?.displayName, record?.identities?.nafName, record?.identities?.discordUsername]
    .filter((n): n is string => typeof n === "string" && n.trim().length >= 2 && !others.has(nameKey(n)));
  const aliases = [...new Map([...coachNames, ...extra].map((n) => [nameKey(n), n])).values()];
  const discordId = record?.identities?.discordUserId;
  const names = new Set(coachNames.map(nameKey));
  return {
    jobId: input.jobId,
    coachHash: coachKeyHash(coach),
    coach,
    coachNames,
    aliases,
    pseudonym: input.pseudonym,
    ...(discordId ? { discordHash: sha256(discordId) } : {}),
    ...(discordId && record?.banned ? { blockHash: input.blockHashOf(discordId) } : {}),
    ...(record?.identities?.nafId ? { nafId: record.identities.nafId } : {}),
    teamKeys: teamKeysFor(deps, names),
    proxyKeys: coachProxyCacheKeys(record, input.discordAvatarUrl),
    actor: input.actor,
    at: input.now.toISOString(),
  };
}

export const splitPlan = (plan: DeletePlan): { stored: Omit<StoredPlan, "sealed">; secrets: PlanSecrets } => {
  const { coach, coachNames, aliases, nafId, ...stored } = plan;
  return { stored, secrets: { coach, coachNames, aliases, ...(nafId ? { nafId } : {}) } };
};

// ---- per-store anonymisation (explicit coach fields only) --------------------------------------------------------

const SIDE = ["coach", "coachId"];

function anonymiseResultRow(an: Anonymiser, row: unknown): boolean {
  if (!isObj(row)) return false;
  const a = an.fields(row.home, ["coach"]);
  const b = an.fields(row.away, ["coach"]);
  return a || b;
}

function anonymiseTournaments(an: Anonymiser, data: Obj): boolean {
  let changed = false;
  const mark = (v: boolean) => { if (v) changed = true; };
  for (const t of vals(data.tournaments)) {
    mark(an.fields(t, ["ownerCoachId", "organizerCoachId"]));
    mark(an.list(t.organizerCoachIds));
    for (const n of objs(t.news)) { mark(an.fields(n, ["by"])); mark(an.texts(n, ["title", "body"])); }
  }
  const identity = ["coachId", "ffbCoachId"];
  for (const e of vals(data.entrants)) mark(an.fields(e.coach, identity, ["discordUserId"]));
  for (const m of vals(data.scheduledMatches)) {
    for (const s of [m.home, m.away]) if (isObj(s)) mark(an.fields(s.coach, identity, ["discordUserId"]));
    mark(an.fields(m.edited, ["byCoachId"]));
  }
  for (const st of vals(data.standings)) for (const r of objs(st.rows)) mark(an.fields(r, ["coachId"]));
  // Waiting-room leases are keyed "<matchId>\0<coach>" and short-lived: drop the coach's, never rename them.
  if (isObj(data.waitingPresence)) {
    for (const [k, lease] of Object.entries(data.waitingPresence)) {
      if (isObj(lease) && an.matches(lease.coachId)) { delete data.waitingPresence[k]; changed = true; }
    }
  }
  return changed;
}

/** League display names: rows linked to the coach's account (coachId) name their display coach and NAF user; those become
 *  aliases for the league's unlinked rows (imported standings, honours, awards). */
function leagueAliases(names: Set<string>, seasons: Obj[]): string[] {
  const out = new Set<string>();
  const take = (o: unknown) => {
    if (!isObj(o) || typeof o.coachId !== "string" || !names.has(nameKey(o.coachId))) return;
    for (const f of ["coach", "nafUser"]) if (typeof o[f] === "string" && (o[f] as string).trim().length >= 2) out.add(o[f] as string);
  };
  for (const s of seasons) {
    for (const t of objs(s.teams)) take(t);
    for (const f of objs(s.fixtures)) { take(f.home); take(f.away); }
    for (const p of objs(s.participants)) take(p);
    for (const a of objs(s.awards)) take(a);
    if (isObj(s.redraft)) for (const t of objs(s.redraft.teams)) take(t);
  }
  return [...out];
}

function anonymiseSeason(an: Anonymiser, s: Obj): boolean {
  let changed = false;
  const mark = (v: boolean) => { if (v) changed = true; };
  for (const t of objs(s.teams)) { mark(an.fields(t, SIDE)); if (isObj(t.coachAssigned)) mark(an.fields(t.coachAssigned, ["by"], [])); }
  for (const f of objs(s.fixtures)) { mark(an.fields(f.home, SIDE)); mark(an.fields(f.away, SIDE)); }
  for (const p of objs(s.participants)) mark(an.fields(p, SIDE));
  for (const ph of objs(s.phases)) for (const r of objs(ph.standings)) mark(an.fields(r, SIDE));
  for (const h of objs(s.honours)) {
    for (const r of objs(h.rows)) {
      mark(an.fields(r, ["coach"], []));
      if (h.kind === "coach") mark(an.fields(r, ["name"], [])); // a coach honour's row name IS the coach
    }
  }
  for (const a of objs(s.awards)) mark(an.fields(a, SIDE));
  for (const n of objs(s.news)) { mark(an.fields(n, ["by"], [])); mark(an.texts(n, ["title", "body"])); }
  for (const l of objs(s.log)) { mark(an.fields(l, ["by"], [])); mark(an.texts(l, ["text"])); }
  if (isObj(s.redraft)) {
    mark(an.fields(s.redraft, ["byCoach", "closedBy"], []));
    for (const t of objs(s.redraft.teams)) mark(an.fields(t, SIDE));
    for (const l of objs(s.redraft.log)) { mark(an.fields(l, ["by"], [])); mark(an.texts(l, ["text"])); }
  }
  return changed;
}

function anonymiseTabletopMatch(an: Anonymiser, m: Obj): boolean {
  let changed = false;
  const mark = (v: boolean) => { if (v) changed = true; };
  mark(an.fields(m.home, ["coach"], []));
  mark(an.fields(m.away, ["coach"], []));
  mark(an.fields(m, ["createdBy", "publishedBy"], []));
  mark(an.fields(m.confirmedBy, ["by"], []));
  mark(an.keyedMap(m.confirmations)); // coach -> confirmation time: a known coach-keyed map
  mark(an.texts(m, ["note"]));
  return changed;
}

// ---- delete steps (run in this order; each idempotent) -----------------------------------------------------------

export interface DeleteStep { id: string; run: (ctx: DeleteCtx) => Promise<StepStatus> | StepStatus }

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
    // Fork results pulled again later (the fork keeps the original names) are anonymised on write.
    id: "deleted-map",
    run: ({ deps, plan }) => { recordDeletedCoach(deps.stateDir, plan.coachNames.map(nameKey), plan.pseudonym, deps.env); return "done"; },
  },
  {
    id: "sso-pending",
    run: ({ deps, plan }) => {
      if (!plan.discordHash || !deps.pendingSso) return "skipped";
      deps.pendingSso.deleteWhere((id) => sha256(id) === plan.discordHash);
      return "done";
    },
  },
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
  {
    id: "builder-saves",
    run: ({ deps, names }) => {
      for (const f of ownSaveFiles(deps.builderSavesDir, names)) {
        for (const s of f.data.saves ?? []) if (typeof s.shareToken === "string" && /^[0-9a-f]{32}$/.test(s.shareToken)) unlinkIfExists(join(deps.builderSavesDir, "shares", `${s.shareToken}.json`));
        unlinkIfExists(f.path);
        unlinkIfExists(join(deps.builderSavesDir, ".locks", `${f.path.split(/[\\/]/).pop()!.replace(/\.json$/, "")}.lock`));
      }
      // share index entries that still point at the coach (a crash between the unlinks above)
      for (const p of listFiles(join(deps.builderSavesDir, "shares"), ".json")) if (isMine(names, readJson<{ coach?: string }>(p)?.coach)) unlinkIfExists(p);
      return "done";
    },
  },
  {
    id: "library",
    run: ({ deps, names }) => { for (const f of ownLibraryFiles(deps.libraryDir, names)) unlinkIfExists(f.path); return "done"; },
  },
  {
    id: "fork-account",
    run: async ({ deps, plan }): Promise<StepStatus> => {
      if (!deps.disableForkAccount) return "skipped";
      await deps.disableForkAccount(plan.coach); // throws when unreachable: the step stays pending
      return "done";
    },
  },
  {
    id: "notifications",
    run: ({ deps, plan }) => {
      for (const n of plan.coachNames) unlinkIfExists(join(deps.stateDir, "notifications", notificationFileName(notificationCoachKey(n))));
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
  { id: "anonymise-tournaments", run: ({ deps, an }) => { rewriteJson(tournamentsFile(deps), (d) => anonymiseTournaments(an, d)); return "done"; } },
  {
    id: "anonymise-leagues",
    run: ({ deps, an, names }) => {
      for (const dir of leagueDirs(deps)) {
        const seasonFiles = listFiles(join(dir, "seasons"), ".json");
        const seasons = seasonFiles.map((p) => readJson<Obj>(p)).filter(isObj);
        const others = new Set(Object.values(readIdentities().coaches).map((r) => nameKey(r.ffbCoachId)));
        const local = an.withAliases(leagueAliases(names, seasons).filter((a) => !others.has(nameKey(a)) || names.has(nameKey(a))));
        rewriteJson(join(dir, "league.json"), (l) => [local.fields(l, ["owner"], []), local.list(l.organisers)].some(Boolean));
        for (const p of seasonFiles) rewriteJson(p, (s) => anonymiseSeason(local, s));
      }
      return "done";
    },
  },
  {
    id: "anonymise-tabletop",
    run: ({ deps, an }) => {
      for (const p of listFiles(join(deps.tabletopDir, "matches"), ".json")) rewriteJson(p, (m) => anonymiseTabletopMatch(an, m));
      for (const p of listFiles(join(deps.tabletopDir, "journals"), ".json")) {
        rewriteJson(p, (j) => {
          const a = an.fields(j, ["by"], []);
          const b = isObj(j.match) ? anonymiseTabletopMatch(an, j.match) : false;
          const c = isObj(j.result) ? anonymiseResultRow(an, j.result.put) : false;
          return a || b || c;
        });
      }
      for (const p of listFiles(join(deps.tabletopDir, "events"), ".ndjson")) rewriteNdjson(p, (e) => an.fields(e, ["by"], []));
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
      const path = join(deps.stateDir, "naf-games.json");
      const data = readJson<{ version?: number; coaches?: Record<string, Obj & { games?: Obj[] }> }>(path);
      if (!data?.coaches) return "skipped";
      let changed = false;
      const nafId = plan.nafId; // only compared when defined
      if (nafId && Object.hasOwn(data.coaches, nafId)) { delete data.coaches[nafId]; changed = true; }
      for (const rec of Object.values(data.coaches)) {
        for (const g of objs(rec.games)) {
          const coaches = Array.isArray(g.coaches) ? (g.coaches as unknown[]) : [];
          const ids = Array.isArray(g.coachIds) ? (g.coachIds as unknown[]) : [];
          const hitAt = (i: number) => an.matches(coaches[i]) || (nafId !== undefined && ids[i] === nafId);
          if (!coaches.some((_, i) => hitAt(i))) continue;
          g.coaches = coaches.map((c, i) => (hitAt(i) ? an.pseudonym : c));
          delete g.coachIds;
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
    run: ({ deps, an }) => {
      // Other coaches' notifications that mention the deleted coach keep the event, with the name swapped.
      for (const path of listFiles(join(deps.stateDir, "notifications"), ".json")) {
        rewriteJson(path, (file) => objs(file.notifications).map((n) => [an.fields(n, ["from"], []), an.texts(n, ["title", "body"])].some(Boolean)).some(Boolean));
      }
      deps.onCoachDeleted?.();
      return "done";
    },
  },
  {
    id: "identity",
    run: ({ plan }) => {
      // Last: the earlier steps no longer need the record. The identities write listeners drop the avatar upload too.
      const record = readIdentities().coaches[normalizeFfbCoachId(plan.coach)];
      for (const n of plan.coachNames) removeIdentityRecord(n, record?.identities?.discordUserId);
      return "done";
    },
  },
];

export const deleteContext = (deps: PrivacyDeps, plan: DeletePlan): DeleteCtx => ({
  deps, plan, an: createAnonymiser(plan.aliases, plan.pseudonym), names: new Set(plan.coachNames.map(nameKey)),
});
