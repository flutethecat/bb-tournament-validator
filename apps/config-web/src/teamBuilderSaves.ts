/**
 * Team Builder saves — a signed-in coach's saved builder sheets (owner feature 10-22).
 *
 * The fork store holds a BUILT team as XML + a library row, but not the builder request that
 * produced it (package, picks with chosenSkills/chosenStatIncreases, sideline, inducements,
 * special rule). This supplemental store keeps that body so the HTML builder can recall a sheet,
 * and links it to the fork `teamId` once built. One JSON file per coach under the config-web
 * data-store, named by the sha256 of the EXACT coach name (fork coach names are case-sensitive, so
 * the key must be injective: "Foo"/"foo", "A B"/"A_B" and Windows device names never collide), written
 * atomically under a per-coach file lock. Identity is ALWAYS the caller's proven session coach —
 * this module never takes a coach from a request body or query.
 */

import { createHash, randomBytes } from "node:crypto";
import { assertNotFenced } from "./privacy/fence.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { acquireFileWriteLock, atomicWriteTextFile } from "@bb/fork-ops";
import { teamBuilderBoundsError, teamBuilderWireError } from "./teamBuilderWire.js";
import { parseLeaguePackageName, type LeagueBuilderRef } from "./leagueBuilderMarker.js";

export const TEAM_BUILDER_SAVES_BODY_CAP = 64 * 1024;
export const TEAM_BUILDER_SAVES_PER_COACH = 100;
const NAME_MAX = 80;

export interface TeamBuilderSaveSummary {
  id: string;
  name: string;
  packageName: string | null;
  rosterId: string;
  raceName: string;
  teamId: string | null;
  updatedAt: string;
  createdAt: string;
  /** Public share link token (owner 10-27): 32 hex chars, present only while the save is shared.
   *  Only ever returned to the OWNING coach (their own list / save); the public read never echoes it. */
  shareToken?: string;
  sharedAt?: string;
  /** Roster Builder league mode (lane L7): the league season the team was built for, derived from body.packageName
   *  ("league:<leagueId>:<seasonId>") on every write, so a league registration (L6) can submit the save. */
  league?: LeagueBuilderRef;
}

export interface TeamBuilderSave extends TeamBuilderSaveSummary {
  /** The builder request body (TeamBuilderBody) minus `password`. */
  body: Record<string, unknown>;
  /** Optional last preview summary the client chose to keep with the sheet. */
  lastPreview?: Record<string, unknown>;
}

export type SaveResult =
  | { ok: true; status: 200 | 201; save: TeamBuilderSave }
  | { ok: false; status: 400 | 404 | 409 | 422; error: string };

/** Injective, filesystem-safe key for an exact coach name. */
export const coachSaveKey = (coach: string): string => createHash("sha256").update(coach, "utf8").digest("hex");
const safeKey = coachSaveKey;
const fileFor = (dir: string, coach: string): string => join(dir, `${safeKey(coach)}.json`);
const lockFor = (dir: string, coach: string): string => join(dir, ".locks", `${safeKey(coach)}.lock`);

/** Read a coach's saves (empty when none / unreadable). Saves of another coach can't leak in:
 *  each file also records its owner and rows are filtered on it. */
export function readSaves(dir: string, coach: string): TeamBuilderSave[] {
  const file = fileFor(dir, coach);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { coach?: string; saves?: TeamBuilderSave[] };
    if (!parsed || typeof parsed.coach !== "string" || parsed.coach !== coach) return [];
    return Array.isArray(parsed.saves) ? parsed.saves : [];
  } catch {
    return [];
  }
}

function withSaves<T>(dir: string, coach: string, fn: (saves: TeamBuilderSave[]) => { saves?: TeamBuilderSave[]; out: T }): T {
  assertNotFenced(coach); // a delete is running for this coach: never recreate their saves
  const lock = acquireFileWriteLock(lockFor(dir, coach));
  if (!lock) throw new Error("Another save is in progress; try again.");
  try {
    const { saves, out } = fn(readSaves(dir, coach));
    if (saves) atomicWriteTextFile(fileFor(dir, coach), JSON.stringify({ coach, saves }, null, 2));
    return out;
  } finally {
    lock.release();
  }
}

