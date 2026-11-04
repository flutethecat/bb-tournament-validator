/**
 * Competition templates API (creation wizards v2: season templates in League settings, tournament templates for
 * organisers, sharing between organisers). Every answer is no-store.
 *
 *   GET    /api/templates?kind=season|tournament    the caller's own templates and those shared with them
 *   POST   /api/templates                            { kind, name, description?, includePayLinks?, from?: { leagueId,
 *                                                     seasonId } | { tournamentId }, content? } save a template: captured
 *                                                     from a competition the caller manages, or (tournament only) the
 *                                                     wizard's settings as `content`
 *   GET    /api/templates/organisers?q=              site organisers to share with (by display name or account name)
 *   GET    /api/templates/:id                        one template (owner and shared organisers; anyone else 404)
 *   PATCH  /api/templates/:id                        { revision, name?, description?, from?, includePayLinks? } owner only:
 *                                                     rename, or update the settings from a competition
 *   DELETE /api/templates/:id                        owner only
 *   POST   /api/templates/:id/copy                   { name? } "Make a copy": the caller's own editable copy
 *   POST   /api/templates/:id/share                  { coach } owner only; the organiser gets a notification
 *   POST   /api/templates/:id/unshare                { coach } owner only (stop sharing)
 *
 * Access (the invariants, enforced here for every route):
 * - Only the owner edits, renames, shares, unshares or deletes. A shared organiser reads, uses and copies (403 on owner
 *   actions). Anyone else, site admins included, gets 404 as if the template did not exist.
 * - Shares link by account (identity key), never by display name; the target must be a site organiser (or admin).
 * - A template never carries a webhook URL, coach data or registrations (the capture functions and the parsers drop
 *   them). Payment links are the owner's: a shared view and a copy never carry them.
 * - Unsharing changes nothing already made from the template (a season / tournament copies the values when it is made).
 * - GETs never change state; writes need the CSRF header (src/auth/csrf.ts, by method) and an onboarded session (the
 *   server's 428 gate). Test sign-in sessions read only.
 */
import { DeletionFenceError } from "../privacy/fence.js";
import {
  isTemplateKind, parseTournamentTemplateContent, TEMPLATE_DESCRIPTION_MAX, TEMPLATE_ID, TEMPLATE_KIND_LABEL, TEMPLATE_NAME_MAX, TemplateError, templateSummary,
  type SeasonTemplateContent, type TemplateKind, type TournamentTemplateContent,
} from "../competition/templates.js";
import type { LeagueStore } from "../leagues/store.js";
import { managesLeague } from "../leagues/lifecycle.js";
import { isTournamentManager, type TournamentStore } from "../tournaments/store.js";
import type { NotificationInput } from "../notifications.js";
import { captureSeason, checkSeasonContent } from "./season.js";
import { captureTournament, tournamentContentOptions } from "./tournament.js";
import { templateKey, type TemplateRecord, type TemplateStore } from "./store.js";

export interface TemplatesAuth { coach: string; organizer: boolean; admin: boolean; test?: boolean }
export interface TemplatesResult { status: number; body: unknown; headers?: Record<string, string> }
export interface TemplateOrganiser { coach: string; displayName?: string }

export interface TemplatesDeps {
  store: TemplateStore;
  leagues: Pick<LeagueStore, "league" | "season">;
  tournaments: Pick<TournamentStore, "tournament">;
  /** A tournament's Discord event toggles (never its webhook); undefined = the tournament-mode defaults. */
  tournamentDiscordEvents?: (tournamentId: string) => Record<string, boolean> | undefined;
  /** Site organisers and admins who are not banned (share targets), with their display names. */
  organisers: () => TemplateOrganiser[];
  /** Display name of any coach ("" = none), for the owner line a shared organiser sees. */
  displayName?: (coach: string) => string;
  notify?: (coach: string, input: NotificationInput) => void;
  now?: () => Date;
}

export const TEMPLATES_PATH = "/api/templates";
export const isTemplatesApiPath = (path: string): boolean => path === TEMPLATES_PATH || path.startsWith(`${TEMPLATES_PATH}/`);
const NO_STORE = { "cache-control": "private, no-store" };
const res = (status: number, body: unknown): TemplatesResult => ({ status, body, headers: { ...NO_STORE } });
const fail = (status: number, error: string, field?: string): TemplatesResult => res(status, { error, ...(field ? { field } : {}) });
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const same = (a: string, b: string): boolean => templateKey(a) === templateKey(b);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g;

