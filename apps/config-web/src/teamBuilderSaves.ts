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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireFileWriteLock, atomicWriteTextFile } from "@bb/fork-ops";
import { teamBuilderWireError } from "./teamBuilderWire.js";

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
}

export interface TeamBuilderSave extends TeamBuilderSaveSummary {
  /** The builder request body (TeamBuilderBody) minus `password`. */
  body: Record<string, unknown>;
  /** Optional last preview summary the client chose to keep with the sheet. */
  lastPreview?: Record<string, unknown>;
}

export type SaveResult =
  | { ok: true; status: 200 | 201; save: TeamBuilderSave }
  | { ok: false; status: 400 | 404 | 409; error: string };

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
});

/** TeamBuilderBody fields a BUILD may persist into a save (unknown fields are dropped). */
const BUILD_BODY_FIELDS = [
  "rosterId", "teamName", "picks", "reRolls", "apothecary", "cheerleaders", "assistantCoaches",
  "dedicatedFans", "specialRule", "budget", "custom", "packageName", "teamId", "rosteredInducements", "inducements",
] as const;
const PICK_FIELDS = ["positionId", "count", "chosenSkills", "chosenStatIncreases", "chosenStats"] as const;

function pickFields<K extends string>(src: Record<string, unknown>, keys: readonly K[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/** Whitelist a build body to TeamBuilderBody fields (and pick fields) for storage. */
export function buildBodyForSave(body: Record<string, unknown>): Record<string, unknown> {
  const out = pickFields(body, BUILD_BODY_FIELDS);
  if (Array.isArray(out.picks))
    out.picks = out.picks.map((p) => (p && typeof p === "object" && !Array.isArray(p) ? pickFields(p as Record<string, unknown>, PICK_FIELDS) : p));
  return out;
}

/** Strip credentials and validate a builder body for storage. */
export function sanitizeSaveBody(body: unknown): { body: Record<string, unknown> } | { error: string } {
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
  if ("error" in b) return { ok: false, status: 400, error: b.error };
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
    return { saves: [...saves, save], out: { ok: true, status: 201, save } };
  });
}

export function updateSave(deps: SaveDeps, coach: string, id: string, input: unknown): SaveResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, status: 400, error: "request body must be a JSON object." };
  const { name, body, lastPreview } = input as Record<string, unknown>;
  const b = sanitizeSaveBody(body);
  if ("error" in b) return { ok: false, status: 400, error: b.error };
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
    const save: TeamBuilderSave = {
      ...prev,
      name: n,
      packageName: typeof b.body.packageName === "string" && b.body.packageName ? b.body.packageName : null,
      rosterId,
      raceName: deps.raceNameFor(rosterId) || prev.raceName,
      updatedAt: at,
      body: b.body,
      ...(lp ? { lastPreview: lp } : {}),
    };
    const next = [...saves];
    next[i] = save;
    return { saves: next, out: { ok: true, status: 200, save } };
  });
}

export function deleteSave(dir: string, coach: string, id: string): boolean {
  return withSaves(dir, coach, (saves) => {
    const next = saves.filter((s) => s.id !== id);
    return next.length === saves.length ? { out: false } : { saves: next, out: true };
  });
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