export const summarizeSave = (s: TeamBuilderSave): TeamBuilderSaveSummary => ({
  id: s.id,
  name: s.name,
  packageName: s.packageName,
  rosterId: s.rosterId,
  raceName: s.raceName,
  teamId: s.teamId,
  updatedAt: s.updatedAt,
  createdAt: s.createdAt,
  ...(s.shareToken ? { shareToken: s.shareToken, sharedAt: s.sharedAt } : {}),
  ...(s.league ? { league: { ...s.league } } : {}),
});

/** The league season a save body was built for (league mode), or undefined. */
const leagueOf = (body: Record<string, unknown>): LeagueBuilderRef | undefined => parseLeaguePackageName(body.packageName) ?? undefined;

/** TeamBuilderBody fields a BUILD may persist into a save (unknown fields are dropped). Audited
 *  against team-builder.js requestBody(): every field it sends except `coach` (the session coach
 *  always wins) — incl. `skillPack`, the chosen choose-one skill package. */
const BUILD_BODY_FIELDS = [
  "rosterId", "teamName", "picks", "reRolls", "apothecary", "cheerleaders", "assistantCoaches",
  "dedicatedFans", "specialRule", "budget", "custom", "packageName", "skillPack", "teamId", "ignoreLimits",
  "rosteredInducements", "inducements",
] as const;
const INDUCEMENT_FIELDS = ["key", "count"] as const;
const PICK_FIELDS = ["positionId", "count", "chosenSkills", "chosenStatIncreases", "chosenStats", "captain", "names"] as const;

