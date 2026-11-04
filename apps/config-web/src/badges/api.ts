/**
 * Badge routes (badges lane, 11-04). Pure apart from the stores it is handed; server.ts passes the session identity and body.
 *
 *   GET  /api/badges/catalog                                   public: the catalog (names, icons, "coming soon" entries) + the icon set
 *   GET  /api/badges/coach/:coach                              public: a coach's badges (site + league custom ones)
 *   GET  /api/badges/team/:leagueId/:seasonId/:teamId          public: a league team's milestones (its lineage's awards)
 *   GET  /api/badges/league/:leagueId                          public: the league's custom badges and recent awards;
 *                                                              organisers also get the log and who can be awarded
 *   POST /api/badges/league/:leagueId/badges                   organisers { revision, name, description, icon, scope }
 *   PATCH /api/badges/league/:leagueId/badges/:badgeId         organisers { revision, name?, description?, icon?, archived? }
 *   POST /api/badges/league/:leagueId/badges/:badgeId/award    organisers { revision, coach } | { revision, seasonId, teamId }, note?
 *   POST /api/badges/league/:leagueId/awards/:awardId/revoke   organisers { revision, reason? }
 *
 * Who: an organiser (or the owner) of THAT league, or a site admin. Another league's organiser is a plain viewer here.
 * A test sign-in writes only in a test league. Every write names the league's badge revision (428 missing, 409 stale) and is
 * logged. Draft leagues answer as unknown to everyone but their organisers and admins; their notices reach only organisers
 * (draftAwareNotify). Privacy: coaches by account name only, never an email, phone or Discord id. GETs never write.
 */
import { randomBytes } from "node:crypto";
import { gameCoach } from "../leagues/identity.js";
import { draftAwareNotify, isDraftLeague, leagueVisibleTo } from "../leagues/lifecycle.js";
import type { LeagueStore } from "../leagues/store.js";
import { isLeagueOrganiser } from "../leagues/store.js";
import type { LeagueRecord, SeasonRecord } from "../leagues/types.js";
import type { NotificationInput } from "../notifications.js";
import type { WebhookPoster } from "../leagues/discord.js";
import { postWebhook as defaultPoster } from "../leagues/discord.js";
import { leagueTarget, postTo } from "../discord/targets.js";
import { post, safe } from "../discord/posts.js";
import { BADGE_CATALOG, badgeDefinition, badgeText } from "./catalog.js";
import { BADGE_ICONS, badgeGlyph, isBadgeIcon } from "./icons.js";
import { badgeCoachKey, earningCoach } from "./ledger.js";
import { logId } from "./engine.js";
import { BadgeStoreError, type BadgeFile, type BadgeStore, type CustomAward, type CustomBadge, type CustomScope, type StoredAward } from "./store.js";

export interface BadgesAuth { coach: string; admin?: boolean; test?: boolean }
export interface BadgesApiResult { status: number; body: unknown; headers?: Record<string, string> }

export interface BadgesApiDeps {
  store: BadgeStore;
  leagues: Pick<LeagueStore, "league" | "competitions" | "secrets" | "season">;
  isAdmin: (coach: string) => boolean;
  notify?: (coach: string, input: NotificationInput) => void;
  /** A coach under deletion cannot be awarded or write. */
  isFenced?: (coach: string) => boolean;
  poster?: WebhookPoster;
  now?: () => Date;
}

export const CUSTOM_NAME_MAX = 60;
export const CUSTOM_DESCRIPTION_MAX = 300;
export const CUSTOM_NOTE_MAX = 300;
export const CUSTOM_BADGES_MAX = 100;
export const RECENT_AWARDS = 50;

const NO_STORE = { "cache-control": "no-store" };
const ok = (body: unknown, status = 200): BadgesApiResult => ({ status, headers: NO_STORE, body });
const fail = (status: number, error: string): BadgesApiResult => ({ status, headers: NO_STORE, body: { error } });
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export const isBadgesApiPath = (path: string): boolean => path === "/api/badges" || path.startsWith("/api/badges/");
/** Public reads (requireSession.ts and server.ts authorized() list them). */
export const isPublicBadgeRead = (method: string, path: string): boolean =>
  (method === "GET" || method === "HEAD") && /^\/api\/badges\/(?:catalog|coach\/[^/]+|team\/[^/]+\/[^/]+\/[^/]+|league\/[^/]+)$/.test(path);

const seg = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined;
  try { const d = decodeURIComponent(s); return d.length && d.length <= 160 ? d : undefined; } catch { return undefined; }
};

