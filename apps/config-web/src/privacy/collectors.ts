/**
 * Privacy collector registry (spec 2026-10-31 §2 export, §3 delete): ONE place where every store that holds a coach's
 * data says what the export takes from it and what deletion does to it. A store added to the site must register here;
 * test/privacy.test.ts fails when a known store has no collector.
 *
 * Every function reads the store files directly under the configured paths (no in-memory copies), so the export and the
 * delete job behave the same inside the server and in tests.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { normalizeFfbCoachId, rawIdentityRecord, readIdentities, removeIdentityRecord } from "../auth/identitiesStore.js";
import { deleteSessionsForCoach, sessionsForCoach } from "../auth/session.js";
import { coachAvatarKey, coachProxyCacheKeys, deleteCoachAvatarData } from "../coachAvatars.js";
import { avatarStoreFor } from "../teamAvatars.js";
import { notificationCoachKey, notificationFileName } from "../notifications.js";
import { createAnonymiser, nameKey, type Anonymiser } from "./anonymise.js";
import { addToBlocklist, type StepStatus } from "./state.js";

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
  /** Called after the anonymisation steps rewrote store files: drop in-memory copies (coach titles). */
  afterAnonymise?: () => void;
  env?: NodeJS.ProcessEnv;
}

export interface ExportFile { name: string; content: string | Buffer }

export interface ExportCtx {
  deps: PrivacyDeps;
  /** The coach's own spelling (identity record), else the session name. */
  coach: string;
  /** Folded names that identify the coach's rows (coach name + NAF name). */
  keys: Set<string>;
  record?: Record<string, unknown>;
}

/** The plan written as the first journal line: everything the steps need, so a resumed job does the same thing. */
export interface DeletePlan {
  jobId: string;
  coach: string;
  /** Names of the coach's sessions / saves / files (the session name and the identity spelling). */
  coachNames: string[];
  /** Names replaced by the pseudonym in public history (coach names, display and NAF names unless another coach uses them). */
  aliases: string[];
  pseudonym: string;
  /** sha256 of the Discord user id (matches pending SSO entries without storing the id). */
  discordHash?: string;
  /** Blocklist entry for a banned coach (HMAC of the Discord id). */
  blockHash?: string;
  nafId?: string;
  /** Uploaded team logos to delete ("library:<id>" | "save:<id>"). */
  teamKeys: string[];
  /** Proxy-cache keys of the coach's Discord / admin-set avatar images. */
  proxyKeys: string[];
  actor: string;
  at: string;
}

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
const unlinkQuiet = (path: string): void => { try { unlinkSync(path); } catch { /* gone */ } };
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const isMine = (keys: Set<string>, value: unknown): boolean => typeof value === "string" && keys.has(nameKey(value));

/** Rewrite one JSON file through the anonymiser (atomic; untouched when nothing matched). */
function anonymiseJsonFile(path: string, an: Anonymiser): boolean {
  if (!existsSync(path)) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return false; }
  const { value, changed } = an.apply(parsed);
  if (changed) atomicWriteTextFile(path, json(value));
  return changed;
}

/** Same for an append-only NDJSON file (each line on its own; torn lines kept as they are). */
function anonymiseNdjsonFile(path: string, an: Anonymiser): boolean {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return false; }
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (!line.trim()) return line;
    try {
      const r = an.apply(JSON.parse(line) as unknown);
      if (!r.changed) return line;
      changed = true;
      return JSON.stringify(r.value);
    } catch { return line; }
  });
  if (changed) atomicWriteTextFile(path, lines.join("\n"));
  return changed;
}

// ---- store readers shared by export and plan --------------------------------------------------------------------

interface SaveFile { coach?: string; saves?: Array<Record<string, unknown> & { id?: string; shareToken?: string }> }

function ownSaveFiles(dir: string, names: Set<string>): Array<{ path: string; data: SaveFile }> {
  return listFiles(dir, ".json")
    .map((path) => ({ path, data: readJson<SaveFile>(path) }))
    .filter((f): f is { path: string; data: SaveFile } => Boolean(f.data && isMine(names, f.data.coach)));
}

