// The clubs store: <FORK_STATE_DIR>/clubs/
//
//   clubs.json     { version, clubs: { <id>: ClubRecord } }   every club, its members, pending requests and former members
//   secrets.json   { version, webhooks: { <id>: url } }        club Discord webhooks: server-side only, masked in every read
//                                                             model, never logged, never in an error message
//   crests/<sha>.<ext>                                        uploaded crests (PNG / JPEG / WebP, the league-logo rules)
//
// Reads are STRICT: a missing file is empty, an unreadable or malformed one throws (a corrupt store must never read as "no
// members", which would let anyone act as an admin of nothing). Every write re-reads the file and is atomic (temp file +
// rename). Everything is synchronous, so one request's read-modify-write never interleaves with another's.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { cleanMessageText, textLength } from "../social/store.js";
import {
  CLUB_DESCRIPTION_MAX, CLUB_ID, CLUB_NAME_MAX, CLUB_NAME_MIN, CLUB_REGION_MAX, clubCoachKey, DEFAULT_CLUB_SETTINGS,
  type ClubRecord, type ClubSettings, type ClubsFile,
} from "./types.js";

export class ClubError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); this.name = "ClubError"; }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

function readStrict(path: string): Obj | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { if (isEnoent(e)) return undefined; throw new ClubError(500, "The clubs store is unreadable."); }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new ClubError(500, "The clubs store is unreadable."); }
  if (!isObj(data)) throw new ClubError(500, "The clubs store is unreadable.");
  return data;
}

/** One-line text: controls and bidi overrides removed, whitespace runs collapsed, NFC. */
export function cleanLine(raw: unknown): string {
  return cleanMessageText(raw).replace(/\s+/g, " ").normalize("NFC").trim();
}

/** The club name rules (3 to 60 characters, at least one letter or digit). */
export function parseClubName(raw: unknown): string {
  const name = cleanLine(raw);
  const n = textLength(name);
  if (n < CLUB_NAME_MIN || n > CLUB_NAME_MAX) throw new ClubError(400, `A club name is ${CLUB_NAME_MIN} to ${CLUB_NAME_MAX} characters.`, "name");
  if (!/[\p{L}\p{N}]/u.test(name)) throw new ClubError(400, "A club name needs a letter or a digit.", "name");
  return name;
}

export function parseClubRegion(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (!isStr(raw)) throw new ClubError(400, "The home region must be text.", "homeRegion");
  const region = cleanLine(raw);
  if (textLength(region) > CLUB_REGION_MAX) throw new ClubError(400, `The home region is at most ${CLUB_REGION_MAX} characters.`, "homeRegion");
  return region;
}

export function parseClubDescription(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (!isStr(raw)) throw new ClubError(400, "The description must be text.", "description");
  const text = cleanMessageText(raw).normalize("NFC");
  if (textLength(text) > CLUB_DESCRIPTION_MAX) throw new ClubError(400, `The description is at most ${CLUB_DESCRIPTION_MAX} characters.`, "description");
  return text;
}

/** The comparison key of a club name: NFC, case-folded, whitespace collapsed (two clubs never share a name). */
export const clubNameKey = (name: string): string => name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** A URL id from the name: ASCII letters and digits, dashes between (accents dropped); "club" when nothing is left. */
export function slugFor(name: string): string {
  const s = name.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return s || "club";
}

function normaliseSettings(raw: unknown): ClubSettings {
  const s = isObj(raw) ? raw : {};
  const w = isObj(s.webhookEvents) ? s.webhookEvents : {};
  const d = DEFAULT_CLUB_SETTINGS;
  return {
    ladderGamesCount: s.ladderGamesCount === true,
    webhookEvents: {
      results: typeof w.results === "boolean" ? w.results : d.webhookEvents.results,
      podiums: typeof w.podiums === "boolean" ? w.podiums : d.webhookEvents.podiums,
      titles: typeof w.titles === "boolean" ? w.titles : d.webhookEvents.titles,
    },
  };
}