const isOwner = (t: TemplateRecord, coach: string): boolean => same(t.owner, coach);
const isSharedWith = (t: TemplateRecord, coach: string): boolean => t.sharedWith.some((s) => same(s.coach, coach));
/** The template only when the caller may read it (owner or shared organiser); otherwise undefined (answered 404). */
export function readableTemplate(store: TemplateStore, id: string, coach: string): TemplateRecord | undefined {
  const t = store.get(id);
  return t && (isOwner(t, coach) || isSharedWith(t, coach)) ? t : undefined;
}

/** A season template the caller may use for a new season (League settings → Start a new season, "From template").
 *  Payment links only when the caller owns it. Throws TemplateError (404 not readable, 409 wrong kind / damaged). */
export function seasonTemplateFor(store: TemplateStore, id: unknown, coach: string): { content: SeasonTemplateContent; mine: boolean; name: string } {
  if (typeof id !== "string" || !TEMPLATE_ID.test(id)) throw new TemplateError(400, "Pick a template.", "templateId");
  const t = readableTemplate(store, id, coach);
  if (!t) throw new TemplateError(404, "Template not found.", "templateId");
  if (t.kind !== "season") throw new TemplateError(409, "That is not a season template.", "templateId");
  const content = checkSeasonContent(t.content);
  const mine = isOwner(t, coach);
  if (!mine) delete content.payLinks;
  return { content, mine, name: t.name };
}

function cleanText(raw: unknown, field: string, label: string, max: number, required: boolean): string {
  if (raw === undefined || raw === null) {
    if (required) throw new TemplateError(400, `Enter a ${label.toLowerCase()}.`, field);
    return "";
  }
  if (typeof raw !== "string") throw new TemplateError(400, `${label} must be text.`, field);
  const v = raw.replace(/\r\n?/g, "\n").replace(CONTROL, (c) => (c === "\n" ? c : "")).trim();
  if (required && !v) throw new TemplateError(400, `Enter a ${label.toLowerCase()}.`, field);
  if ([...v].length > max) throw new TemplateError(400, `${label} must be at most ${max} characters.`, field);
  return v;
}

/** The content a stored template holds, checked again (the kind's parser). Throws TemplateError 409 when damaged. */
function checkedContent(t: TemplateRecord): SeasonTemplateContent | TournamentTemplateContent {
  if (t.kind === "season") return checkSeasonContent(t.content);
  try { return parseTournamentTemplateContent(t.content, tournamentContentOptions()); } catch (e) {
    if (e instanceof TemplateError) throw new TemplateError(409, `That template can't be used: ${e.message}`);
    throw e;
  }
}

/** What the caller sees of a template. Shared organisers: no payment links and no list of who else has access. */
export function templateView(t: TemplateRecord, coach: string, deps: Pick<TemplatesDeps, "displayName">) {
  const mine = isOwner(t, coach);
  let content: Record<string, unknown> | null;
  let problem = "";
  try { content = structuredClone(checkedContent(t)) as unknown as Record<string, unknown>; } catch (e) { content = null; problem = (e as Error).message; }
  const hasPayLinks = Boolean(content && isObj(content.payLinks));
  if (content && !mine) delete content.payLinks;
  const label = (c: string): string => deps.displayName?.(c) || c;
  return {
    id: t.id, kind: t.kind, name: t.name, description: t.description, mine,
    owner: mine ? t.owner : label(t.owner),
    ...(mine ? { sharedWith: t.sharedWith.map((s) => ({ coach: s.coach, name: label(s.coach), at: s.at })), hasPayLinks } : {}),
    content, ...(problem ? { problem } : {}),
    summary: content ? templateSummary(t.kind, content) : [],
    ...(t.copiedFrom ? { copiedFrom: t.copiedFrom } : {}),
    createdAt: t.createdAt, updatedAt: t.updatedAt, revision: t.revision,
  };
}

/** Capture the settings from a competition the caller manages (league organisers / tournament managers, admins). */
function captureFrom(kind: TemplateKind, from: unknown, auth: TemplatesAuth, includePayLinks: boolean, deps: TemplatesDeps): Record<string, unknown> {
  if (!isObj(from)) throw new TemplateError(400, "from must name the competition to save.", "from");
  if (kind === "season") {
    if (typeof from.leagueId !== "string" || typeof from.seasonId !== "string") throw new TemplateError(400, "Name the league and season to save.", "from");
    const league = deps.leagues.league(from.leagueId);
    // A league the caller does not run answers as if it did not exist (drafts stay hidden).
    if (!league || !managesLeague(league, auth)) throw new TemplateError(404, "League not found.", "from");
    const season = deps.leagues.season(league.id, from.seasonId);
    if (!season) throw new TemplateError(404, "Season not found.", "from");
    // A ladder is a season record too (competition "ladder"); ladder templates are a later kind with their own shape.
    if ((season as { competition?: string }).competition === "ladder") throw new TemplateError(409, "Ladders can't be saved as season templates.", "from");
    return captureSeason(league, season, includePayLinks) as unknown as Record<string, unknown>;
  }
  if (typeof from.tournamentId !== "string") throw new TemplateError(400, "Name the tournament to save.", "from");
  const t = deps.tournaments.tournament(from.tournamentId);
  if (!t || !(auth.admin || isTournamentManager(t, auth.coach))) throw new TemplateError(404, "Tournament not found.", "from");
  return captureTournament(t, deps.tournamentDiscordEvents?.(t.id), includePayLinks) as unknown as Record<string, unknown>;
}