function pickFields<K extends string>(src: Record<string, unknown>, keys: readonly K[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/** Whitelist a build body to TeamBuilderBody fields (and pick fields) for storage. */
export function buildBodyForSave(body: Record<string, unknown>): Record<string, unknown> {
  const out = pickFields(body, BUILD_BODY_FIELDS);
  const each = (list: unknown, keys: readonly string[]) =>
    Array.isArray(list)
      ? list.map((p) => (p && typeof p === "object" && !Array.isArray(p) ? pickFields(p as Record<string, unknown>, keys) : p))
      : list;
  if (out.picks !== undefined) out.picks = each(out.picks, PICK_FIELDS);
  if (out.rosteredInducements !== undefined) out.rosteredInducements = each(out.rosteredInducements, INDUCEMENT_FIELDS);
  if (out.inducements !== undefined) out.inducements = each(out.inducements, INDUCEMENT_FIELDS);
  return out;
}

/** Text fields a stored sheet may carry must be plain strings (an object like {"toString": null} would pass the
 *  length checks and later throw wherever the value is turned into text, e.g. the public share read). */
const SAVE_STRING_FIELDS = ["rosterId", "teamName", "coach", "specialRule", "packageName", "skillPack", "teamId"] as const;
function saveFieldTypeError(body: Record<string, unknown>): string | null {
  for (const key of SAVE_STRING_FIELDS) if (body[key] !== undefined && typeof body[key] !== "string") return `${key} must be a string when supplied.`;
  for (const key of ["picks", "rosteredInducements", "inducements"] as const) {
    const list = body[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return `each ${key} entry must be an object.`;
      const named = key === "picks" ? (item as Record<string, unknown>).positionId : (item as Record<string, unknown>).key;
      if (typeof named !== "string") return `each ${key} entry must name its ${key === "picks" ? "positionId" : "key"} as a string.`;
    }
  }
  return null;
}

/** Strip credentials and validate a builder body for storage. Over-limit bodies (teamBuilderBoundsError)
 *  report `status: 422` so the save routes can tell them apart from malformed ones. */
export function sanitizeSaveBody(body: unknown): { body: Record<string, unknown> } | { error: string; status?: 422 } {
  const bounds = body && typeof body === "object" && !Array.isArray(body) ? teamBuilderBoundsError(body) ?? saveFieldTypeError(body as Record<string, unknown>) : null;
  if (bounds) return { error: bounds, status: 422 };
  const wire = teamBuilderWireError(body);
  if (wire) return { error: wire };
  // Never persist credentials; `saveId` is a build-route directive, not part of the sheet.
  const { password: _password, saveId: _saveId, ...rest } = body as Record<string, unknown>;
  if (typeof rest.rosterId !== "string" || !rest.rosterId.trim()) return { error: "body.rosterId is required." };
  if (rest.picks !== undefined && !Array.isArray(rest.picks)) return { error: "body.picks must be an array when supplied." };
  return { body: rest };
}

function parseName(name: unknown, fallback?: string): string | { error: string } {
  if (name === undefined && fallback !== undefined) return fallback;
  if (typeof name !== "string" || !name.trim()) return { error: "name must be a non-empty string." };
  if (name.trim().length > NAME_MAX) return { error: `name must be at most ${NAME_MAX} characters.` };
  return name.trim();
}

function parsePreview(v: unknown): { value?: Record<string, unknown> } | { error: string } {
  if (v === undefined) return {};
  if (v && typeof v === "object" && !Array.isArray(v)) return { value: v as Record<string, unknown> };
  return { error: "lastPreview must be an object when supplied." };
}

const newId = (): string => `sv_${randomBytes(9).toString("hex")}`;

export interface SaveDeps {
  dir: string;
  /** rosterId → race display name (the builder's roster catalog); "" when unknown. */
  raceNameFor: (rosterId: string) => string;
  now?: () => Date;
}

export function createSave(deps: SaveDeps, coach: string, input: unknown): SaveResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, status: 400, error: "request body must be a JSON object." };
  const { name, body, lastPreview, teamId } = input as Record<string, unknown>;
  const n = parseName(name);
  if (typeof n !== "string") return { ok: false, status: 400, error: n.error };
  const b = sanitizeSaveBody(body);
  if ("error" in b) return { ok: false, status: b.status ?? 400, error: b.error };
  const parsed = parsePreview(lastPreview);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  const lp = parsed.value;
  const at = (deps.now?.() ?? new Date()).toISOString();
  return withSaves(deps.dir, coach, (saves) => {
    if (saves.length >= TEAM_BUILDER_SAVES_PER_COACH)
      return { out: { ok: false, status: 409, error: `You can keep at most ${TEAM_BUILDER_SAVES_PER_COACH} saved teams; delete one first.` } as SaveResult };
    const rosterId = String(b.body.rosterId);
    const save: TeamBuilderSave = {
      id: newId(),
      name: n,
      packageName: typeof b.body.packageName === "string" && b.body.packageName ? b.body.packageName : null,
      rosterId,
      raceName: deps.raceNameFor(rosterId),
      teamId: typeof teamId === "string" && teamId.trim() ? teamId.trim() : null,
      createdAt: at,
      updatedAt: at,
      body: b.body,
      ...(lp ? { lastPreview: lp } : {}),
    };
    const league = leagueOf(b.body);
    if (league) save.league = league;
    return { saves: [...saves, save], out: { ok: true, status: 201, save } };
  });
}

export function updateSave(deps: SaveDeps, coach: string, id: string, input: unknown): SaveResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, status: 400, error: "request body must be a JSON object." };
  const { name, body, lastPreview } = input as Record<string, unknown>;
  const b = sanitizeSaveBody(body);
  if ("error" in b) return { ok: false, status: b.status ?? 400, error: b.error };
  const parsed = parsePreview(lastPreview);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  const lp = parsed.value;
  const at = (deps.now?.() ?? new Date()).toISOString();
  return withSaves(deps.dir, coach, (saves) => {
    const i = saves.findIndex((s) => s.id === id);
    if (i < 0) return { out: { ok: false, status: 404, error: "Saved team not found." } as SaveResult };
    const prev = saves[i]!;
    const n = parseName(name, prev.name);
    if (typeof n !== "string") return { out: { ok: false, status: 400, error: n.error } as SaveResult };
    const rosterId = String(b.body.rosterId);
    const { league: _priorLeague, ...kept } = prev;
    const save: TeamBuilderSave = {
      ...kept,
      name: n,
      packageName: typeof b.body.packageName === "string" && b.body.packageName ? b.body.packageName : null,
      rosterId,
      raceName: deps.raceNameFor(rosterId) || prev.raceName,
      updatedAt: at,
      body: b.body,
      ...(lp ? { lastPreview: lp } : {}),
    };
    const league = leagueOf(b.body);
    if (league) save.league = league;
    const next = [...saves];
    next[i] = save;
    return { saves: next, out: { ok: true, status: 200, save } };
  });
}