// ---- views --------------------------------------------------------------------------------------------------------------

export interface BadgeView {
  id: string;
  badgeId: string;
  source: "site" | "league";
  name: string;
  description: string;
  icon: string;
  glyph: string;
  kind: "badge" | "achievement" | "custom";
  tier?: string;
  at: string;
  label?: string;
  link?: string;
  leagueId?: string;
  leagueName?: string;
  by?: string;
  note?: string;
}

function autoView(a: StoredAward): BadgeView | undefined {
  const def = badgeDefinition(a.badgeId);
  if (!def) return undefined;
  const t = badgeText(def, a.variant);
  return {
    id: a.key, badgeId: a.badgeId, source: "site", name: t.name, description: t.description, icon: def.icon, glyph: badgeGlyph(def.icon), kind: def.kind,
    ...(def.tier ? { tier: def.tier } : {}), at: a.at, ...(a.context.label ? { label: a.context.label } : {}), ...(a.context.link ? { link: a.context.link } : {}),
  };
}

function customView(league: Pick<LeagueRecord, "id" | "name">, badge: CustomBadge, a: CustomAward): BadgeView {
  return {
    id: a.id, badgeId: badge.id, source: "league", name: badge.name, description: badge.description, icon: badge.icon, glyph: badgeGlyph(badge.icon), kind: "custom",
    at: a.at, label: league.name, link: `/leagues/${encodeURIComponent(league.id)}?tab=awards`, leagueId: league.id, leagueName: league.name, by: a.by, ...(a.note ? { note: a.note } : {}),
  };
}

const newestFirst = (a: BadgeView, b: BadgeView): number => b.at.localeCompare(a.at) || a.id.localeCompare(b.id);

/** A subject's awards: site ones plus every visible league's custom ones. */
function subjectBadges(file: BadgeFile, deps: BadgesApiDeps, kind: "coach" | "team", key: string, viewer: BadgesAuth | undefined): BadgeView[] {
  const out: BadgeView[] = [];
  for (const a of file.auto) if (a.subject.kind === kind && a.subject.key === key) { const v = autoView(a); if (v) out.push(v); }
  for (const [leagueId, lb] of Object.entries(file.leagues)) {
    const league = deps.leagues.league(leagueId);
    if (!league || !leagueVisibleTo(league, viewer && { coach: viewer.coach, admin: deps.isAdmin(viewer.coach) })) continue;
    for (const a of lb.awards) {
      if (a.subject.kind !== kind || a.subject.key !== key) continue;
      const badge = lb.badges.find((b) => b.id === a.badgeId);
      if (badge) out.push(customView(league, badge, a));
    }
  }
  return out.sort(newestFirst);
}

/** The team key the ledger uses (lineage, else the season entry). */
export const teamBadgeKey = (leagueId: string, seasonId: string, team: { id: string; teamUid?: string }): string => (team.teamUid ? `u:${team.teamUid}` : `s:${leagueId}/${seasonId}/${team.id}`);

export function catalogView() {
  return {
    catalog: BADGE_CATALOG.map((d) => ({
      id: d.id, name: d.name, description: d.description, icon: d.icon, glyph: badgeGlyph(d.icon), kind: d.kind, scope: d.scope,
      ...(d.tier ? { tier: d.tier } : {}), ...(d.family ? { family: d.family } : {}), ...(d.variant ? { variant: d.variant } : {}), status: d.status, ...(d.missing ? { missing: d.missing } : {}),
    })),
    icons: Object.entries(BADGE_ICONS).map(([key, v]) => ({ key, glyph: v.glyph, label: v.label })),
  };
}

// ---- league membership (who an organiser may award) ---------------------------------------------------------------------

interface Members { coaches: Map<string, string>; teams: Array<{ seasonId: string; seasonName: string; teamId: string; team: string; key: string; coach?: string }> }

function leagueMembers(leagueId: string, comps: readonly SeasonRecord[]): Members {
  const coaches = new Map<string, string>();
  const teams: Members["teams"] = [];
  const addCoach = (c: string | undefined) => { const n = earningCoach(c); if (n && !coaches.has(badgeCoachKey(n))) coaches.set(badgeCoachKey(n), n); };
  for (const s of comps) {
    for (const t of s.teams ?? []) {
      const coach = t.coachAssigned?.cleared ? undefined : t.coachId;
      addCoach(coach);
      teams.push({ seasonId: s.id, seasonName: s.name, teamId: t.id, team: t.name, key: teamBadgeKey(leagueId, s.id, t), ...(earningCoach(coach) ? { coach: earningCoach(coach)! } : {}) });
    }
    for (const f of s.fixtures ?? []) for (const side of [f.home, f.away]) addCoach(gameCoach(side).coachId);
  }
  return { coaches, teams };
}

