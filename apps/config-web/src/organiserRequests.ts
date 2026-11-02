// "Become an organiser" requests (registration spec 2026-11-02 §3, Q1): a signed-in, onboarded coach asks for site
// organiser level; a site admin approves or declines it from the admin queue (/app/admin/organiser-requests). Approval
// sets level "organizer" through the identities writer (upsertIdentity). One pending request per coach; the coach can
// withdraw it. Every decision keeps who and when on the row (audit).
//
// Store: <FORK_STATE_DIR>/organiser-requests.json (spec §8.1 data-store/organiser-requests.json). Strict reads: only a
// missing file is empty; an unreadable or unparsable file throws, so a write never replaces it with an empty list.
// Privacy (laws §E 26): exported per coach and anonymised on account deletion (src/privacy/collectors.ts,
// "organiser-requests"): the coach's rows keep their status and dates under the pseudonym, every free-text field is
// cleared.
//
// Notifications: "organiser-request" rows to every admin on submit, and to the coach on a decision. The type is an
// actionable one, so each also goes out as a Discord DM with a link (src/mail/actionMessages.ts, law 23c).

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { normalizeFfbCoachId, readIdentitiesStrict, upsertIdentity } from "./auth/identitiesStore.js";
import { assertNotFenced } from "./privacy/fence.js";
import type { NotificationInput } from "./notifications.js";

export type OrganiserRunKind = "league" | "tournament" | "both";
export type OrganiserRequestStatus = "pending" | "approved" | "declined" | "withdrawn";

export interface OrganiserRequest {
  id: string;
  /** The coach's account name (identity-store spelling at submit time). */
  coach: string;
  run: OrganiserRunKind;
  /** Optional competition name. */
  competition: string;
  /** Optional region (free text). */
  region: string;
  /** Free text, at most NOTE_MAX characters. */
  note: string;
  /** Up to LINKS_MAX http(s) links. */
  links: string[];
  status: OrganiserRequestStatus;
  createdAt: string;
  /** Withdrawn by the coach, or decided by an admin. */
  closedAt?: string;
  /** The admin who decided (audit). Never shown to the coach. */
  decidedBy?: string;
  /** Optional reason given with the decision (shown to the coach). */
  reason?: string;
}

interface RequestFile { version: 1; requests: OrganiserRequest[] }

export const RUN_KINDS: readonly OrganiserRunKind[] = ["league", "tournament", "both"];
export const NOTE_MAX = 500;
export const COMPETITION_MAX = 80;
export const REGION_MAX = 60;
export const LINK_MAX = 200;
export const LINKS_MAX = 3;
export const REASON_MAX = 300;
/** Closed rows kept per coach (the pending one is always kept). */
export const CLOSED_PER_COACH = 10;

export const ADMIN_QUEUE_LINK = "/app/admin/organiser-requests";
export const REQUEST_PAGE_LINK = "/app/organiser/request";

export class OrganiserRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const coachKey = (coach: string): string => normalizeFfbCoachId(coach);
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const RUN_LABEL: Record<OrganiserRunKind, string> = { league: "a league", tournament: "a tournament", both: "leagues and tournaments" };
export const runLabel = (run: OrganiserRunKind): string => RUN_LABEL[run];

function validRow(raw: unknown): OrganiserRequest | undefined {
  if (!isObj(raw)) return undefined;
  const status = raw.status as OrganiserRequestStatus;
  if (typeof raw.id !== "string" || !/^or[a-f0-9]{12}$/.test(raw.id) || typeof raw.coach !== "string" || !raw.coach.trim()) return undefined;
  if (!RUN_KINDS.includes(raw.run as OrganiserRunKind) || !["pending", "approved", "declined", "withdrawn"].includes(status)) return undefined;
  if (typeof raw.createdAt !== "string") return undefined;
  return {
    id: raw.id, coach: raw.coach, run: raw.run as OrganiserRunKind, competition: str(raw.competition), region: str(raw.region), note: str(raw.note),
    links: Array.isArray(raw.links) ? raw.links.filter((l): l is string => typeof l === "string") : [],
    status, createdAt: raw.createdAt,
    ...(typeof raw.closedAt === "string" ? { closedAt: raw.closedAt } : {}),
    ...(typeof raw.decidedBy === "string" ? { decidedBy: raw.decidedBy } : {}),
    ...(typeof raw.reason === "string" && raw.reason ? { reason: raw.reason } : {}),
  };
}

/** One line of free text: control characters and line breaks removed, trimmed. */
const oneLine = (v: string): string => v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
/** Multi-line free text: control characters other than line breaks removed, at most 2 blank lines in a row. */
const multiLine = (v: string): string => v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();