/** A stored club in its full shape (missing optional lists read as empty, settings as the defaults). */
function normalise(raw: Obj): ClubRecord | undefined {
  if (!isStr(raw.id) || !CLUB_ID.test(raw.id) || !isStr(raw.name)) return undefined;
  const rows = (v: unknown) => (Array.isArray(v) ? v.filter((r): r is Obj => isObj(r) && isStr(r.coach) && r.coach.trim() !== "") : []);
  return {
    id: raw.id,
    name: raw.name,
    homeRegion: isStr(raw.homeRegion) ? raw.homeRegion : "",
    description: isStr(raw.description) ? raw.description : "",
    ...(isStr(raw.crestPath) && /^crests\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(raw.crestPath) ? { crestPath: raw.crestPath } : {}),
    createdAt: isStr(raw.createdAt) ? raw.createdAt : "",
    createdBy: isStr(raw.createdBy) ? raw.createdBy : "",
    updatedAt: isStr(raw.updatedAt) ? raw.updatedAt : "",
    revision: typeof raw.revision === "number" && Number.isInteger(raw.revision) ? raw.revision : 0,
    members: rows(raw.members).map((m) => ({
      coach: m.coach as string, role: m.role === "admin" ? "admin" as const : "member" as const, joinedAt: isStr(m.joinedAt) ? m.joinedAt : "",
      ...(isObj(m.notify) ? { notify: { ...(m.notify.wins === true ? { wins: true } : {}), ...(m.notify.board === true ? { board: true } : {}) } } : {}),
    })),
    requests: rows(raw.requests).map((r) => ({ coach: r.coach as string, at: isStr(r.at) ? r.at : "", ...(isStr(r.message) && r.message ? { message: r.message } : {}) })),
    former: rows(raw.former).map((f) => ({
      coach: f.coach as string, joinedAt: isStr(f.joinedAt) ? f.joinedAt : "", leftAt: isStr(f.leftAt) ? f.leftAt : "",
      reason: f.reason === "removed" ? "removed" as const : "left" as const,
    })),
    settings: normaliseSettings(raw.settings),
    ...(isStr(raw.webhookConnectedAt) ? { webhookConnectedAt: raw.webhookConnectedAt } : {}),
    ...(isObj(raw.review) && raw.review.reason === "creator-deleted" && isStr(raw.review.at) ? { review: { reason: "creator-deleted" as const, at: raw.review.at } } : {}),
    ...(isStr(raw.archivedAt) ? { archivedAt: raw.archivedAt } : {}),
  };
}

export interface ClubStoreOptions { now?: () => Date }

export class ClubStore {
  readonly dir: string;
  constructor(stateDir: string, private readonly opts: ClubStoreOptions = {}) {
    this.dir = join(stateDir, "clubs");
  }

  private get file(): string { return join(this.dir, "clubs.json"); }
  private get secretsFile(): string { return join(this.dir, "secrets.json"); }
  now(): Date { return this.opts.now?.() ?? new Date(); }

  private readFile(): ClubsFile {
    const raw = readStrict(this.file);
    const out: ClubsFile = { version: 1, clubs: {} };
    if (!raw) return out;
    if (!isObj(raw.clubs)) throw new ClubError(500, "The clubs store is unreadable.");
    for (const [id, v] of Object.entries(raw.clubs)) {
      const c = isObj(v) ? normalise(v) : undefined;
      if (c && c.id === id) out.clubs[id] = c;
    }
    return out;
  }