export function deleteSave(dir: string, coach: string, id: string): boolean {
  // The index entry goes only AFTER the saves file is written: a failed write leaves the link fully intact.
  const gone = withSaves(dir, coach, (saves) => {
    const save = saves.find((s) => s.id === id);
    return save ? { saves: saves.filter((s) => s.id !== id), out: save } : { out: undefined };
  });
  if (gone?.shareToken) dropShareIndex(dir, gone.shareToken);
  return gone !== undefined;
}

// --- Public share links (owner 10-27) ---
// The SAVE is the source of truth: `shareToken` lives on the save inside the owner's file. A tiny index file
// per token (<dir>/shares/<token>.json = { coach, id }) only says where to look; the public read re-checks that
// the named save still carries the token, so a stale or forged index entry can never surface a save.

export const SHARE_TOKEN_RE = /^[0-9a-f]{32}$/;
const shareIndexFile = (dir: string, token: string): string => join(dir, "shares", `${token}.json`);
function dropShareIndex(dir: string, token: string): void {
  if (!SHARE_TOKEN_RE.test(token)) return;
  try { unlinkSync(shareIndexFile(dir, token)); } catch { /* already gone */ }
}

export type ShareResult = { ok: true; token: string; sharedAt: string; created: boolean } | { ok: false; status: 404; error: string };

/** Share the coach's save: returns its existing token (idempotent) or mints a new 128-bit one. */
export function shareSave(dir: string, coach: string, id: string, now: () => Date = () => new Date()): ShareResult {
  // Ordering: the new index entry is written first, then the save. If the save write fails the fresh index entry
  // is removed again, so storage never holds an index without its save update (or a token without its index).
  const token = randomBytes(16).toString("hex");
  let wroteIndex = false;
  try {
    return shareSaveLocked(dir, coach, id, token, now, () => { wroteIndex = true; });
  } catch (e) {
    if (wroteIndex) dropShareIndex(dir, token);
    throw e;
  }
}

function shareSaveLocked(dir: string, coach: string, id: string, token: string, now: () => Date, indexWritten: () => void): ShareResult {
  return withSaves(dir, coach, (saves) => {
    const i = saves.findIndex((s) => s.id === id);
    if (i < 0) return { out: { ok: false, status: 404, error: "Saved team not found." } as ShareResult };
    const prev = saves[i]!;
    if (prev.shareToken && SHARE_TOKEN_RE.test(prev.shareToken)) {
      // Self-heal a missing index entry (e.g. a restored saves file) before answering.
      if (!existsSync(shareIndexFile(dir, prev.shareToken)))
        atomicWriteTextFile(shareIndexFile(dir, prev.shareToken), JSON.stringify({ coach, id }));
      return { out: { ok: true, token: prev.shareToken, sharedAt: prev.sharedAt ?? prev.updatedAt, created: false } };
    }
    const sharedAt = now().toISOString();
    atomicWriteTextFile(shareIndexFile(dir, token), JSON.stringify({ coach, id }));
    indexWritten();
    const next = [...saves];
    next[i] = { ...prev, shareToken: token, sharedAt };
    return { saves: next, out: { ok: true, token, sharedAt, created: true } };
  });
}

/** Revoke the coach's share link (old links 404 from then on). False when the save is not the coach's. */
export function unshareSave(dir: string, coach: string, id: string): boolean {
  // The save drops its token first; the index entry goes only after that write succeeded (a stale index entry
  // is harmless: findSharedSave re-checks the token on the save).
  const result = withSaves(dir, coach, (saves): { saves?: TeamBuilderSave[]; out: { found: boolean; token?: string } } => {
    const i = saves.findIndex((s) => s.id === id);
    if (i < 0) return { out: { found: false } };
    const prev = saves[i]!;
    if (!prev.shareToken) return { out: { found: true } };
    const { shareToken: token, sharedAt: _a, ...rest } = prev;
    const next = [...saves];
    next[i] = rest;
    return { saves: next, out: { found: true, token } };
  });
  if (result.token) dropShareIndex(dir, result.token);
  return result.found;
}