// ---- routing ------------------------------------------------------------------------------------------------------------

export async function badgesApi(method: string, path: string, auth: BadgesAuth | undefined, body: unknown, deps: BadgesApiDeps): Promise<BadgesApiResult | undefined> {
  if (!isBadgesApiPath(path)) return undefined;
  try {
    return route(method, path, auth, body, deps);
  } catch (e) {
    if (e instanceof BadgeStoreError) return fail(e.status, e.message);
    throw e;
  }
}

function route(method: string, path: string, auth: BadgesAuth | undefined, body: unknown, deps: BadgesApiDeps): BadgesApiResult {
  const parts = path.split("/").slice(3); // after /api/badges
  const read = method === "GET" || method === "HEAD";
  if (parts[0] === "catalog" && parts.length === 1) return read ? ok(catalogView()) : fail(405, "Method not allowed.");
  if (parts[0] === "coach" && parts.length === 2) {
    if (!read) return fail(405, "Method not allowed.");
    const coach = earningCoach(seg(parts[1]));
    if (!coach) return fail(404, "No such coach.");
    return ok({ coach, badges: subjectBadges(deps.store.read(), deps, "coach", badgeCoachKey(coach), auth) });
  }
  if (parts[0] === "team" && parts.length === 4) {
    if (!read) return fail(405, "Method not allowed.");
    const [leagueId, seasonId, teamId] = [seg(parts[1]), seg(parts[2]), seg(parts[3])];
    const league = leagueId ? deps.leagues.league(leagueId) : undefined;
    if (!league || !leagueVisibleTo(league, auth && { coach: auth.coach, admin: deps.isAdmin(auth.coach) })) return fail(404, "League not found.");
    const season = seasonId ? deps.leagues.season(league.id, seasonId) : undefined;
    const team = season?.teams.find((t) => t.id === teamId);
    if (!season || !team) return fail(404, "Team not found.");
    return ok({ team: team.name, badges: subjectBadges(deps.store.read(), deps, "team", teamBadgeKey(league.id, season.id, team), auth) });
  }
  if (parts[0] === "league" && parts.length >= 2) {
    const leagueId = seg(parts[1]);
    const league = leagueId ? deps.leagues.league(leagueId) : undefined;
    const admin = auth ? deps.isAdmin(auth.coach) : false;
    if (!league || !leagueVisibleTo(league, auth && { coach: auth.coach, admin })) return fail(404, "League not found.");
    const manage = Boolean(auth) && (admin || isLeagueOrganiser(league, auth!.coach));
    if (parts.length === 2) return read ? leagueRead(league, manage, deps) : fail(405, "Method not allowed.");
    if (read) return fail(405, "Method not allowed.");
    if (!auth) return fail(401, "Sign in first.");
    if (!manage) return fail(403, "Only this league's organisers can manage its badges.");
    if (auth.test && league.test !== true) return fail(403, "Test sign-in sessions can only change test leagues.");
    if (deps.isFenced?.(auth.coach)) return fail(410, "This account is being deleted.");
    if (!isObj(body)) return fail(400, "Send a JSON object.");
    return leagueWrite(method, parts.slice(2), league, auth.coach, body, deps);
  }
  return fail(404, "Not found.");
}

function leagueRead(league: LeagueRecord, manage: boolean, deps: BadgesApiDeps): BadgesApiResult {
  const file = deps.store.read();
  const lb = deps.store.league(file, league.id);
  const badges = lb.badges.filter((b) => manage || !b.archivedAt).map((b) => ({ ...b, glyph: badgeGlyph(b.icon), awards: lb.awards.filter((a) => a.badgeId === b.id).length }));
  const recent = lb.awards
    .flatMap((a) => { const b = lb.badges.find((x) => x.id === a.badgeId); return b ? [{ ...customView(league, b, a), to: { kind: a.subject.kind, name: a.subject.name } }] : []; })
    .sort(newestFirst).slice(0, RECENT_AWARDS);
  const out: Record<string, unknown> = { revision: lb.revision, manage, badges, recent };
  if (manage) {
    const m = leagueMembers(league.id, deps.leagues.competitions(league.id));
    out.log = file.log.filter((e) => e.leagueId === league.id && lb.badges.some((b) => b.id === e.badgeId)).slice(0, 100);
    out.members = { coaches: [...m.coaches.values()].sort((a, b) => a.localeCompare(b)), teams: m.teams.map(({ key: _k, ...t }) => t) };
    out.icons = catalogView().icons;
  }
  return ok(out);
}