  private writeFile(file: ClubsFile): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWriteTextFile(this.file, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** Every club (archived ones included), oldest first. */
  list(): ClubRecord[] {
    return Object.values(this.readFile().clubs).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  get(id: string): ClubRecord | undefined {
    if (!CLUB_ID.test(id)) return undefined;
    const c = this.readFile().clubs[id];
    return c ? structuredClone(c) : undefined;
  }

  /** The clubs `coach` is a member of now (not archived ones), by name. */
  membershipsOf(coach: string): ClubRecord[] {
    const k = clubCoachKey(coach);
    if (!k) return [];
    return this.list().filter((c) => !c.archivedAt && c.members.some((m) => clubCoachKey(m.coach) === k)).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Creates a club with `createdBy` as its first admin. Name clashes (case-insensitive, any club) are refused. */
  create(input: { name: string; homeRegion: string; description: string; createdBy: string }): ClubRecord {
    const file = this.readFile();
    const key = clubNameKey(input.name);
    if (Object.values(file.clubs).some((c) => clubNameKey(c.name) === key)) throw new ClubError(409, "A club with that name already exists.", "name");
    const base = slugFor(input.name);
    let id = base;
    while (file.clubs[id]) id = `${base.slice(0, 40)}-${randomBytes(3).toString("hex")}`;
    const at = this.now().toISOString();
    const club: ClubRecord = {
      id, name: input.name, homeRegion: input.homeRegion, description: input.description, createdAt: at, createdBy: input.createdBy, updatedAt: at,
      revision: 1, members: [{ coach: input.createdBy, role: "admin", joinedAt: at }], requests: [], former: [], settings: structuredClone(DEFAULT_CLUB_SETTINGS),
    };
    file.clubs[id] = club;
    this.writeFile(file);
    return structuredClone(club);
  }

  /**
   * Read-modify-write of one club: `mutate` changes the copy (or throws a ClubError, which writes nothing). `expected` (a
   * revision the caller loaded) refuses a stale write with 409. The revision is bumped and updatedAt stamped.
   */
  update(id: string, mutate: (club: ClubRecord) => void, expected?: number): ClubRecord {
    const file = this.readFile();
    const club = file.clubs[id];
    if (!club) throw new ClubError(404, "Club not found.");
    if (expected !== undefined && club.revision !== expected) throw new ClubError(409, "The club changed since you loaded it. Reload and try again.", "stale");
    const copy = structuredClone(club);
    mutate(copy);
    if (copy.id !== id) throw new Error("club id changed");
    // A renamed club must still be the only one with its name.
    if (clubNameKey(copy.name) !== clubNameKey(club.name)) {
      const key = clubNameKey(copy.name);
      if (Object.values(file.clubs).some((c) => c.id !== id && clubNameKey(c.name) === key)) throw new ClubError(409, "A club with that name already exists.", "name");
    }
    copy.revision = club.revision + 1;
    copy.updatedAt = this.now().toISOString();
    file.clubs[id] = copy;
    this.writeFile(file);
    return structuredClone(copy);
  }

  /** Removes a club record, its webhook and its crest file. */
  remove(id: string): void {
    const file = this.readFile();
    const club = file.clubs[id];
    if (!club) return;
    delete file.clubs[id];
    this.writeFile(file);
    this.setWebhook(id, null);
    if (club.crestPath) this.dropCrest(club.crestPath);
  }

  /** Rewrites every club (the privacy step); `change` returns true when it changed the club. Writes once, only if needed. */
  rewriteAll(change: (club: ClubRecord) => boolean): number {
    const file = this.readFile();
    let n = 0;
    for (const club of Object.values(file.clubs)) if (change(club)) { club.revision += 1; n += 1; }
    if (n) this.writeFile(file);
    return n;
  }

  // ---- crests ----

  crestFile(rel: string): string { return join(this.dir, rel); }
  dropCrest(rel: string | undefined): void {
    if (!rel || !/^crests\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(rel)) return;
    if (this.list().some((c) => c.crestPath === rel)) return;
    try { unlinkSync(join(this.dir, rel)); } catch { /* already gone */ }
  }

  // ---- webhooks (never in a read model or a log line) ----

  private readSecrets(): Record<string, string> {
    const raw = readStrict(this.secretsFile);
    if (!raw) return {};
    const w = isObj(raw.webhooks) ? raw.webhooks : {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(w)) if (isStr(v) && v) out[k] = v;
    return out;
  }
  webhook(id: string): string | undefined {
    return this.readSecrets()[id];
  }
  setWebhook(id: string, url: string | null): void {
    const hooks = this.readSecrets();
    if (url) hooks[id] = url; else if (!(id in hooks)) return; else delete hooks[id];
    mkdirSync(this.dir, { recursive: true });
    atomicWriteTextFile(this.secretsFile, `${JSON.stringify({ version: 1, webhooks: hooks }, null, 2)}\n`);
  }
}