function contentFromBody(kind: TemplateKind, input: Record<string, unknown>, auth: TemplatesAuth, deps: TemplatesDeps): Record<string, unknown> {
  const includePayLinks = input.includePayLinks !== false;
  if (input.from !== undefined) return captureFrom(kind, input.from, auth, includePayLinks, deps);
  // The tournament wizard's Review: the settings typed so far (nothing exists on the server yet). Site organisers only.
  if (kind !== "tournament") throw new TemplateError(400, "Save a season template from a season.", "from");
  if (!auth.organizer && !auth.admin) throw new TemplateError(403, "Only site organisers can save a template from the wizard.");
  const content = parseTournamentTemplateContent(input.content, tournamentContentOptions());
  if (!includePayLinks) delete content.payLinks;
  return content as unknown as Record<string, unknown>;
}

function known(e: unknown): TemplatesResult {
  if (e instanceof TemplateError) return fail(e.status, e.message, e.field);
  if (e instanceof DeletionFenceError) return fail(410, "This account is being deleted.");
  const s = (e as { status?: unknown })?.status;
  if (typeof s === "number" && s >= 400 && s < 500) return fail(s, (e as Error).message);
  return fail(500, "Could not save the template right now.");
}

function revisionOf(input: Record<string, unknown>): number | "missing" | "bad" {
  if (input.revision === undefined) return "missing";
  return typeof input.revision === "number" && Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : "bad";
}