function parseText(v: unknown, max: number, field: string, required: boolean): string | BadgesApiResult {
  if (v === undefined && !required) return "";
  if (typeof v !== "string") return fail(400, `${field} is required.`);
  // eslint-disable-next-line no-control-regex
  const s = v.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (required && !s) return fail(400, `${field} is required.`);
  if (s.length > max) return fail(400, `${field} is ${max} characters at most.`);
  return s;
}
const isResult = (v: unknown): v is BadgesApiResult => isObj(v) && typeof v.status === "number" && "body" in v;
const SCOPES: readonly CustomScope[] = ["coach", "team", "both"];

function leagueWrite(method: string, rest: string[], league: LeagueRecord, actor: string, body: Record<string, unknown>, deps: BadgesApiDeps): BadgesApiResult {
  if (body.revision === undefined) return fail(428, "Send the badges revision you last read.");
  if (typeof body.revision !== "number" || !Number.isInteger(body.revision)) return fail(400, "Bad revision.");
  const now = (deps.now?.() ?? new Date()).toISOString();
  const file = deps.store.read();
  const lb = deps.store.league(file, league.id);
  if (body.revision !== lb.revision) return fail(409, "The league's badges changed meanwhile. Reload and try again.");
  const commit = (entry: Omit<BadgeFile["log"][number], "id" | "at" | "by" | "leagueId">): void => {
    lb.revision += 1;
    file.leagues[league.id] = lb;
    file.log.unshift({ id: logId(), at: now, by: actor, leagueId: league.id, ...entry });
    deps.store.write(file);
  };

  // POST .../badges: create
  if (rest.length === 1 && rest[0] === "badges" && method === "POST") {
    if (lb.badges.length >= CUSTOM_BADGES_MAX) return fail(409, `A league has ${CUSTOM_BADGES_MAX} custom badges at most.`);
    const name = parseText(body.name, CUSTOM_NAME_MAX, "Name", true);
    if (isResult(name)) return name;
    const description = parseText(body.description, CUSTOM_DESCRIPTION_MAX, "Description", false);
    if (isResult(description)) return description;
    if (!isBadgeIcon(body.icon)) return fail(400, "Pick an icon from the list.");
    const scope = body.scope === undefined ? "both" : body.scope;
    if (!SCOPES.includes(scope as CustomScope)) return fail(400, "Scope is coach, team or both.");
    if (lb.badges.some((b) => !b.archivedAt && b.name.toLowerCase() === name.toLowerCase())) return fail(409, "This league already has a badge with that name.");
    const badge: CustomBadge = { id: `cb-${randomBytes(6).toString("hex")}`, name, description, icon: body.icon, scope: scope as CustomScope, createdBy: actor, createdAt: now, updatedAt: now };
    lb.badges.push(badge);
    commit({ action: "create", badgeId: badge.id });
    return ok({ revision: lb.revision, badge }, 201);
  }

  // PATCH .../badges/:id: edit / archive
  if (rest.length === 2 && rest[0] === "badges" && method === "PATCH") {
    const badge = lb.badges.find((b) => b.id === rest[1]);
    if (!badge) return fail(404, "Badge not found.");
    if (body.name !== undefined) { const v = parseText(body.name, CUSTOM_NAME_MAX, "Name", true); if (isResult(v)) return v; badge.name = v; }
    if (body.description !== undefined) { const v = parseText(body.description, CUSTOM_DESCRIPTION_MAX, "Description", false); if (isResult(v)) return v; badge.description = v; }
    if (body.icon !== undefined) { if (!isBadgeIcon(body.icon)) return fail(400, "Pick an icon from the list."); badge.icon = body.icon; }
    let action: "edit" | "archive" = "edit";
    if (body.archived !== undefined) {
      if (typeof body.archived !== "boolean") return fail(400, "archived is true or false.");
      if (body.archived && !badge.archivedAt) { badge.archivedAt = now; action = "archive"; }
      if (!body.archived) delete badge.archivedAt;
    }
    badge.updatedAt = now;
    commit({ action, badgeId: badge.id });
    return ok({ revision: lb.revision, badge });
  }

  // POST .../badges/:id/award
  if (rest.length === 3 && rest[0] === "badges" && rest[2] === "award" && method === "POST") {
    const badge = lb.badges.find((b) => b.id === rest[1]);
    if (!badge) return fail(404, "Badge not found.");
    if (badge.archivedAt) return fail(409, "This badge is archived.");
    const note = parseText(body.note, CUSTOM_NOTE_MAX, "Note", false);
    if (isResult(note)) return note;
    const members = leagueMembers(league.id, deps.leagues.competitions(league.id));
    let award: CustomAward;
    if (typeof body.coach === "string") {
      if (badge.scope === "team") return fail(400, "This badge is for teams.");
      const coach = members.coaches.get(badgeCoachKey(body.coach));
      if (!coach) return fail(400, "That coach does not play in this league.");
      if (deps.isFenced?.(coach)) return fail(409, "That account is being deleted.");
      award = { id: `ca-${randomBytes(6).toString("hex")}`, badgeId: badge.id, subject: { kind: "coach", key: badgeCoachKey(coach), name: coach }, ...(note ? { note } : {}), by: actor, at: now };
    } else if (typeof body.seasonId === "string" && typeof body.teamId === "string") {
      if (badge.scope === "coach") return fail(400, "This badge is for coaches.");
      const t = members.teams.find((x) => x.seasonId === body.seasonId && x.teamId === body.teamId);
      if (!t) return fail(400, "That team is not in this league.");
      award = {
        id: `ca-${randomBytes(6).toString("hex")}`, badgeId: badge.id, subject: { kind: "team", key: t.key, name: t.team, seasonId: t.seasonId, teamId: t.teamId },
        ...(t.coach ? { coach: t.coach } : {}), ...(note ? { note } : {}), by: actor, at: now,
      };
    } else return fail(400, "Pick a coach or a team.");
    if (lb.awards.some((a) => a.badgeId === badge.id && a.subject.kind === award.subject.kind && a.subject.key === award.subject.key)) return fail(409, "Already awarded.");
    lb.awards.push(award);
    commit({ action: "award", badgeId: badge.id, subject: { kind: award.subject.kind, key: award.subject.key, name: award.subject.name } });
    announceCustom(league, badge, award, deps);
    return ok({ revision: lb.revision, award }, 201);
  }

  // POST .../awards/:id/revoke
  if (rest.length === 3 && rest[0] === "awards" && rest[2] === "revoke" && method === "POST") {
    const i = lb.awards.findIndex((a) => a.id === rest[1]);
    if (i < 0) return fail(404, "Award not found.");
    const reason = parseText(body.reason, CUSTOM_NOTE_MAX, "Reason", false);
    if (isResult(reason)) return reason;
    const [gone] = lb.awards.splice(i, 1);
    commit({ action: "revoke", badgeId: gone!.badgeId, subject: { kind: gone!.subject.kind, key: gone!.subject.key, name: gone!.subject.name }, ...(reason ? { reason } : {}) });
    return ok({ revision: lb.revision });
  }
  return fail(404, "Not found.");
}