function boundedText(value: unknown, field: string, max: number, multi = false): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new OrganiserRequestError(400, `${field} must be text.`);
  const text = (multi ? multiLine(value) : oneLine(value)).normalize("NFC");
  if (text.length > max) throw new OrganiserRequestError(400, `${field} must be at most ${max} characters.`);
  return text;
}

/** http(s) links only; the stored form is the parsed URL. */
export function normalisedLinks(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = typeof value === "string" ? value.split(/\s+/) : value;
  if (!Array.isArray(list)) throw new OrganiserRequestError(400, "links must be a list.");
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") throw new OrganiserRequestError(400, "Each link must be text.");
    const raw = item.trim();
    if (!raw) continue;
    let url: URL;
    try { url = new URL(raw); } catch { throw new OrganiserRequestError(400, `"${raw.slice(0, 60)}" is not a link. Links start with https://.`); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new OrganiserRequestError(400, "Links must start with https:// or http://.");
    if (url.username || url.password) throw new OrganiserRequestError(400, "Links can't carry a user name or password.");
    const href = url.href;
    if (href.length > LINK_MAX) throw new OrganiserRequestError(400, `Each link must be at most ${LINK_MAX} characters.`);
    if (!out.includes(href)) out.push(href);
  }
  if (out.length > LINKS_MAX) throw new OrganiserRequestError(400, `Add at most ${LINKS_MAX} links.`);
  return out;
}

export interface SubmitInput { run: OrganiserRunKind; competition: string; region: string; note: string; links: string[] }

export function parseSubmit(body: unknown): SubmitInput {
  if (!isObj(body)) throw new OrganiserRequestError(400, "A JSON object is required.");
  if (!RUN_KINDS.includes(body.run as OrganiserRunKind)) throw new OrganiserRequestError(400, "Choose what you want to run: a league, a tournament, or both.");
  const note = boundedText(body.note, "The note", NOTE_MAX, true);
  if (!note) throw new OrganiserRequestError(400, "Tell the admins a little about what you want to run.");
  return {
    run: body.run as OrganiserRunKind,
    competition: boundedText(body.competition, "The competition name", COMPETITION_MAX),
    region: boundedText(body.region, "The region", REGION_MAX),
    note,
    links: normalisedLinks(body.links),
  };
}

export class OrganiserRequestStore {
  readonly file: string;
  constructor(stateDir: string, private readonly now: () => Date = () => new Date()) {
    this.file = join(stateDir, "organiser-requests.json");
  }

