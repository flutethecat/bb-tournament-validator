// Admin console v2 (spec-admin-console-v2-2026-11-04, owner 11-04): the server side of /app/admin that no older route
// covers. Site admins only, on every route (403 for organisers and coaches, 401 signed out). GETs never write. Writes are
// POST only (CSRF is enforced in front by src/auth/csrf.ts for cookie sessions). Every Operations action, dry run or
// apply, is logged (src/admin/opsLog.ts); applies need the typed phrase (400 without it), the ratings ones also the
// revision their dry run returned (428 missing, 409 stale), and one Operations write runs at a time (409 while busy).
//
//   GET  /api/admin/overview                     version, uptime, counts (read-only)
//   GET  /api/admin/moderation                   open board reports and running mutes across league and tournament boards
//   GET  /api/admin/ops/log?limit=               the Operations log, newest first
//   GET  /api/admin/ops/ratings                  the ratings state, a count of what a reset would touch, and the backups
//   POST /api/admin/ops/ratings/reset            {apply?, confirm?, revision?}            backup first, then the reset
//   POST /api/admin/ops/ratings/restore          {backup, apply?, confirm?, revision?}    backup of the live state, then restore
//   POST /api/admin/ops/demo-leagues             {action: "seed"|"remove", apply?, confirm?}
//   POST /api/admin/ops/fork-reload              {}                                       the game server reload, logged
//   POST /api/admin/ops/league-fork-cleanup      {apply?, confirm?}                       the league fork copy backfill, logged
//
// Moderation actions go through the competition boards' own routes (src/boards/competitionApi.ts); site admins moderate
// every board there, so this file only reads.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoardFile, BoardStore } from "../boards/board.js";
import { planDemoRemove, planDemoSeed, removeDemoLeagues, seedDemoLeagues } from "../leagues/demoLeagues.js";
import type { LeagueStore } from "../leagues/store.js";
import type { LeagueRecord } from "../leagues/types.js";
import {
  listRatingsBackups, planRatingsRestore, RatingsBackupError, resetRatingsWithBackup, restoreRatingsBackup,
} from "../ratings/backup.js";
import { ratingsStateStamp, readRatingsState } from "../ratings/state.js";
import type { TournamentRecord } from "../tournaments/types.js";
import { appendOpsLog, readOpsLog, type OpsLogEntry } from "./opsLog.js";

export const ADMIN_CONSOLE_PATH = /^\/api\/admin\/(?:overview|moderation|ops\/(?:log|ratings|ratings\/reset|ratings\/restore|demo-leagues|fork-reload|league-fork-cleanup))$/;
export const isAdminConsolePath = (path: string): boolean => ADMIN_CONSOLE_PATH.test(path);

/** The typed confirmations (the UI asks for these exact words; the server checks them). */
export const CONFIRM = {
  ratingsReset: "RESET RATINGS",
  ratingsRestore: "RESTORE RATINGS",
  demoSeed: "SEED DEMO LEAGUES",
  demoRemove: "REMOVE DEMO LEAGUES",
  forkCleanup: "APPLY CLEANUP",
} as const;

export interface AdminWho { coach: string; admin?: boolean }
export interface AdminResult { status: number; body: unknown }

export interface AdminConsoleDeps {
  stateDir: string;
  startedAt: Date;
  now(): Date;
  leagues: Pick<LeagueStore, "list" | "league">;
  /** The server's own league store, for the demo leagues (its cache stays the one source of truth). */
  leagueStore?: LeagueStore;
  tournaments: { all(): TournamentRecord[]; tournament(id: string): TournamentRecord | undefined };
  boards: Pick<BoardStore, "read" | "dir">;
  /** Coach accounts (identity records). */
  coachCount(): number;
  /** Bug reports and feedback still open (not resolved or closed). */
  openBugReports(): number;
  privacyJobs(): { open: Array<{ stuck?: boolean }>; failed: unknown[] };
  /** What the site ratings count now (coaches with a rating, rated games). */
  ratingsPreview(): { coaches: number; games: number };
  /** The game server reload (POST /api/fork/reload's body); absent when this host has no fork. */
  forkReload?(): Promise<AdminResult>;
  /** The league fork copy backfill (src/leagues/forkCleanup.ts leagueForkCleanupRoute). */
  forkCleanup?(who: AdminWho, input: { apply: boolean }): Promise<AdminResult>;
  /** Overrides for tests: the build-log file and the repo folder (git). */
  buildLogFile?: string;
  repoDir?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (status: number, body: unknown): AdminResult => ({ status, body });
const err = (status: number, error: string, extra: Record<string, unknown> = {}): AdminResult => json(status, { error, ...extra });
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

// ---- version (cached: git runs at most once per process) ----

let cachedCommit: { dir: string; sha: string | null } | undefined;
function gitShortSha(dir: string): string | null {
  if (cachedCommit?.dir === dir) return cachedCommit.sha;
  let sha: string | null = null;
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, timeout: 3000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString().trim();
    sha = /^[0-9a-f]{4,40}$/.test(out) ? out : null;
  } catch { sha = null; }
  cachedCommit = { dir, sha };
  return sha;
}