function ownLibraryFiles(dir: string, names: Set<string>): Array<{ path: string; teams: Array<Record<string, unknown> & { teamId?: string }> }> {
  const out: Array<{ path: string; teams: Array<Record<string, unknown> & { teamId?: string }> }> = [];
  for (const path of listFiles(dir, ".json")) {
    const teams = readJson<unknown>(path);
    if (!Array.isArray(teams)) continue;
    const rows = teams as Array<Record<string, unknown> & { teamId?: string }>;
    const byName = names.has(nameKey(basename(path, ".json")));
    const byRows = rows.length > 0 && rows.every((t) => isMine(names, t.coach));
    if (byName || byRows) out.push({ path, teams: rows });
  }
  return out;
}

function bugReportDirs(dir: string, names: Set<string>): Array<{ path: string; report: Record<string, unknown> }> {
  return listDirs(dir)
    .map((path) => ({ path, report: readJson<Record<string, unknown>>(join(path, "report.json")) }))
    .filter((r): r is { path: string; report: Record<string, unknown> } => Boolean(r.report && isMine(names, r.report.coach)));
}

function readOrganizers(file: string | undefined): string[] | undefined {
  if (!file) return undefined;
  const raw = readJson<{ organizers?: unknown }>(file);
  return Array.isArray(raw?.organizers) ? raw!.organizers.filter((x): x is string => typeof x === "string") : undefined;
}

type TournamentFile = {
  tournaments?: Record<string, Record<string, unknown> & { name?: string; status?: string; ownerCoachId?: string; organizerCoachId?: string; organizerCoachIds?: string[] }>;
  entrants?: Record<string, Record<string, unknown> & { tournamentId?: string; coach?: { ffbCoachId?: string; coachId?: string } }>;
  scheduledMatches?: Record<string, Record<string, unknown> & { tournamentId?: string; home?: { coach?: { ffbCoachId?: string } }; away?: { coach?: { ffbCoachId?: string } } }>;
};
const tournamentsFile = (deps: PrivacyDeps): string => join(deps.tournamentsDir, "tournaments.json");
const leagueDirs = (deps: PrivacyDeps): string[] => listDirs(join(deps.stateDir, "leagues"));
const leagueJsonFiles = (deps: PrivacyDeps): string[] =>
  leagueDirs(deps).flatMap((d) => [join(d, "league.json"), ...listFiles(join(d, "seasons"), ".json")]).filter((p) => existsSync(p));

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