  /** Strict: only a missing file is empty. */
  private read(): RequestFile {
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, requests: [] };
      throw e;
    }
    const parsed = JSON.parse(text) as unknown;
    if (!isObj(parsed) || !Array.isArray(parsed.requests)) throw new Error("organiser-requests.json has no requests list.");
    return { version: 1, requests: parsed.requests.map(validRow).filter((r): r is OrganiserRequest => r !== undefined) };
  }

  private write(data: RequestFile): void {
    atomicWriteTextFile(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }

  all(): OrganiserRequest[] { return this.read().requests; }

  /** Newest first, optionally one status. */
  list(status?: OrganiserRequestStatus | "closed"): OrganiserRequest[] {
    const rows = this.read().requests.filter((r) => !status || (status === "closed" ? r.status !== "pending" : r.status === status));
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /** The coach's latest request (pending first), or undefined. */
  latestFor(coach: string): OrganiserRequest | undefined {
    const key = coachKey(coach);
    const mine = this.read().requests.filter((r) => coachKey(r.coach) === key);
    return mine.find((r) => r.status === "pending") ?? mine.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  }

  submit(coach: string, input: SubmitInput): OrganiserRequest {
    assertNotFenced(coach);
    const data = this.read();
    const key = coachKey(coach);
    if (data.requests.some((r) => coachKey(r.coach) === key && r.status === "pending"))
      throw new OrganiserRequestError(409, "You already have a request waiting. Withdraw it to send a new one.");
    const row: OrganiserRequest = { id: `or${randomBytes(6).toString("hex")}`, coach: coach.trim(), ...input, status: "pending", createdAt: this.now().toISOString() };
    // Keep the coach's last CLOSED_PER_COACH closed rows (oldest dropped); other coaches' rows are untouched.
    const closedMine = data.requests.filter((r) => coachKey(r.coach) === key && r.status !== "pending").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const drop = new Set(closedMine.slice(CLOSED_PER_COACH - 1).map((r) => r.id));
    this.write({ version: 1, requests: [...data.requests.filter((r) => !drop.has(r.id)), row] });
    return row;
  }

  withdraw(coach: string): OrganiserRequest {
    const data = this.read();
    const key = coachKey(coach);
    const row = data.requests.find((r) => coachKey(r.coach) === key && r.status === "pending");
    if (!row) throw new OrganiserRequestError(404, "You have no request waiting.");
    row.status = "withdrawn";
    row.closedAt = this.now().toISOString();
    this.write(data);
    return row;
  }

  get(id: string): OrganiserRequest | undefined { return this.read().requests.find((r) => r.id === id); }

  /**
   * Decide a pending request. The decision is recorded FIRST; `apply` (the identity write for an approval) runs after.
   * When `apply` throws, the request goes back to pending and the error is rethrown, so rights are never granted
   * without an approved request on record (and a failed record write never grants anything).
   */
  decide(id: string, decision: "approved" | "declined", actor: string, reason: string, apply?: (row: OrganiserRequest) => void): OrganiserRequest {
    const data = this.read();
    const row = data.requests.find((r) => r.id === id);
    if (!row) throw new OrganiserRequestError(404, "No such request.");
    if (row.status !== "pending") throw new OrganiserRequestError(409, `This request was already ${row.status}.`);
    const before = { ...row };
    row.status = decision;
    row.closedAt = this.now().toISOString();
    row.decidedBy = actor;
    if (reason) row.reason = reason; else delete row.reason;
    this.write(data);
    if (apply) {
      try { apply(row); } catch (e) {
        const again = this.read();
        const i = again.requests.findIndex((r) => r.id === id);
        if (i >= 0) { again.requests[i] = before; this.write(again); }
        throw e;
      }
    }
    return row;
  }
}

/**
 * Site organiser level through the identities writer: a player is raised to organiser; an organiser or admin is left as
 * is; a banned coach is refused (409). The coach must have an identity record (a signed-in, onboarded coach always does).
 */
export function grantOrganiserLevel(coach: string, actor: string, now = new Date()): "granted" | "already" {
  const stored = readIdentitiesStrict().coaches[coachKey(coach)];
  if (!stored) throw new OrganiserRequestError(409, "That coach has no account record any more.");
  if (stored.banned) throw new OrganiserRequestError(409, "That coach is banned. Unban them first.");
  if (stored.level !== "player") return "already";
  upsertIdentity({ ...stored, level: "organizer", updatedAt: now.toISOString(), updatedBy: actor });
  return "granted";
}

/** The stored identity level ("player" when there is no record). */
export function currentLevel(coach: string): string {
  return readIdentitiesStrict().coaches[coachKey(coach)]?.level ?? "player";
}

/** Site admins (identity level admin, not banned): the queue's notification recipients. */
export function siteAdmins(): string[] {
  try {
    return Object.values(readIdentitiesStrict().coaches).filter((r) => r.level === "admin" && !r.banned).map((r) => r.ffbCoachId);
  } catch {
    return [];
  }
}

// ---- API ------------------------------------------------------------------------------------------------------------

export interface OrganiserRequestAuth { coach: string; organizer: boolean; admin: boolean; test?: boolean }
export interface OrganiserRequestDeps {
  store: OrganiserRequestStore;
  notify: (coach: string, input: NotificationInput) => void;
  admins?: () => string[];
  grant?: (coach: string, actor: string) => "granted" | "already";
  /** The coach's stored site level (identity record; banned ignored). */
  levelOf?: (coach: string) => string;
  log?: (line: string) => void;
}
export interface OrganiserRequestResult { status: number; body: unknown }

export const ME_REQUEST_PATH = "/api/me/organiser-request";
export const ADMIN_REQUESTS_PATH = "/api/admin/organiser-requests";
const DECIDE_PATH = /^\/api\/admin\/organiser-requests\/(or[a-f0-9]{12})\/(approve|decline)$/;

export const isOrganiserRequestPath = (path: string): boolean => path === ME_REQUEST_PATH || isOrganiserRequestAdminPath(path);
export const isOrganiserRequestAdminPath = (path: string): boolean => path === ADMIN_REQUESTS_PATH || DECIDE_PATH.test(path);

/** What the coach sees of their own request (never who decided). */
export function coachView(row: OrganiserRequest | undefined): Omit<OrganiserRequest, "decidedBy"> | null {
  if (!row) return null;
  const { decidedBy: _by, ...rest } = row;
  return rest;
}

const fail = (e: unknown): OrganiserRequestResult => {
  if (e instanceof OrganiserRequestError) return { status: e.status, body: { error: e.message } };
  const status = (e as { status?: unknown })?.status;
  if (status === 409) return { status: 409, body: { error: (e as Error).message } };
  return { status: 500, body: { error: "Organiser requests are unavailable right now." } };
};

/**
 * The routes. `auth` is the session coach; `adminActor` is set only for a site admin (session admin, or the admin
 * password / token on hosts that allow them) and names who decided.
 */
export function organiserRequestsApi(
  method: string,
  path: string,
  query: URLSearchParams,
  auth: OrganiserRequestAuth | undefined,
  adminActor: string | undefined,
  body: unknown,
  deps: OrganiserRequestDeps,
): OrganiserRequestResult | undefined {
  const log = deps.log ?? ((line: string) => console.log(line));
  if (path === ME_REQUEST_PATH) {
    if (!auth) return { status: 401, body: { error: "Authentication required." } };
    try {
      if (method === "GET") return { status: 200, body: { organizer: auth.organizer, request: coachView(deps.store.latestFor(auth.coach)) } };
      if (method !== "POST" && method !== "DELETE") return { status: 405, body: { error: "Method not allowed." } };
      if (auth.test) return { status: 403, body: { error: "Test sign-in sessions can't send or withdraw organiser requests." } };
      if (method === "DELETE") {
        const row = deps.store.withdraw(auth.coach);
        log(`[organiser-request] ${row.id} withdrawn`);
        return { status: 200, body: { ok: true, request: coachView(row) } };
      }
      if (auth.organizer) return { status: 409, body: { error: "You're already an organiser." } };
      const row = deps.store.submit(auth.coach, parseSubmit(body));
      log(`[organiser-request] ${row.id} submitted`);
      const sentence = `${row.coach} asked to become an organiser.`;
      for (const admin of (deps.admins ?? siteAdmins)()) {
        if (coachKey(admin) === coachKey(row.coach)) continue;
        try {
          deps.notify(admin, {
            type: "organiser-request", from: row.coach, link: ADMIN_QUEUE_LINK, subject: sentence,
            title: `Organiser request from ${row.coach}`,
            body: `${row.coach} wants to run ${runLabel(row.run)}${row.competition ? ` (${row.competition})` : ""}. Approve or decline it in Organiser requests.`,
          });
        } catch { /* fire-and-forget */ }
      }
      return { status: 201, body: { ok: true, request: coachView(row) } };
    } catch (e) {
      return fail(e);
    }
  }

  if (!isOrganiserRequestAdminPath(path)) return undefined;
  if (!adminActor) return { status: auth ? 403 : 401, body: { error: auth ? "Admin access required." : "Authentication required." } };
  try {
    if (path === ADMIN_REQUESTS_PATH) {
      if (method !== "GET") return { status: 405, body: { error: "Method not allowed." } };
      const wanted = query.get("status");
      const status = wanted === "closed" || wanted === "approved" || wanted === "declined" || wanted === "withdrawn" ? wanted : wanted === "all" ? undefined : "pending";
      const requests = deps.store.list(status);
      return { status: 200, body: { requests, pending: status === "pending" ? requests.length : deps.store.list("pending").length } };
    }
    const m = DECIDE_PATH.exec(path)!;
    if (method !== "POST") return { status: 405, body: { error: "Method not allowed." } };
    if (auth?.test) return { status: 403, body: { error: "Test sign-in sessions can't decide organiser requests." } };
    const reason = boundedText(isObj(body) ? body.reason : undefined, "The reason", REASON_MAX, true);
    const decision = m[2] === "approve" ? "approved" : "declined";
    const target = deps.store.get(m[1]!);
    if (!target) return { status: 404, body: { error: "No such request." } };
    if (coachKey(target.coach) === coachKey(adminActor) || (auth && coachKey(target.coach) === coachKey(auth.coach)))
      return { status: 403, body: { error: "You can't decide your own request." } };
    // A decline never leaves rights unrecorded: a coach who already holds the level (granted elsewhere, or by an
    // approval whose request write was lost) is refused here, so the record and the level never disagree silently.
    if (decision === "declined" && (deps.levelOf ?? currentLevel)(target.coach) !== "player")
      return { status: 409, body: { error: `${target.coach} is already an organiser. Approve the request to record it, or change their level in the identities admin first.` } };
    const grant = deps.grant ?? ((coach: string, actor: string) => grantOrganiserLevel(coach, actor));
    let granted: "granted" | "already" | undefined;
    const row = deps.store.decide(m[1]!, decision, adminActor, reason, decision === "approved" ? (r) => { granted = grant(r.coach, adminActor); } : undefined);
    log(`[organiser-request] ${row.id} ${decision} by ${adminActor}${granted ? ` (level ${granted})` : ""}`);
    const approved = decision === "approved";
    try {
      deps.notify(row.coach, {
        type: "organiser-request", from: "", link: REQUEST_PAGE_LINK,
        subject: approved ? "Your organiser request was approved." : "Your organiser request was declined.",
        title: approved ? "You're now an organiser" : "Your organiser request was declined",
        body: `${approved ? "You can now create tournaments and leagues." : "An admin declined your request to become an organiser."}${row.reason ? ` Reason: ${row.reason}` : ""}`,
      });
    } catch { /* fire-and-forget */ }
    return { status: 200, body: { ok: true, request: row, ...(granted ? { level: granted } : {}) } };
  } catch (e) {
    return fail(e);
  }
}