function buildLogHead(file: string): { date: string; title: string } | null {
  try {
    const rows = JSON.parse(readFileSync(file, "utf8")) as Array<{ date?: unknown; title?: unknown }>;
    const head = Array.isArray(rows) ? rows[0] : undefined;
    return head && typeof head.date === "string" && typeof head.title === "string" ? { date: head.date, title: head.title } : null;
  } catch { return null; }
}

// ---- moderation (read-only) ----

export interface ModerationReportRow {
  id: string; postId: string; threadId: string; reporter: string; reason: string; at: string;
  post: { author: string; text: string; removed: boolean; hidden: boolean } | null;
}
export interface ModerationBoardRow {
  scope: string; kind: "league" | "tournament"; id: string; name: string; href: string;
  enabled: boolean; publicRead: boolean;
  openReports: ModerationReportRow[];
  mutes: Array<{ coach: string; until: string; by: string; reason?: string }>;
}

function boardScopes(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  const scopes: string[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as { scope?: unknown };
      if (typeof raw.scope === "string" && /^(league|tournament):/.test(raw.scope)) scopes.push(raw.scope);
    } catch { scopes.push(`unreadable:${name}`); }
  }
  return scopes;
}

function findPost(file: BoardFile, postId: string): ModerationReportRow["post"] {
  for (const t of file.threads) {
    for (const p of [t, ...t.replies]) {
      if (p.id === postId) return { author: p.author, text: p.removed ? "" : p.text.slice(0, 200), removed: Boolean(p.removed), hidden: Boolean(p.hidden) };
    }
  }
  return null;
}

/** Open reports and running mutes on every league and tournament board. Reads files only; never writes. */
export function moderationAggregate(deps: Pick<AdminConsoleDeps, "boards" | "leagues" | "tournaments" | "now">): { boards: ModerationBoardRow[]; unreadable: number; openReports: number; mutes: number } {
  const now = deps.now().getTime();
  const rows: ModerationBoardRow[] = [];
  let unreadable = 0;
  for (const scope of boardScopes(deps.boards.dir)) {
    if (scope.startsWith("unreadable:")) { unreadable += 1; continue; }
    let file: BoardFile;
    try { file = deps.boards.read(scope); } catch { unreadable += 1; continue; }
    const [kind, id] = scope.split(/:(.*)/s) as ["league" | "tournament", string];
    const open = (file.reports ?? []).filter((r) => !r.resolved);
    const mutes = Object.values(file.mutes ?? {}).filter((m) => Date.parse(m.until) > now);
    if (!open.length && !mutes.length) continue;
    const name = kind === "league" ? (deps.leagues.league(id) as LeagueRecord | undefined)?.name : deps.tournaments.tournament(id)?.name;
    rows.push({
      scope, kind, id, name: name ?? id,
      href: kind === "league" ? `/app/leagues/${encodeURIComponent(id)}?tab=board` : `/app/tournaments/${encodeURIComponent(id)}?tab=board`,
      enabled: file.settings?.enabled !== false, publicRead: file.settings?.publicRead === true,
      openReports: open.map((r) => ({ id: r.id, postId: r.postId, threadId: r.threadId, reporter: r.reporter, reason: r.reason, at: r.at, post: findPost(file, r.postId) })),
      mutes: mutes.map((m) => ({ coach: m.coach, until: m.until, by: m.by, ...(m.reason ? { reason: m.reason } : {}) })),
    });
  }
  rows.sort((a, b) => b.openReports.length - a.openReports.length || a.name.localeCompare(b.name));
  return { boards: rows, unreadable, openReports: rows.reduce((n, r) => n + r.openReports.length, 0), mutes: rows.reduce((n, r) => n + r.mutes.length, 0) };
}