/** Public lookup: the shared save + its owner for a token, or undefined (unknown, revoked, malformed). */
export function findSharedSave(dir: string, token: string): { coach: string; save: TeamBuilderSave } | undefined {
  if (!SHARE_TOKEN_RE.test(token)) return undefined;
  const file = shareIndexFile(dir, token);
  if (!existsSync(file)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(file, "utf8")) as { coach?: unknown; id?: unknown };
    if (typeof entry.coach !== "string" || typeof entry.id !== "string") return undefined;
    const save = readSaves(dir, entry.coach).find((s) => s.id === entry.id);
    return save && save.shareToken === token ? { coach: entry.coach, save } : undefined;
  } catch {
    return undefined;
  }
}

/** `/api/fork/team-builder/saves/<id>/share` → id. */
export function teamBuilderSharePath(pathname: string): string | undefined {
  const m = /^\/api\/fork\/team-builder\/saves\/([^/]+)\/share$/.exec(pathname);
  if (!m) return undefined;
  try {
    const id = decodeURIComponent(m[1]!);
    return /^[\w-]{1,64}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** `/api/fork/team-builder/shared/<token>` → token (32 lower-case hex only). */
export function teamBuilderSharedPath(pathname: string): string | undefined {
  const m = /^\/api\/fork\/team-builder\/shared\/([0-9a-f]{32})$/.exec(pathname);
  return m ? m[1] : undefined;
}

/** `/t/<token>` → token: the public team view page route (anything else under /t/ is not this route). */
export function teamViewPagePath(pathname: string): string | undefined {
  const m = /^\/t\/([0-9a-f]{32})$/.exec(pathname);
  return m ? m[1] : undefined;
}

/**
 * After a successful build by `coach`: link the save named by `saveId` (when it is the coach's)
 * to the built team and refresh its stored body; otherwise update the save already linked to
 * this teamId, or create one (so every builder-made team is recallable going forward). Never
 * throws — a save-store failure must not fail a build that already committed.
 */
export function recordBuild(
  deps: SaveDeps,
  coach: string,
  built: { teamId: string; teamName: string; body: unknown; summary?: unknown; saveId?: unknown },
): string | undefined {
  try {
    const b = sanitizeSaveBody(built.body);
    if ("error" in b) return undefined;
    const body = buildBodyForSave(b.body);
    // Same cap as the save routes: never persist an oversized build body.
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > TEAM_BUILDER_SAVES_BODY_CAP) return undefined;
    const at = (deps.now?.() ?? new Date()).toISOString();
    const lastPreview = built.summary && typeof built.summary === "object" ? (built.summary as Record<string, unknown>) : undefined;
    return withSaves(deps.dir, coach, (saves) => {
      const wanted = typeof built.saveId === "string" ? saves.findIndex((s) => s.id === built.saveId) : -1;
      const i = wanted >= 0 ? wanted : saves.findIndex((s) => s.teamId === built.teamId);
      const rosterId = String(body.rosterId);
      const fields = {
        packageName: typeof body.packageName === "string" && body.packageName ? body.packageName : null,
        rosterId,
        raceName: deps.raceNameFor(rosterId),
        teamId: built.teamId,
        updatedAt: at,
        body,
        ...(lastPreview ? { lastPreview } : {}),
      };
      if (i >= 0) {
        const next = [...saves];
        next[i] = { ...saves[i]!, ...fields, raceName: fields.raceName || saves[i]!.raceName };
        return { saves: next, out: next[i]!.id };
      }
      if (saves.length >= TEAM_BUILDER_SAVES_PER_COACH) return { out: undefined };
      const save: TeamBuilderSave = { id: newId(), name: built.teamName.slice(0, NAME_MAX) || "Built team", createdAt: at, ...fields };
      return { saves: [...saves, save], out: save.id };
    });
  } catch {
    return undefined;
  }
}

/** `/api/fork/team-builder/saves` or `/api/fork/team-builder/saves/<id>` → id ("" for the collection). */
export function teamBuilderSavesPath(pathname: string): string | undefined {
  if (pathname === "/api/fork/team-builder/saves") return "";
  const m = /^\/api\/fork\/team-builder\/saves\/([^/]+)$/.exec(pathname);
  if (!m) return undefined;
  try {
    const id = decodeURIComponent(m[1]!);
    return /^[\w-]{1,64}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