export function templatesApi(method: string, path: string, query: URLSearchParams, auth: TemplatesAuth | undefined, body: unknown, deps: TemplatesDeps): TemplatesResult | undefined {
  if (!isTemplatesApiPath(path)) return undefined;
  const parts = path.slice(TEMPLATES_PATH.length).split("/").filter(Boolean);
  if (parts.length > 2) return fail(404, "Not found.");
  if (!auth) return fail(401, "Sign in to use templates.");
  const read = method === "GET" || method === "HEAD";
  if (!read && auth.test) return fail(403, "Test sign-in sessions can look at templates but not change them.");
  const input = isObj(body) ? body : {};
  try {
    // ---- the list, and saving a new template -------------------------------------------------------------------------
    if (parts.length === 0) {
      if (read) {
        const kind = query.get("kind");
        if (kind !== null && !isTemplateKind(kind)) return fail(400, "kind must be season or tournament.", "kind");
        const { own, shared } = deps.store.visibleTo(auth.coach, kind ?? undefined);
        return res(200, { templates: [...own, ...shared].map((t) => templateView(t, auth.coach, deps)) });
      }
      if (method !== "POST") return fail(405, "Use GET or POST.");
      if (!isTemplateKind(input.kind)) return fail(400, "kind must be season or tournament.", "kind");
      const name = cleanText(input.name, "name", "Name", TEMPLATE_NAME_MAX, true);
      const description = cleanText(input.description, "description", "Description", TEMPLATE_DESCRIPTION_MAX, false);
      const content = contentFromBody(input.kind, input, auth, deps);
      const t = deps.store.create({ kind: input.kind, owner: auth.coach, name, description, content });
      return res(201, { ok: true, template: templateView(t, auth.coach, deps) });
    }

    // ---- share targets ---------------------------------------------------------------------------------------------
    if (parts[0] === "organisers" && parts.length === 1) {
      if (!read) return fail(405, "Use GET.");
      const q = (query.get("q") ?? "").trim().toLowerCase();
      if (q.length < 2) return res(200, { organisers: [] });
      const rows = deps.organisers()
        .filter((o) => !same(o.coach, auth.coach))
        .filter((o) => o.coach.toLowerCase().includes(q) || (o.displayName ?? "").toLowerCase().includes(q))
        .map((o) => ({ coach: o.coach, name: o.displayName || o.coach }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 10);
      return res(200, { organisers: rows });
    }

    // ---- one template ----------------------------------------------------------------------------------------------
    const id = parts[0]!;
    const t = TEMPLATE_ID.test(id) ? readableTemplate(deps.store, id, auth.coach) : undefined;
    if (!t) return fail(404, "Template not found.");
    const mine = isOwner(t, auth.coach);
    const action = parts[1];

    if (action === undefined) {
      if (read) return res(200, { template: templateView(t, auth.coach, deps) });
      if (method !== "PATCH" && method !== "DELETE") return fail(405, "Use GET, PATCH or DELETE.");
      if (!mine) return fail(403, "Only the template's owner can change it. Make a copy to change your own.");
      if (method === "DELETE") {
        deps.store.remove(t.id, auth.coach);
        return res(200, { ok: true });
      }
      const asked = revisionOf(input);
      if (asked === "missing") return res(428, { error: "Send the template revision you loaded.", revision: t.revision });
      if (asked === "bad") return fail(400, "revision must be a whole number.", "revision");
      if (asked !== t.revision) return res(409, { error: "This template changed since you opened it. Reload to see the latest.", revision: t.revision });
      const name = input.name === undefined ? undefined : cleanText(input.name, "name", "Name", TEMPLATE_NAME_MAX, true);
      const description = input.description === undefined ? undefined : cleanText(input.description, "description", "Description", TEMPLATE_DESCRIPTION_MAX, false);
      const content = input.from !== undefined || input.content !== undefined ? contentFromBody(t.kind, input, auth, deps) : undefined;
      const saved = deps.store.update(t.id, auth.coach, (x) => {
        if (name !== undefined) x.name = name;
        if (description !== undefined) x.description = description;
        if (content) x.content = content;
      });
      return res(200, { ok: true, template: templateView(saved, auth.coach, deps) });
    }

    if (method !== "POST") return fail(405, "Use POST.");
    if (action === "copy") {
      const content = structuredClone(checkedContent(t)) as unknown as Record<string, unknown>;
      // The owner's payment links never travel to someone else's copy.
      if (!mine) delete content.payLinks;
      const name = input.name === undefined ? `Copy of ${t.name}`.slice(0, TEMPLATE_NAME_MAX) : cleanText(input.name, "name", "Name", TEMPLATE_NAME_MAX, true);
      const copy = deps.store.create({ kind: t.kind, owner: auth.coach, name, description: t.description, content, copiedFrom: t.id });
      return res(201, { ok: true, template: templateView(copy, auth.coach, deps) });
    }
    if (action === "share" || action === "unshare") {
      if (!mine) return fail(403, "Only the template's owner can change who has access.");
      if (typeof input.coach !== "string" || !input.coach.trim()) return fail(400, "Pick an organiser.", "coach");
      const wanted = input.coach.trim();
      if (action === "unshare") {
        if (!t.sharedWith.some((s) => same(s.coach, wanted))) return fail(404, "That organiser does not have access.", "coach");
        const saved = deps.store.update(t.id, auth.coach, (x) => { x.sharedWith = x.sharedWith.filter((s) => !same(s.coach, wanted)); });
        return res(200, { ok: true, template: templateView(saved, auth.coach, deps) });
      }
      if (same(wanted, auth.coach)) return fail(400, "You already own this template.", "coach");
      // By account only (the picker sends the account the search found); the target must be a site organiser now.
      const target = deps.organisers().find((o) => same(o.coach, wanted));
      if (!target) return fail(400, "Pick a site organiser from the list.", "coach");
      if (t.sharedWith.some((s) => same(s.coach, target.coach))) return res(200, { ok: true, changed: false, template: templateView(t, auth.coach, deps) });
      const at = (deps.now?.() ?? new Date()).toISOString();
      const saved = deps.store.update(t.id, auth.coach, (x) => { x.sharedWith = [...x.sharedWith, { coach: target.coach, at }]; });
      const ownerName = deps.displayName?.(t.owner) || t.owner;
      const where = t.kind === "season" ? "League settings, Templates, or Start a new season" : "the tournament wizard's Start from template, or Manage, Templates";
      try {
        deps.notify?.(target.coach, {
          type: "template-shared", from: t.owner, link: t.kind === "season" ? "/app/leagues" : "/app/tournaments/new",
          title: `${ownerName} shared a ${TEMPLATE_KIND_LABEL[t.kind].toLowerCase()} template with you`,
          body: `${ownerName} shared "${t.name}" with you. Use it or make your own copy from ${where}.`,
        });
      } catch { /* fire-and-forget */ }
      return res(200, { ok: true, changed: true, template: templateView(saved, auth.coach, deps) });
    }
    return fail(404, "Not found.");
  } catch (e) {
    return known(e);
  }
}