// ---- overview (read-only) ----

export function adminOverview(deps: AdminConsoleDeps): Record<string, unknown> {
  const now = deps.now();
  const repo = deps.repoDir ?? resolve(HERE, "../..");
  const safe = <T>(fn: () => T): T | null => { try { return fn(); } catch { return null; } };
  const jobs = safe(() => deps.privacyJobs());
  const moderation = safe(() => moderationAggregate(deps));
  return {
    version: { commit: gitShortSha(repo), buildLog: buildLogHead(deps.buildLogFile ?? resolve(HERE, "../../docs/build-log.json")) },
    startedAt: deps.startedAt.toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((now.getTime() - deps.startedAt.getTime()) / 1000)),
    node: process.version,
    // null = that store could not be read (the page says so instead of showing a wrong 0)
    counts: {
      coaches: safe(() => deps.coachCount()),
      leagues: safe(() => deps.leagues.list().length),
      tournaments: safe(() => deps.tournaments.all().length),
      openReports: safe(() => deps.openBugReports()),
      openBoardReports: moderation ? moderation.openReports : null,
      stuckPrivacyJobs: jobs ? jobs.open.filter((j) => j.stuck).length : null,
    },
  };
}

// ---- operations ----

let busy = false;
/** One Operations write at a time (a second one answers 409). Exported for tests. */
export async function exclusive(run: () => Promise<AdminResult>): Promise<AdminResult> {
  if (busy) return err(409, "Another admin operation is running. Try again in a moment.");
  busy = true;
  try { return await run(); } finally { busy = false; }
}