const strip = (o: Record<string, unknown>, ...fields: string[]): Record<string, unknown> => {
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
    id: "library",
    location: "FORK_LIBRARY_DIR",
    export: (ctx) => [{ name: "team-library.json", content: json(ownLibraryFiles(ctx.deps.libraryDir, ctx.keys).flatMap((f) => f.teams)) }],
    erase: ["library"],
  },
  {
    id: "fork-db",
    location: "Fork server DB (FORK_DB_HOST)",
    export: { none: "Game records live on the game server; the results the site keeps are in results.json." },
    erase: ["fork-account"],
  },
  {
    id: "tournaments",
    location: "TOURNAMENTS_DIR/tournaments.json",
    export: (ctx) => {
      const data = readJson<TournamentFile>(tournamentsFile(ctx.deps));
      const tName = (id?: string) => (id && data?.tournaments?.[id]?.name) || id || "";
      const entries = Object.values(data?.entrants ?? {}).filter((e) => isMine(ctx.keys, e.coach?.ffbCoachId) || isMine(ctx.keys, e.coach?.coachId))
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
      const mine = (o: { coach?: unknown; coachId?: unknown } | undefined) => Boolean(o && (isMine(ctx.keys, o.coach) || isMine(ctx.keys, o.coachId)));
      const leagues: unknown[] = [];
      for (const dir of leagueDirs(ctx.deps)) {
        const league = readJson<{ id?: string; name?: string; owner?: string; organisers?: string[] }>(join(dir, "league.json"));
        if (!league) continue;
        const seasons = listFiles(join(dir, "seasons"), ".json").map((p) => readJson<Record<string, unknown>>(p)).filter(Boolean) as Array<Record<string, unknown>>;
        const rows = seasons.map((s) => {
          const arr = (k: string) => (Array.isArray(s[k]) ? (s[k] as Array<Record<string, unknown>>) : []);
          return {
            season: s.name, number: s.number,
            teams: arr("teams").filter(mine),
            fixtures: arr("fixtures").filter((f) => mine(f.home as never) || mine(f.away as never)),
            participants: arr("participants").filter(mine),
            standings: arr("phases").flatMap((p) => (Array.isArray(p.standings) ? (p.standings as Array<Record<string, unknown>>) : []).filter(mine)),
            honours: arr("honours").flatMap((h) => (Array.isArray(h.rows) ? (h.rows as Array<Record<string, unknown>>) : []).filter(mine).map((r) => ({ category: h.category, stat: h.stat, ...r }))),
            awards: arr("awards").filter(mine),
          };
        }).filter((r) => r.teams.length + r.fixtures.length + r.participants.length + r.standings.length + r.honours.length + r.awards.length > 0);
        const role = isMine(ctx.keys, league.owner) ? "owner" : (league.organisers ?? []).some((o) => isMine(ctx.keys, o)) ? "organiser" : undefined;
        if (rows.length || role) leagues.push({ league: league.name ?? league.id, id: league.id, ...(role ? { role } : {}), seasons: rows });
      }
      return [{ name: "league-teams.json", content: json(leagues) }];
    },
    erase: ["organiser-roles", "anonymise-leagues"],
  },
  {
    id: "tabletop",
    location: "TABLETOP_DIR (matches/, events/, journals/, teams/)",
    export: (ctx) => {
      const out: unknown[] = [];
      for (const path of listFiles(join(ctx.deps.tabletopDir, "matches"), ".json")) {
        const m = readJson<Record<string, unknown> & { id?: string; home?: { coach?: string }; away?: { coach?: string }; createdBy?: string }>(path);
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
    erase: ["tabletop-teams", "anonymise-tabletop"],
  },
  {
    id: "tournament-results",
    location: "FORK_STATE_DIR/tournament-results.json",
    export: (ctx) => {
      const store = readJson<{ results?: Record<string, { home?: { coach?: string }; away?: { coach?: string } }> }>(join(ctx.deps.stateDir, "tournament-results.json"));
      const rows = Object.values(store?.results ?? {}).filter((r) => isMine(ctx.keys, r.home?.coach) || isMine(ctx.keys, r.away?.coach));
      const titles = readJson<{ titles?: Record<string, unknown> }>(join(ctx.deps.stateDir, "coach-titles.json"))?.titles ?? {};
      const title = Object.entries(titles).find(([k]) => ctx.keys.has(nameKey(k)))?.[1];
      const nafId = typeof (ctx.record?.identities as Record<string, unknown> | undefined)?.nafId === "string" ? String((ctx.record!.identities as Record<string, unknown>).nafId) : "";
      const naf = nafId ? readJson<{ coaches?: Record<string, unknown> }>(join(ctx.deps.stateDir, "naf-games.json"))?.coaches?.[nafId] : undefined;
      return [{ name: "results.json", content: json({ results: rows, ...(title ? { title } : {}), ...(naf ? { nafRecord: naf } : {}) }) }];
    },
    erase: ["anonymise-results"],
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
    id: "coach-registry",
    location: "COACH_REGISTRY_JSON (discord-bot data-store/coaches.json)",
    export: { none: "Owned by the Discord bot, not this site." },
    erase: { none: "Owned by the Discord bot; flagged for the owner." },
  },
  { id: "privacy-blocklist", location: "FORK_STATE_DIR/privacy/blocklist.json", export: { none: "Salted hashes only." }, erase: ["blocklist"] },
];

/** Every store the site is known to keep (spec §0 rows + stores found in the code). The registry must cover each. */
export const KNOWN_STORES = [
  "identities", "sessions", "discord-sso", "organizers", "coach-avatars", "team-avatars", "builder-saves", "library", "fork-db",
  "tournaments", "leagues", "tabletop", "tournament-results", "tournament-matches", "naf-games", "coach-titles", "replay-moments",
  "notifications", "bug-reports", "test-games", "logs", "fork-teams-xml", "coach-registry", "privacy-blocklist",
] as const;

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
league-teams.json       League teams, fixtures, standings, honours and awards that carry your name, and leagues you run.
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
  const identities = (record?.identities ?? {}) as Record<string, unknown>;
  const keys = new Set([nameKey(coach), nameKey(sessionCoach)]);
  if (typeof identities.nafName === "string" && identities.nafName.trim() && !otherCoachUses(identities.nafName, coach)) keys.add(nameKey(identities.nafName));
  const ctx: ExportCtx = { deps, coach, keys, ...(record ? { record } : {}) };
  const files: ExportFile[] = [];
  for (const store of STORE_COLLECTORS) {
    if (typeof store.export !== "function") continue;
    files.push(...(await store.export(ctx)));
  }
  files.push({ name: "README.txt", content: EXPORT_README });
  return files;
}