/** The coach's inbox note (draft leagues: organisers only) and the league's "Badge earned" post (off by default). */
function announceCustom(league: LeagueRecord, badge: CustomBadge, award: CustomAward, deps: BadgesApiDeps): void {
  const coach = award.subject.kind === "coach" ? award.subject.name : award.coach;
  if (coach && deps.notify) {
    const tell = draftAwareNotify(deps.leagues, league.id, deps.notify, deps.isAdmin);
    const to = award.subject.kind === "team" ? ` (${award.subject.name})` : "";
    try {
      tell(coach, { type: "award", title: `Badge earned: ${badge.name}`, body: `${league.name} gave you${to} the ${badge.name} badge.${award.note ? ` ${award.note}` : ""}`, link: "/home#badges", from: award.by, subject: badge.name });
    } catch { /* fire-and-forget */ }
  }
  if (isDraftLeague(league)) return;
  try {
    const target = leagueTarget(deps.leagues, league);
    const payload = post(`${target.test ? "[Test] " : ""}${safe(league.name, 100)}: badge earned`, `${badgeGlyph(badge.icon)} ${safe(award.subject.name, 60)} earned **${safe(badge.name, 60)}**.${badge.description ? ` ${safe(badge.description, 200)}` : ""}`, 0xe8b02c);
    void postTo(target, "badgeEarned", payload, deps.poster ?? defaultPoster);
  } catch { /* best effort */ }
}