function log(deps: AdminConsoleDeps, who: AdminWho, entry: Omit<OpsLogEntry, "at" | "by">): string | undefined {
  try {
    appendOpsLog(deps.stateDir, { at: deps.now().toISOString(), by: who.coach, ...entry });
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Adds `logged` to a result body (false + the reason when the log could not be written). */
function logged(result: AdminResult, logError: string | undefined): AdminResult {
  return json(result.status, { ...obj(result.body), logged: !logError, ...(logError ? { logError } : {}) });
}

function confirmOk(input: Record<string, unknown>, phrase: string): boolean {
  return typeof input.confirm === "string" && input.confirm.trim() === phrase;
}

function ratingsView(deps: AdminConsoleDeps): AdminResult {
  const state = readRatingsState(deps.stateDir); // unreadable: throws, the route answers 500 (fail closed)
  let preview: { coaches: number; games: number } | null = null;
  try { preview = deps.ratingsPreview(); } catch { preview = null; }
  return json(200, { resetAt: state.resetAt ?? null, revision: ratingsStateStamp(deps.stateDir), preview, backups: listRatingsBackups(deps.stateDir), confirm: { reset: CONFIRM.ratingsReset, restore: CONFIRM.ratingsRestore } });
}

async function ratingsReset(deps: AdminConsoleDeps, who: AdminWho, input: Record<string, unknown>): Promise<AdminResult> {
  const apply = input.apply === true;
  const state = readRatingsState(deps.stateDir);
  let preview: { coaches: number; games: number } | null = null;
  try { preview = deps.ratingsPreview(); } catch { preview = null; }
  const revision = ratingsStateStamp(deps.stateDir);
  const facts = { previousResetAt: state.resetAt ?? null, coaches: preview?.coaches ?? null, games: preview?.games ?? null };
  if (!apply) {
    const out = json(200, { dryRun: true, ...facts, revision, confirm: CONFIRM.ratingsReset });
    return logged(out, log(deps, who, { action: "ratings-reset", dryRun: true, ok: true, status: 200, summary: `Dry run: ${facts.coaches ?? "?"} rated coaches over ${facts.games ?? "?"} games would reset to 1500.`, detail: facts }));
  }
  if (!confirmOk(input, CONFIRM.ratingsReset)) return err(400, `Type ${CONFIRM.ratingsReset} to confirm.`);
  if (typeof input.revision !== "string") return err(428, "Run the dry run first: the reset needs its revision.");
  if (input.revision !== revision) return err(409, "The ratings changed since the dry run. Run it again.", { revision });
  return exclusive(async () => {
    const done = resetRatingsWithBackup(deps.stateDir, deps.now());
    const out = json(200, { dryRun: false, ...facts, resetAt: done.state.resetAt, backup: done.backup, revision: ratingsStateStamp(deps.stateDir) });
    return logged(out, log(deps, who, { action: "ratings-reset", dryRun: false, ok: true, status: 200, summary: `Reset every rating to 1500; games count from ${done.state.resetAt}.`, backup: done.backup.name, detail: facts }));
  });
}

async function ratingsRestore(deps: AdminConsoleDeps, who: AdminWho, input: Record<string, unknown>): Promise<AdminResult> {
  const name = typeof input.backup === "string" ? input.backup.trim() : "";
  if (!name) return err(400, "Choose a backup.");
  const apply = input.apply === true;
  let plan;
  try { plan = planRatingsRestore(deps.stateDir, name); } catch (e) {
    if (e instanceof RatingsBackupError) return err(e.status, e.message);
    throw e;
  }
  if (!apply) {
    const out = json(200, { dryRun: true, ...plan, confirm: CONFIRM.ratingsRestore });
    return logged(out, log(deps, who, { action: "ratings-restore", dryRun: true, ok: true, status: 200, summary: `Dry run: restore ${name} (${plan.changes ? "would change the ratings state" : "no change"}).`, detail: { backup: name, changes: plan.changes } }));
  }
  if (!confirmOk(input, CONFIRM.ratingsRestore)) return err(400, `Type ${CONFIRM.ratingsRestore} to confirm.`);
  if (typeof input.revision !== "string") return err(428, "Run the dry run first: the restore needs its revision.");
  if (input.revision !== plan.revision) return err(409, "The ratings changed since the dry run. Run it again.", { revision: plan.revision });
  return exclusive(async () => {
    let done;
    try { done = restoreRatingsBackup(deps.stateDir, name, deps.now()); } catch (e) {
      if (e instanceof RatingsBackupError) return err(e.status, e.message);
      throw e;
    }
    const out = json(200, { dryRun: false, ...done.restored, safetyBackup: done.safety, revision: ratingsStateStamp(deps.stateDir) });
    return logged(out, log(deps, who, { action: "ratings-restore", dryRun: false, ok: true, status: 200, summary: `Restored ${name}.`, backup: done.safety.name, detail: { restored: name, changes: done.restored.changes } }));
  });
}

async function demoLeagues(deps: AdminConsoleDeps, who: AdminWho, input: Record<string, unknown>): Promise<AdminResult> {
  const action = input.action;
  if (action !== "seed" && action !== "remove") return err(400, 'action must be "seed" or "remove".');
  const apply = input.apply === true;
  const opts = { stateDir: deps.stateDir, now: deps.now(), ...(deps.leagueStore ? { store: deps.leagueStore } : {}) };
  const logAction = action === "seed" ? "demo-seed" : "demo-remove";
  if (!apply) {
    const plan = action === "seed" ? planDemoSeed(opts) : planDemoRemove(opts);
    const counts: Record<string, number> = {};
    for (const r of plan) counts[r.action] = (counts[r.action] ?? 0) + 1;
    const out = json(200, { dryRun: true, action, plan, counts, confirm: action === "seed" ? CONFIRM.demoSeed : CONFIRM.demoRemove });
    const summary = `Dry run: ${action} demo leagues (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing to do"}).`;
    return logged(out, log(deps, who, { action: logAction, dryRun: true, ok: true, status: 200, summary, detail: counts }));
  }
  if (!confirmOk(input, action === "seed" ? CONFIRM.demoSeed : CONFIRM.demoRemove)) return err(400, `Type ${action === "seed" ? CONFIRM.demoSeed : CONFIRM.demoRemove} to confirm.`);
  return exclusive(async () => {
    const lines: string[] = [];
    const ids = action === "seed"
      ? await seedDemoLeagues({ ...opts, log: (l) => lines.push(l) })
      : removeDemoLeagues({ ...opts, log: (l) => lines.push(l) });
    const out = json(200, { dryRun: false, action, ids, lines });
    return logged(out, log(deps, who, { action: logAction, dryRun: false, ok: true, status: 200, summary: action === "seed" ? `Seeded ${ids.length} demo leagues.` : `Removed ${ids.length} demo leagues.`, detail: { ids } }));
  });
}

async function forkReload(deps: AdminConsoleDeps, who: AdminWho): Promise<AdminResult> {
  if (!deps.forkReload) return err(503, "Super FUMBBL is not connected on this server.");
  return exclusive(async () => {
    const out = await deps.forkReload!();
    const b = obj(out.body);
    const summary = out.status !== 200 ? `Fork reload failed: ${String(b.error ?? out.status)}` : b.reloaded ? "Fork reloaded." : `Fork not reloaded: ${String(b.reason ?? "no reason given")}`;
    return logged(out, log(deps, who, { action: "fork-reload", dryRun: false, ok: out.status === 200, status: out.status, summary, detail: { reloaded: b.reloaded === true, ...(typeof b.replayedResults === "number" ? { replayedResults: b.replayedResults } : {}) } }));
  });
}

async function forkCleanup(deps: AdminConsoleDeps, who: AdminWho, input: Record<string, unknown>): Promise<AdminResult> {
  if (!deps.forkCleanup) return err(503, "Super FUMBBL is not connected on this server.");
  const apply = input.apply === true;
  if (apply && !confirmOk(input, CONFIRM.forkCleanup)) return err(400, `Type ${CONFIRM.forkCleanup} to confirm.`);
  return exclusive(async () => {
    const out = await deps.forkCleanup!(who, { apply });
    const rows = Array.isArray(obj(out.body).rows) ? (obj(out.body).rows as unknown[]) : [];
    const summary = out.status !== 200 ? `League fork cleanup failed: ${String(obj(out.body).error ?? out.status)}` : `${apply ? "Applied" : "Dry run"}: ${rows.length} fixture(s) with Super FUMBBL team copies to remove.`;
    const result = json(out.status, { ...obj(out.body), confirm: CONFIRM.forkCleanup });
    return logged(result, log(deps, who, { action: "league-fork-cleanup", dryRun: !apply, ok: out.status === 200, status: out.status, summary, detail: { fixtures: rows.length } }));
  });
}

/**
 * The admin console routes. `who` is the signed-in identity (undefined when signed out); `body` the parsed JSON object of a
 * POST. Answers undefined for paths it does not own.
 */
export async function adminConsoleApi(method: string, path: string, who: AdminWho | undefined, body: unknown, deps: AdminConsoleDeps, query?: URLSearchParams): Promise<AdminResult | undefined> {
  if (!isAdminConsolePath(path)) return undefined;
  if (!who) return err(401, "Authentication required.");
  if (who.admin !== true) return err(403, "Site admins only.");
  const reads = new Set(["/api/admin/overview", "/api/admin/moderation", "/api/admin/ops/log", "/api/admin/ops/ratings"]);
  if (reads.has(path)) {
    if (method !== "GET" && method !== "HEAD") return err(405, "Use GET.");
    try {
      if (path === "/api/admin/overview") return json(200, adminOverview(deps));
      if (path === "/api/admin/moderation") return json(200, moderationAggregate(deps));
      if (path === "/api/admin/ops/log") {
        const limit = Math.max(1, Math.min(500, Number.parseInt(query?.get("limit") ?? "100", 10) || 100));
        return json(200, { entries: readOpsLog(deps.stateDir, limit) });
      }
      return ratingsView(deps);
    } catch (e) {
      return err(500, (e as Error).message);
    }
  }
  if (method !== "POST") return err(405, "Use POST.");
  const input = obj(body);
  try {
    if (path === "/api/admin/ops/ratings/reset") return await ratingsReset(deps, who, input);
    if (path === "/api/admin/ops/ratings/restore") return await ratingsRestore(deps, who, input);
    if (path === "/api/admin/ops/demo-leagues") return await demoLeagues(deps, who, input);
    if (path === "/api/admin/ops/fork-reload") return await forkReload(deps, who);
    return await forkCleanup(deps, who, input);
  } catch (e) {
    const message = (e as Error).message;
    log(deps, who, { action: path.slice("/api/admin/ops/".length), dryRun: input.apply !== true, ok: false, status: 500, summary: `Failed: ${message}` });
    return err(500, message);
  }
}