function otherCoachUses(name: string, coach: string): boolean {
  const k = nameKey(name);
  if (k === nameKey(coach)) return false;
  return Object.values(readIdentities().coaches).some((r) => nameKey(r.ffbCoachId) === k);
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
      for (const n of plan.coachNames) { try { rmdirSync(join(deps.teamAvatarsDir, sha256(n))); } catch { /* absent or not empty */ } }
      return "done";
    },
  },
  {
    id: "builder-saves",
    run: ({ deps, names }) => {
      for (const f of ownSaveFiles(deps.builderSavesDir, names)) {
        for (const s of f.data.saves ?? []) if (typeof s.shareToken === "string" && /^[0-9a-f]{32}$/.test(s.shareToken)) unlinkQuiet(join(deps.builderSavesDir, "shares", `${s.shareToken}.json`));
        unlinkQuiet(f.path);
        unlinkQuiet(join(deps.builderSavesDir, ".locks", `${f.path.split(/[\\/]/).pop()!.replace(/\.json$/, "")}.lock`));
      }
      // share index entries that still point at the coach (a crash between the two unlinks above)
      for (const p of listFiles(join(deps.builderSavesDir, "shares"), ".json")) if (isMine(names, readJson<{ coach?: string }>(p)?.coach)) unlinkQuiet(p);
      return "done";
    },
  },
  {
    id: "library",
    run: ({ deps, names }) => { for (const f of ownLibraryFiles(deps.libraryDir, names)) unlinkQuiet(f.path); return "done"; },
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
      for (const n of plan.coachNames) unlinkQuiet(join(deps.stateDir, "notifications", notificationFileName(notificationCoachKey(n))));
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
        const raw = readJson<Record<string, unknown>>(deps.organizersFile!) ?? {};
        atomicWriteTextFile(deps.organizersFile!, json({ ...raw, organizers: list.filter((o) => !isMine(names, o)) }));
      }
      const tf = tournamentsFile(deps);
      const data = readJson<TournamentFile & Record<string, unknown>>(tf);
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
        const league = readJson<Record<string, unknown> & { owner?: string; organisers?: unknown }>(path);
        if (!league || !Array.isArray(league.organisers)) continue;
        const organisers = league.organisers.filter((x): x is string => typeof x === "string");
        const owner = league.owner?.trim() || organisers[0]?.trim() || "";
        if (isMine(names, owner)) continue; // an owner blocks the delete before it starts
        if (!organisers.some((o) => isMine(names, o))) continue;
        // keep the owner explicit when the first organiser was the implicit owner
        const next = organisers.filter((o) => !isMine(names, o));
        atomicWriteTextFile(path, json({ ...league, ...(league.owner ? {} : owner ? { owner } : {}), organisers: next }));
      }
      return "done";
    },
  },
  {
    id: "tabletop-teams",
    run: ({ deps, names }) => {
      for (const p of listFiles(join(deps.tabletopDir, "teams"), ".json")) if (isMine(names, readJson<{ coach?: string }>(p)?.coach)) unlinkQuiet(p);
      return "done";
    },
  },
  {
    id: "anonymise-results",
    run: ({ deps, an }) => {
      anonymiseJsonFile(join(deps.stateDir, "tournament-results.json"), an);
      anonymiseJsonFile(join(deps.stateDir, "tournament-matches.json"), an);
      return "done";
    },
  },
  { id: "anonymise-tournaments", run: ({ deps, an }) => { anonymiseJsonFile(tournamentsFile(deps), an); return "done"; } },
  { id: "anonymise-leagues", run: ({ deps, an }) => { for (const p of leagueJsonFiles(deps)) anonymiseJsonFile(p, an); return "done"; } },
  {
    id: "anonymise-tabletop",
    run: ({ deps, an }) => {
      for (const p of listFiles(join(deps.tabletopDir, "matches"), ".json")) anonymiseJsonFile(p, an);
      for (const p of listFiles(join(deps.tabletopDir, "journals"), ".json")) anonymiseJsonFile(p, an);
      for (const p of listFiles(join(deps.tabletopDir, "events"), ".ndjson")) anonymiseNdjsonFile(p, an);
      return "done";
    },
  },
  {
    id: "anonymise-ratings",
    run: ({ deps, an }) => { anonymiseJsonFile(join(deps.stateDir, "coach-titles.json"), an); deps.afterAnonymise?.(); return "done"; },
  },
  {
    id: "anonymise-naf",
    run: ({ deps, plan, an }) => {
      const path = join(deps.stateDir, "naf-games.json");
      const data = readJson<{ version?: number; coaches?: Record<string, Record<string, unknown> & { games?: Array<Record<string, unknown>> }> }>(path);
      if (!data?.coaches) return "skipped";
      let changed = false;
      if (plan.nafId && Object.hasOwn(data.coaches, plan.nafId)) { delete data.coaches[plan.nafId]; changed = true; }
      for (const rec of Object.values(data.coaches)) {
        for (const g of rec.games ?? []) {
          const coaches = Array.isArray(g.coaches) ? (g.coaches as unknown[]) : [];
          const ids = Array.isArray(g.coachIds) ? (g.coachIds as unknown[]) : [];
          const hit = coaches.some((c) => typeof c === "string" && an.apply(c).changed) || (plan.nafId !== undefined && ids.includes(plan.nafId));
          if (!hit) continue;
          g.coaches = coaches.map((c, i) => (typeof c === "string" && (an.apply(c).changed || ids[i] === plan.nafId) ? an.pseudonym : c));
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
    run: ({ deps, an }) => { for (const p of listFiles(join(deps.stateDir, "replay-moments"), ".json")) anonymiseJsonFile(p, an); return "done"; },
  },
  {
    id: "anonymise-notifications",
    run: ({ deps, plan, an }) => {
      // Free text is matched on the coach names only (never display / Discord names, which can be ordinary words).
      const text = createAnonymiser(plan.coachNames, plan.pseudonym).text;
      // Other coaches' notifications that mention the deleted coach keep the event, with the name swapped.
      for (const path of listFiles(join(deps.stateDir, "notifications"), ".json")) {
        const file = readJson<{ notifications?: Array<Record<string, unknown>> } & Record<string, unknown>>(path);
        if (!file || !Array.isArray(file.notifications)) continue;
        let changed = false;
        const notifications = file.notifications.map((n) => {
          const next = { ...n };
          if (typeof n.from === "string" && an.apply(n.from).changed) next.from = an.pseudonym;
          for (const f of ["title", "body"] as const) if (typeof n[f] === "string") next[f] = text(n[f] as string);
          if (JSON.stringify(next) !== JSON.stringify(n)) changed = true;
          return next;
        });
        if (changed) atomicWriteTextFile(path, json({ ...file, notifications }));
      }
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
