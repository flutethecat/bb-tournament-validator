/**
 * Team library, swap and takeover routes (spec-team-management-2026-11-02; teamLibrary.ts, takeover.ts). Every write
 * needs a session (CSRF X-CW-Auth and the onboarding gate run in front of every /api write in server.ts); GETs never
 * change state.
 *
 *   GET  /api/leagues/:id/seasons/:sid/library/:coach                    organisers + admins: a MEMBER's library
 *   GET  /api/leagues/:id/seasons/:sid/teams/:teamId/library             organisers + admins: the team coach's library
 *   POST /api/leagues/:id/seasons/:sid/teams/:teamId/swap                { revision, ref } the entry gets that team
 *   POST /api/leagues/:id/seasons/:sid/teams/:teamId/takeover            { revision, available, note? } list / unlist
 *   GET  /api/leagues/:id/seasons/:sid/takeovers                         signed in: listings, my applications, and for
 *                                                                        organisers every application
 *   GET  /api/leagues/:id/seasons/:sid/takeovers/my-teams                signed in: my teams judged against the season
 *   POST /api/leagues/:id/seasons/:sid/takeovers/:listingId/applications  { mode, teamRef?, share?, acknowledged? }
 *   POST /api/leagues/:id/seasons/:sid/takeovers/:listingId/applications/:appId/(approve|decline|withdraw) { reason? }
 *
 * Who: the library and swap are for organisers of THIS league and site admins (another league's organiser gets 403), and
 * a library is shown only for a coach who is a member of the league (on its roster) and has acknowledged the league
 * notice ("its organisers can see your coach name and your teams"; deps.memberContact). Anyone else answers 404 whether
 * or not the coach exists. Listing a team for takeover: the league's organisers or a site admin (the spec says "an
 * admin"; organisers run their league, so both). Applying: any signed-in coach (members and non-members) but the
 * team's own coach; non-members acknowledge the league notice (the share step) as at join.
 *
 * Atomic: a swap, a listing change and an approval are each ONE season write; the takeover panel is on the league
 * overview only (no Browse leagues filter, round answer Q8).
 */
import { createHmac, randomBytes } from "node:crypto";
import { ContactValidationError, parseShareFields, type ShareField } from "../auth/contactSchema.js";
import type { SharedContact } from "../auth/contactFor.js";
import { houseRulesOf } from "../competition/houseRules.js";
import { leaguePackageName } from "../leagueBuilderMarker.js";
import { RegistrationError, type RegistrationActor } from "../registration/index.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { fixtureLockKey, withForkLocks } from "./forkPlay.js";
import { forkTeamIdFor } from "./forkTeam.js";
import { readJsonObject, requestRevision } from "./http.js";
import { canonicalRace, rosterAllowed } from "./leagueBuilder.js";
import { managesLeague } from "./lifecycle.js";
import { notifyRecordChange } from "./recordChange.js";
import { freshTeamId, lineageFor, snapshotFromRoster, teamFromSnapshot, type LeagueTeamSnapshot } from "./registration.js";
import { seasonRegistrationOf } from "./seasonRegistration.js";
import { leagueOwner, rosterAccounts } from "./store.js";
import {
  APPLICATION_ID, applicationToEntry, closeListing, LISTING_ID, listedTeam, takeoverCompetitionId, takeoverLink, takeoverService,
  type TakeoverApplicationRow, type TakeoverApproval, type TakeoverEntryData,
} from "./takeover.js";
import {
  adoptLineage, applyEntrySwap, entryChangeBlock, entryHistoryLine, leagueTeamProblem, leagueTeamRef, leagueTeamsOf, parseLeagueTeamRef, setTakeoverListing, snapshotOfLeagueTeam, teamFixtures, teamFromLeagueTeam, transferSource,
  type CoachTeamRow, type LibraryItem,
} from "./teamLibrary.js";
import { addHistory, ensureTeamIdentity, publicTeam, settleServedMng, teamGamesPlayed } from "./teamOps.js";
import type { LeagueRecord, LeagueTeam, SeasonRecord } from "./types.js";

export interface TeamLibraryApiDeps {
  /** The coach's Roster Builder saves and fork library teams (server.ts: their own files only). */
  coachTeams?: (coach: string) => CoachTeamRow[];
  /** Fault injection (tests): runs inside a swap / listing write just before the season file is written. */
  teamLibraryBeforeWrite?: (season: SeasonRecord) => void;
}

const BODY_MAX = 16 * 1024;
const NOTE_MAX = 300;
const REASON_MAX = 500;
const LIBRARY_MAX = 60;
const NO_STORE = { "cache-control": "private, no-store" };
/** A Roster Builder save (fork library teams are per-fixture copies, never a source: owner 11-03). */
const TEAM_REF = /^save:[A-Za-z0-9_.:-]{1,110}$/;
const ckey = (c: string | undefined): string => (c ?? "").normalize("NFC").trim().toLowerCase();

/**
 * Organisers never see the real reference of a team masked from them (a private saved team, another league's team): only an
 * opaque token, keyed to this league, entry and coach with a per-process secret (a dialog reloaded after a restart simply
 * gets new tokens). The server maps it back to the coach's own candidates; nothing is stored.
 */
const TOKEN_KEY = randomBytes(32);
const MASK_TOKEN = /^pv-[0-9a-f]{24}$/;
export const maskToken = (leagueId: string, entryTeamId: string, owner: string, ref: string): string =>
  `pv-${createHmac("sha256", TOKEN_KEY).update(`${leagueId}\0${entryTeamId}\0${ckey(owner)}\0${ref}`).digest("hex").slice(0, 24)}`;
const res = (status: number, body: unknown): LeagueApiResult => ({ status, body, headers: { ...NO_STORE } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => res(status, { error, ...extra });
const actorOf = (auth: LeagueApiIdentity): RegistrationActor => ({ coach: auth.coach, ...(auth.admin ? { admin: true } : {}), ...(auth.test ? { test: true } : {}) });
const managersOf = (league: LeagueRecord): string[] => { const o = leagueOwner(league); return [...new Set([...(o ? [o] : []), ...league.organisers])]; };
const teamLink = (leagueId: string, seasonId: string, teamId: string): string =>
  `/app/leagues/${encodeURIComponent(leagueId)}?season=${encodeURIComponent(seasonId)}&tab=participants&team=${encodeURIComponent(teamId)}`;

/** The team's coach account (a seat an organiser cleared names nobody). */
const seatOf = (team: LeagueTeam): string | undefined => (team.coachAssigned?.cleared ? undefined : team.coachId?.trim() || undefined);

function send(deps: LeagueApiDeps, coach: string | undefined, input: Parameters<NonNullable<LeagueApiDeps["notify"]>>[1]): void {
  if (!coach) return;
  try { deps.notify?.(coach, input); } catch { /* fire-and-forget */ }
}

// ---- membership + libraries ---------------------------------------------------------------------------------------------

/** A league member whose library the viewer (an organiser of THIS league, or an admin) may see: on the league's roster
 *  and sharing with the league (the acknowledged notice). Fails closed without the identity lookup. */
export function libraryVisible(league: LeagueRecord, coach: string, viewer: LeagueApiIdentity, deps: LeagueApiDeps): boolean {
  if (!managesLeague(league, viewer) || !ckey(coach)) return false;
  if (!rosterAccounts(deps.store.competitions(league.id)).has(ckey(coach))) return false;
  if (!deps.memberContact) return false;
  try { return deps.memberContact({ coach: viewer.coach, ...(viewer.admin ? { admin: true } : {}) }, coach, league.id) !== undefined; } catch { return false; }
}

/** A save / library team composed and checked against the season (the L6 join check), with its snapshot when it fits. */
function checkSheet(league: LeagueRecord, season: SeasonRecord, coach: string, ref: string, deps: LeagueApiDeps, now: Date):
  { ok: true; name: string; race: string; libraryTeamId?: string; snapshot: LeagueTeamSnapshot } | { ok: false; name?: string; race?: string; reason: string } {
  if (!deps.leagueTeamSheet) return { ok: false, reason: "Team checks are unavailable on this host." };
  const sheet = deps.leagueTeamSheet(coach, ref, leaguePackageName(league.id, season.id), houseRulesOf(league, "league"), now);
  if ("error" in sheet) return { ok: false, reason: sheet.error };
  const race = canonicalRace(sheet.roster?.rosterName || sheet.race || "");
  if (!sheet.validation.ok || !sheet.roster) return { ok: false, name: sheet.teamName, race, reason: sheet.validation.problems.join(" ") || "The team can't be checked automatically." };
  const allowed = rosterAllowed(race, seasonRegistrationOf(league, season).allowedRosters);
  if (!allowed.allowed) return { ok: false, name: sheet.teamName, race, reason: allowed.reason };
  return { ok: true, name: sheet.teamName, race, ...(sheet.libraryTeamId ? { libraryTeamId: sheet.libraryTeamId } : {}), snapshot: snapshotFromRoster(sheet.roster, sheet.teamName) };
}

/** The coach's library judged against the season: saves, library teams, then league teams; fitting teams first in each. */
export function libraryItems(league: LeagueRecord, season: SeasonRecord, coach: string, deps: LeagueApiDeps, opts: { teamId?: string; leagueTeams: boolean; organiser?: boolean; requestable?: boolean }): LibraryItem[] {
  const now = deps.now?.() ?? new Date();
  let rows: CoachTeamRow[] = [];
  try { rows = (deps.coachTeams?.(coach) ?? []).slice(0, LIBRARY_MAX); } catch { rows = []; }
  const own: LibraryItem[] = rows.filter((r) => TEAM_REF.test(r.ref)).map((r) => {
    // An organiser never sees anything of a team the coach never shared (no name, race, value or check result): it shows
    // as a private team, and picking it only asks the coach to approve the swap.
    // Only the entry's own coach can be asked; another member's private team is greyed.
    if (opts.organiser && !r.shared) {
      const token = maskToken(league.id, opts.teamId ?? "", coach, r.ref);
      return opts.requestable
        ? { ref: token, kind: r.kind, name: "Private saved team", race: "", tv: null, ok: true, private: true }
        : { ref: token, kind: r.kind, name: "Private saved team", race: "", tv: null, ok: false, private: true, reason: "Not shared with the organisers." };
    }
    const c = checkSheet(league, season, coach, r.ref, deps, now);
    return {
      ref: r.ref, kind: r.kind, name: c.name || r.name, race: c.race || r.race, tv: r.tv, ok: c.ok,
      ...(c.ok ? {} : { reason: c.reason }),
    };
  });
  const lg: LibraryItem[] = !opts.leagueTeams ? [] : leagueTeamsOf(deps.store, coach, { leagueId: league.id }).map((x): LibraryItem => {
    const ref = leagueTeamRef(x.league.id, x.season.id, x.team.id);
    // Another league's team (its coach permitted a transfer) stays masked from these organisers until the coach consents.
    if (opts.organiser && x.league.id !== league.id) {
      const token = maskToken(league.id, opts.teamId ?? "", coach, ref);
      return opts.requestable
        ? { ref: token, kind: "league", name: "League team (transfer permitted)", race: "", tv: null, ok: true, private: true }
        : { ref: token, kind: "league", name: "League team (transfer permitted)", race: "", tv: null, ok: false, private: true, reason: "Only its coach can offer it." };
    }
    const problem = leagueTeamProblem(x, { league, season, ...(opts.teamId ? { teamId: opts.teamId } : {}) });
    return {
      ref: leagueTeamRef(x.league.id, x.season.id, x.team.id), kind: "league" as const, name: x.team.name, race: x.team.race,
      tv: x.team.teamValue ?? null, source: `${x.league.name} ${x.season.name}`, ok: !problem, ...(problem ? { reason: problem } : {}),
    };
  });
  const order = { save: 0, league: 1 } as const;
  return [...own, ...lg].sort((a, b) => order[a.kind] - order[b.kind] || Number(b.ok) - Number(a.ok) || a.name.localeCompare(b.name));
}

// ---- routes -----------------------------------------------------------------------------------------------------------------

export async function teamLibraryRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, seasonId, third, a, b, c, d, ...more] = rest;
  if (first !== "seasons" || !seasonId || more.length) return undefined;
  const read = method === "GET" || method === "HEAD";
  try {
    if (third === "library" && a && b === undefined) {
      if (!read) return fail(405, "Use GET.");
      return memberLibrary(seasonId, a, league, auth, deps);
    }
    if (third === "teams" && a && b === "swap-request" && d === undefined) return await swapRequestRoute(method, seasonId, a, c, league, auth, deps);
    if (third === "teams" && a && b === "transfer" && c === undefined) { if (method !== "POST") return fail(405, "Use POST."); return await transferRoute(seasonId, a, league, auth, deps); }
    if (third === "my-teams" && a === undefined) { if (!read) return fail(405, "Use GET."); return myTeams(seasonId, league, auth, deps); }
    if (third === "teams" && a && (b === "library" || b === "swap" || b === "takeover") && c === undefined) {
      if (b === "library") { if (!read) return fail(405, "Use GET."); return teamLibrary(seasonId, a, league, auth, deps); }
      if (method !== "POST") return fail(405, "Use POST.");
      return await (b === "swap" ? swap(seasonId, a, league, auth, deps) : listing(seasonId, a, league, auth, deps));
    }
    if (third === "takeovers") {
      if (a === undefined) { if (!read) return fail(405, "Use GET."); return takeoverPanel(seasonId, league, auth, deps); }
      if (a === "my-teams" && b === undefined) { if (!read) return fail(405, "Use GET."); return myTeams(seasonId, league, auth, deps); }
      if (b === "applications") {
        if (method !== "POST") return fail(405, "Use POST.");
        if (c === undefined) return await apply(seasonId, a, league, auth, deps);
        if (d === "approve" || d === "decline" || d === "withdraw") return await decide(seasonId, a, c, d, league, auth, deps);
        return fail(404, "Not found.");
      }
      return undefined;
    }
  } catch (e) {
    if (e instanceof RegistrationError) return fail(e.status, e.message, { code: e.code });
    throw e;
  }
  return undefined;
}

function managerGate(league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined): LeagueApiResult | undefined {
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!league) return fail(404, "League not found.");
  if (!managesLeague(league, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can do that.");
  return undefined;
}

function memberLibrary(seasonId: string, coach: string, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): LeagueApiResult {
  const gate = managerGate(league, auth);
  if (gate) return gate;
  const season = deps.store.season(league!.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  // Not a member (or not sharing): the same answer as an unknown coach.
  if (!libraryVisible(league!, coach, auth!, deps)) return fail(404, "No member of this league by that name.");
  return res(200, { coach: coach.trim(), items: libraryItems(league!, season, coach.trim(), deps, { leagueTeams: true, organiser: true, requestable: false }) });
}

function teamLibrary(seasonId: string, teamId: string, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): LeagueApiResult {
  const gate = managerGate(league, auth);
  if (gate) return gate;
  const season = deps.store.season(league!.id, seasonId);
  const team = season?.teams.find((t) => t.id === teamId);
  if (!season || !team) return fail(404, "Team not found.");
  const coach = seatOf(team);
  const block = entryChangeBlock(season, team.id);
  const base = { team: { id: team.id, name: team.name, race: team.race, games: teamGamesPlayed(season, team.id) }, ...(block ? { block } : {}) };
  if (!coach) return res(200, { ...base, coach: null, items: [], reason: "This team has no coach account: assign one first." });
  if (!libraryVisible(league!, coach, auth!, deps)) return res(200, { ...base, coach, items: [], reason: "This coach hasn't shared their teams with this league yet." });
  return res(200, { ...base, coach, ...(team.swapRequest ? { request: { by: team.swapRequest.by, at: team.swapRequest.at } } : {}), items: libraryItems(league!, season, coach, deps, { teamId: team.id, leagueTeams: true, organiser: true, requestable: true }) });
}

function revisionError(input: Record<string, unknown>, season: SeasonRecord, deps: LeagueApiDeps): LeagueApiResult | undefined {
  const current = season.revision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return fail(428, "Send the season revision you loaded (revision or If-Match).", { revision: current });
  if (asked === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  if (asked !== current) return fail(409, "This season changed since you opened it. Reload to see the latest.", { revision: current });
  return undefined;
}

/** Fixture ids of the season with a tabletop recorder match not published yet; undefined = the recorder can't be read. */
export async function openRecorderFixtures(deps: LeagueApiDeps, leagueId: string, seasonId: string): Promise<Set<string> | undefined> {
  if (!deps.tabletop) return new Set();
  const prefix = `league:${leagueId}:${seasonId}:`;
  try {
    // Fail closed: a match file the recorder can't read could be an open match on one of these fixtures.
    let matches;
    if (deps.tabletop.listMatchesChecked) {
      const checked = await deps.tabletop.listMatchesChecked();
      if (checked.unreadable.length) return undefined;
      matches = checked.matches;
    } else matches = await deps.tabletop.listMatches();
    return new Set(matches.filter((m) => typeof m.fixtureRef === "string" && m.fixtureRef.startsWith(prefix) && m.state !== "published").map((m) => m.fixtureRef!.slice(prefix.length)));
  } catch {
    return undefined;
  }
}

/** The fork locks a change of the team behind an entry takes (the fork routes' order: fixtures, then the team). */
export function entryLocks<T>(leagueId: string, season: SeasonRecord, teamId: string, task: () => Promise<T>): Promise<T> {
  return withForkLocks(teamFixtures(season, teamId).map((f) => fixtureLockKey(leagueId, season.id, f.id)), [forkTeamIdFor(leagueId, season.id, teamId)], task);
}

async function swap(seasonId: string, teamId: string, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  const gate = managerGate(league, auth);
  if (gate) return gate;
  const body = await readJsonObject(deps, BODY_MAX);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const input = body.value;
  const lg = deps.store.league(league!.id);
  if (!lg || !managesLeague(lg, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can do that.");
  const season = deps.store.season(lg.id, seasonId);
  const team = season?.teams.find((t) => t.id === teamId);
  if (!season || !team) return fail(404, "Team not found.");
  const stale = revisionError(input, season, deps);
  if (stale) return stale;
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (!ref) return fail(400, "Pick a team from the coach's library.", { field: "ref" });
  const seat = seatOf(team);
  if (!seat) return fail(409, "This team has no coach account: assign one first.");
  // Whose team goes in: the entry's coach (default), or any member who SHARED it (owner 11-03: organisers may replace a team
  // by other means whatever the coach answered to a request).
  if (input.coach !== undefined && (typeof input.coach !== "string" || !input.coach.trim())) return fail(400, "coach must name a member of the league.", { field: "coach" });
  const owner = typeof input.coach === "string" ? input.coach.trim() : seat;
  const own = ckey(owner) === ckey(seat);
  if (!libraryVisible(lg, owner, auth!, deps)) return own ? fail(403, "This coach hasn't shared their teams with this league yet.") : fail(404, "No member of this league by that name.");
  let privateTeam = false;
  if (MASK_TOKEN.test(ref)) {
    // A masked team: map the token back to one of the owner's own private candidates (else it never existed).
    let rows: CoachTeamRow[] = [];
    try { rows = deps.coachTeams?.(owner) ?? []; } catch { rows = []; }
    const candidates = [
      ...rows.filter((r) => TEAM_REF.test(r.ref) && !r.shared).map((r) => r.ref),
      ...leagueTeamsOf(deps.store, owner, { leagueId: lg.id }).filter((x) => x.league.id !== lg.id).map((x) => leagueTeamRef(x.league.id, x.season.id, x.team.id)),
    ];
    const real = candidates.find((c) => maskToken(lg.id, team.id, owner, c) === ref);
    if (!real) return fail(404, "That team isn't in this coach's library.", { field: "ref" });
    if (!own) return fail(403, "That team isn't shared with this league's organisers.", { field: "ref" });
    return requestSwap(lg, season, team, seat, real, auth!, deps);
  }
  if (TEAM_REF.test(ref)) {
    let rows: CoachTeamRow[] = [];
    try { rows = deps.coachTeams?.(owner) ?? []; } catch { rows = []; }
    const row = rows.find((r) => r.ref === ref);
    if (!row) return fail(404, "That team isn't in this coach's library.", { field: "ref" });
    privateTeam = !row.shared;
    if (privateTeam) return fail(404, "That team isn't in this coach's library.", { field: "ref" }); // masked teams go by token
  } else {
    const r = parseLeagueTeamRef(ref);
    if (!r) return fail(400, "ref must name a saved team or a league team of the coach.", { field: "ref" });
    if (!leagueTeamsOf(deps.store, owner, { leagueId: lg.id }).some((x) => x.league.id === r.leagueId && x.season.id === r.seasonId && x.team.id === r.teamId))
      return fail(404, "That team isn't in this coach's library.", { field: "ref" });
    privateTeam = r.leagueId !== lg.id; // another league's team (transfer permitted): masked, so it goes by token
    if (privateTeam) return fail(404, "That team isn't in this coach's library.", { field: "ref" });
  }
  if (privateTeam) {
    // Only the entry's own coach can be asked; nobody else's private team is ever used.
    if (!own) return fail(403, "That team isn't shared with this league's organisers.", { field: "ref" });
    return requestSwap(lg, season, team, seat, ref, auth!, deps);
  }
  return performSwap(lg, seasonId, teamId, seat, ref, auth!.coach, deps, { revision: season.revision ?? 0, owner });
}

/** Stores the organiser's request to swap in one of the coach's private teams and asks the coach (an actionable note). */
function requestSwap(lg: LeagueRecord, season: SeasonRecord, team: LeagueTeam, coach: string, ref: string, auth: LeagueApiIdentity, deps: LeagueApiDeps): LeagueApiResult {
  const block = entryChangeBlock(season, team.id);
  if (block) return fail(409, block);
  const at = (deps.now?.() ?? new Date()).toISOString();
  team.swapRequest = { id: `sr-${randomBytes(6).toString("hex")}`, ref, by: auth.coach, at };
  addHistory(team, { at, by: auth.coach, kind: "swap", changes: [{ what: "Swap requested (waiting for the coach)" }] });
  try {
    deps.teamLibraryBeforeWrite?.(season);
    deps.store.putSeason(season);
  } catch {
    return fail(500, "Could not save the request right now. Nothing was changed.");
  }
  send(deps, coach, {
    type: "league-broadcast", title: `Swap request: ${team.name}`, action: true, from: auth.coach, subject: lg.name, link: teamLink(lg.id, season.id, team.id),
    body: `${auth.coach} asks to swap ${team.name} in ${lg.name} ${season.name} for one of your private teams. Open the team page to see which one, then approve or decline.`,
  });
  const saved = deps.store.season(lg.id, season.id) ?? season;
  return res(202, { ok: true, requested: true, revision: saved.revision ?? 0 });
}

/**
 * The swap itself, under the fork locks of the team's fixtures and fork team (a generate / launch in flight finishes
 * first and the swap is judged against what it recorded), re-read and written synchronously in ONE season write: the
 * entry change, its fixtures and participant row, the registration row, and the takeover listing closed (its pending
 * applications declined).
 */
async function performSwap(
  lg: LeagueRecord, seasonId: string, teamId: string, coach: string, ref: string, actor: string, deps: LeagueApiDeps,
  opts: { revision?: number; requestId?: string; requestedBy?: string; owner?: string },
): Promise<LeagueApiResult> {
  const owner = opts.owner ?? coach;
  const first = deps.store.season(lg.id, seasonId);
  if (!first) return fail(404, "Season not found.");
  const open = await openRecorderFixtures(deps, lg.id, seasonId);
  if (!open) return fail(503, "The tabletop recorder can't be read right now (or a match file is unreadable), so the swap can't be checked. Try again or ask a site admin.");
  return entryLocks(lg.id, first, teamId, async () => {
    const season = deps.store.season(lg.id, seasonId);
    const team = season?.teams.find((t) => t.id === teamId);
    if (!season || !team) return fail(404, "Team not found.");
    if (opts.revision !== undefined && (season.revision ?? 0) !== opts.revision) return fail(409, "This season changed since you opened it. Reload to see the latest.", { revision: season.revision ?? 0 });
    if (opts.requestId && team.swapRequest?.id !== opts.requestId) return fail(409, "This swap request is no longer open.");
    if (ckey(seatOf(team)) !== ckey(coach)) return fail(409, "The team's coach changed meanwhile. Reload to see the latest.");
    const block = entryChangeBlock(season, team.id, open);
    if (block) return fail(409, block);
    const now = deps.now?.() ?? new Date();
    const at = now.toISOString();
    const seasons = deps.store.competitions(lg.id);
    let incoming: LeagueTeam;
    if (parseLeagueTeamRef(ref)) {
      const found = transferSource(deps.store, owner, ref, { league: lg, season, teamId: team.id });
      if ("error" in found) return fail(found.status, found.error, { code: "invalid-team", field: "ref" });
      const used = new Set(seasons.flatMap((s) => s.teams.flatMap((t) => [...t.players, ...(t.formerPlayers ?? [])].map((p) => p.playerId))));
      const moved = adoptLineage(deps.store, found.source, at);
      incoming = teamFromLeagueTeam(moved.team, season, { id: team.id, usedIds: used, from: moved.from });
      incoming.coach = owner;
      incoming.coachId = owner;
    } else {
      const checked = checkSheet(lg, season, owner, ref, deps, now);
      if (!checked.ok) return fail(400, checked.reason, { code: "invalid-team", field: "ref" });
      incoming = teamFromSnapshot(lg, season, checked.snapshot, {
        id: freshTeamId(season), coach: owner, teamName: checked.name, race: checked.race, by: actor, at,
        teamUid: lineageFor(seasons, checked.libraryTeamId), entryId: team.entryId ?? "", ...(checked.libraryTeamId ? { libraryTeamId: checked.libraryTeamId } : {}),
      });
    }
    settleServedMng(season);
    // A listed entry stops being available: its pending applications are declined in this same write.
    const declined = closeListing(season, team, actor, at);
    const change = applyEntrySwap(season, team.id, incoming, actor, at, "swap");
    try {
      deps.teamLibraryBeforeWrite?.(season);
      deps.store.putSeason(season);
    } catch {
      return fail(500, "Could not save the swap right now. Nothing was changed.");
    }
    const link = teamLink(lg.id, season.id, team.id);
    const who = opts.requestedBy ? `${actor} approved ${opts.requestedBy}'s request to swap` : `${actor} swapped`;
    const line = `${who} ${change.before.name} for ${change.after.name} in ${lg.name} ${season.name}. The entry keeps its standings and fixtures.`;
    if (ckey(coach) !== ckey(actor)) send(deps, coach, { type: "league-broadcast", title: `Your team in ${lg.name} was swapped`, body: line, link, from: actor, subject: lg.name, action: true });
    if (ckey(owner) !== ckey(coach) && ckey(owner) !== ckey(actor)) send(deps, owner, { type: "league-broadcast", title: `Your team joined ${lg.name}`, body: line, link, from: actor, subject: lg.name, action: true });
    if (opts.requestedBy && ckey(opts.requestedBy) !== ckey(actor)) send(deps, opts.requestedBy, { type: "league-broadcast", title: `Swap approved: ${change.after.name}`, body: line, link, from: actor, subject: lg.name });
    notifyRecordChange(lg, opts.requestedBy ?? actor, { title: `${lg.name}: ${change.before.name} swapped for ${change.after.name}`, body: line, link }, deps.notify);
    for (const r of declined) send(deps, r.coach, { type: "registration-outcome", title: `Application closed: ${r.listedTeam}`, body: "This team is no longer available for takeover.", link: takeoverLink(lg.id, season.id), subject: lg.name });
    if (declined.length) deps.store.releaseRegistrationAcks(lg.id, declined.filter((r) => !r.member).map((r) => r.coach));
    const saved = deps.store.season(lg.id, season.id) ?? season;
    const after = saved.teams.find((t) => t.id === team.id)!;
    return res(200, { ok: true, revision: saved.revision ?? 0, team: publicTeam(after), entryHistory: entryHistoryLine(after.entryHistory) });
  });
}

/** GET / POST .../teams/:teamId/swap-request[/approve|decline]: the coach sees which of their private teams was asked for
 *  and decides; organisers see only that a request is waiting (and may withdraw it with decline). */
async function swapRequestRoute(method: string, seasonId: string, teamId: string, verb: string | undefined, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  if (!auth) return fail(401, "Sign in first.");
  if (!league) return fail(404, "League not found.");
  const read = method === "GET" || method === "HEAD";
  if (verb === undefined ? !read : method !== "POST") return fail(405, verb === undefined ? "Use GET." : "Use POST.");
  if (verb !== undefined && verb !== "approve" && verb !== "decline") return fail(404, "Not found.");
  let input: Record<string, unknown> = {};
  if (!read) {
    const body = await readJsonObject(deps, BODY_MAX);
    if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
    input = body.value;
  }
  const lg = deps.store.league(league.id) ?? league;
  const season = deps.store.season(lg.id, seasonId);
  const team = season?.teams.find((t) => t.id === teamId);
  if (!season || !team) return fail(404, "Team not found.");
  const coach = seatOf(team);
  const isCoach = Boolean(coach) && ckey(coach) === ckey(auth.coach);
  const manager = managesLeague(lg, auth);
  if (!isCoach && !manager) return fail(403, "Only this team's coach and the league's organisers can see its swap request.");
  const req = team.swapRequest;
  if (read) {
    if (!req) return res(200, { request: null });
    let extra: Record<string, unknown> = {};
    if (isCoach) {
      if (parseLeagueTeamRef(req.ref)) {
        // One of the coach's league teams from another league (transfer permitted): shown to its coach in full.
        const r = parseLeagueTeamRef(req.ref)!;
        const mineNow = leagueTeamsOf(deps.store, auth.coach, { leagueId: lg.id }).find((x) => x.league.id === r.leagueId && x.season.id === r.seasonId && x.team.id === r.teamId);
        const found = mineNow ? transferSource(deps.store, auth.coach, req.ref, { league: lg, season, teamId: team.id }) : undefined;
        extra = mineNow
          ? { ref: req.ref, name: mineNow.team.name, race: mineNow.team.race, source: `${mineNow.league.name} ${mineNow.season.name}`, ok: Boolean(found && !("error" in found)), ...(found && "error" in found ? { reason: found.error } : {}) }
          : { ok: false, reason: "That team is no longer one of yours that may move (check its Permit league transfer)." };
      } else {
        let row: CoachTeamRow | undefined;
        try { row = (deps.coachTeams?.(auth.coach) ?? []).find((r) => r.ref === req.ref); } catch { row = undefined; }
        const c = row ? checkSheet(lg, season, auth.coach, req.ref, deps, deps.now?.() ?? new Date()) : undefined;
        extra = row ? { ref: req.ref, name: c?.name || row.name, race: c?.race || row.race, ok: Boolean(c?.ok), ...(c && !c.ok ? { reason: c.reason } : {}) } : { ok: false, reason: "That team is no longer in your library." };
      }
    }
    return res(200, { request: { id: req.id, by: req.by, at: req.at, ...extra } });
  }
  if (!req) return fail(409, "This swap request is no longer open.");
  if (verb === "approve") {
    if (!isCoach) return fail(403, "Only the team's coach can approve a swap with one of their private teams.");
    // The coach approves the request they reviewed: its id and team must still be the open request's (an organiser may
    // have replaced it meanwhile).
    if (typeof input.requestId !== "string" || typeof input.ref !== "string") return fail(400, "Send the request you reviewed (requestId and ref).");
    if (input.requestId !== req.id || input.ref !== req.ref) return fail(409, "The swap request changed since you opened it. Reload to see the current one.");
    return performSwap(lg, seasonId, teamId, auth.coach, req.ref, auth.coach, deps, { requestId: req.id, requestedBy: req.by });
  }
  // decline (the coach) or withdraw (an organiser): the request goes, nothing else changes.
  const at = (deps.now?.() ?? new Date()).toISOString();
  delete team.swapRequest;
  addHistory(team, { at, by: auth.coach, kind: "swap", changes: [{ what: isCoach ? "Swap request declined by the coach" : "Swap request withdrawn" }] });
  try { deps.store.putSeason(season); } catch { return fail(500, "Could not save right now."); }
  if (isCoach && ckey(req.by) !== ckey(auth.coach)) send(deps, req.by, { type: "league-broadcast", title: `Swap declined: ${team.name}`, body: `${auth.coach} declined the swap you asked for (${lg.name} ${season.name}).`, link: teamLink(lg.id, season.id, team.id), from: auth.coach, subject: lg.name });
  const saved = deps.store.season(lg.id, season.id) ?? season;
  return res(200, { ok: true, revision: saved.revision ?? 0 });
}

/** POST .../teams/:teamId/transfer { permit }: the team's coach permits (or stops) a league transfer (default off). */
async function transferRoute(seasonId: string, teamId: string, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  if (!auth) return fail(401, "Sign in first.");
  if (!league) return fail(404, "League not found.");
  const body = await readJsonObject(deps, BODY_MAX);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  if (typeof body.value.permit !== "boolean") return fail(400, "permit must be true or false.", { field: "permit" });
  const season = deps.store.season(league.id, seasonId);
  const team = season?.teams.find((t) => t.id === teamId);
  if (!season || !team) return fail(404, "Team not found.");
  if (ckey(seatOf(team)) !== ckey(auth.coach)) return fail(403, "Only this team's coach sets its transfer options.");
  const at = (deps.now?.() ?? new Date()).toISOString();
  const was = team.transfer?.permitted === true;
  // A team that may move carries its lineage id (teamOps.ts), so it stays the same team wherever it plays.
  ensureTeamIdentity(team);
  team.transfer = { permitted: body.value.permit, by: auth.coach, at };
  if (was !== body.value.permit) addHistory(team, { at, by: auth.coach, kind: "coach-edit", changes: [{ what: "Permit league transfer", from: was ? "On" : "Off", to: body.value.permit ? "On" : "Off" }] });
  try { deps.store.putSeason(season); } catch { return fail(500, "Could not save right now."); }
  const saved = deps.store.season(league.id, season.id) ?? season;
  return res(200, { ok: true, revision: saved.revision ?? 0, transfer: { permitted: body.value.permit } });
}

async function listing(seasonId: string, teamId: string, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  const gate = managerGate(league, auth);
  if (gate) return gate;
  const body = await readJsonObject(deps, BODY_MAX);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const input = body.value;
  const lg = deps.store.league(league!.id);
  if (!lg || !managesLeague(lg, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can do that.");
  const season = deps.store.season(lg.id, seasonId);
  const team = season?.teams.find((t) => t.id === teamId);
  if (!season || !team) return fail(404, "Team not found.");
  const stale = revisionError(input, season, deps);
  if (stale) return stale;
  if (typeof input.available !== "boolean") return fail(400, "available must be true or false.", { field: "available" });
  let note: string | undefined;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string" || [...input.note.trim()].length > NOTE_MAX) return fail(400, `note must be text of at most ${NOTE_MAX} characters.`, { field: "note" });
    note = input.note.trim();
  }
  if (input.available && season.status === "completed") return fail(409, "This season is finished: list the team in a season that is still running.");
  const at = (deps.now?.() ?? new Date()).toISOString();
  const was = Boolean(team.takeover);
  let declined: TakeoverApplicationRow[] = [];
  if (input.available) setTakeoverListing(team, { by: auth!.coach, at, ...(note !== undefined ? { note } : {}) });
  else declined = closeListing(season, team, auth!.coach, at);
  if (was !== Boolean(input.available)) {
    addHistory(team, { at, by: auth!.coach, kind: "status", changes: [{ what: "Available for takeover", from: was ? "Yes" : "No", to: input.available ? "Yes" : "No" }] });
  }
  try {
    deps.teamLibraryBeforeWrite?.(season);
    deps.store.putSeason(season);
  } catch {
    return fail(500, "Could not save right now. Nothing was changed.");
  }
  for (const r of declined) {
    send(deps, r.coach, { type: "registration-outcome", title: `Application closed: ${r.listedTeam}`, body: "The team is no longer available for takeover.", link: takeoverLink(lg.id, season.id), subject: lg.name });
  }
  if (declined.length) deps.store.releaseRegistrationAcks(lg.id, declined.filter((r) => !r.member).map((r) => r.coach));
  if (was !== Boolean(input.available)) {
    const text = `${auth!.coach} ${input.available ? "listed" : "took down"} ${team.name} ${input.available ? "as available for takeover" : "from the takeover list"} (${season.name}).`;
    notifyRecordChange(lg, auth!.coach, { title: `${lg.name}: ${team.name} ${input.available ? "available for takeover" : "no longer available for takeover"}`, body: text, link: takeoverLink(lg.id, season.id) }, deps.notify);
  }
  const saved = deps.store.season(lg.id, season.id) ?? season;
  return res(200, { ok: true, revision: saved.revision ?? 0, team: publicTeam(saved.teams.find((t) => t.id === team.id)!) });
}

// ---- takeover panel + applications ----------------------------------------------------------------------------------------

function mineView(r: TakeoverApplicationRow) {
  return {
    id: r.id, listingId: r.listingId, teamId: r.teamId, listedTeam: r.listedTeam, state: r.state, mode: r.mode, enteredAt: r.enteredAt,
    ...(r.teamName ? { teamName: r.teamName } : {}), ...(r.race ? { race: r.race } : {}),
    ...(r.decided?.reason && r.state === "declined" ? { reason: r.decided.reason } : {}),
  };
}

function takeoverPanel(seasonId: string, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): LeagueApiResult {
  if (!auth) return fail(401, "Sign in to apply.");
  if (!league) return fail(404, "League not found.");
  const season = deps.store.season(league.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  const member = rosterAccounts(deps.store.competitions(league.id)).has(ckey(auth.coach));
  const rows = season.takeoverApplications ?? [];
  const listings = season.teams.filter((t) => t.takeover).map((t) => ({
    listingId: t.takeover!.id, teamId: t.id, name: t.name, race: t.race, coach: t.coach, ...(t.coachId ? { coachId: t.coachId } : {}),
    teamValue: t.teamValue ?? null, games: teamGamesPlayed(season, t.id), since: t.takeover!.since, ...(t.takeover!.note ? { note: t.takeover!.note } : {}),
    mine: ckey(seatOf(t)) === ckey(auth.coach),
  }));
  const mine = rows.filter((r) => ckey(r.coach) === ckey(auth.coach)).sort((x, y) => y.enteredAt.localeCompare(x.enteredAt)).map(mineView);
  const body: Record<string, unknown> = { member, listings, mine };
  if (managesLeague(league, auth)) {
    const managers = managersOf(league);
    const live = rows.filter((r) => r.state === "pending" || r.state === "waitlisted" || r.state === "accepted");
    let contacts: Array<SharedContact | undefined> = [];
    try { contacts = deps.registrationSharing?.contacts(auth, live.map((r) => ({ ...applicationToEntry(r), competitionId: league.id })), managers) ?? []; } catch { contacts = []; }
    const shared = new Map(live.map((r, i) => [r.id, contacts[i]] as const));
    const open = new Set(listings.map((l) => l.listingId));
    body.applications = rows.filter((r) => open.has(r.listingId) || r.state === "accepted").map((r) => {
      const team = season.teams.find((t) => t.id === r.teamId);
      const base = { id: r.id, listingId: r.listingId, teamId: r.teamId, listedTeam: r.listedTeam, coachId: r.coach, state: r.state, mode: r.mode, enteredAt: r.enteredAt, ...(r.decided ? { decided: { ...r.decided } } : {}) };
      if (r.state !== "pending" && r.state !== "waitlisted") return { ...base, ...(r.approved ? { approved: { ...r.approved } } : {}) };
      const contact = shared.get(r.id);
      return {
        ...base, member: r.member, games: team ? teamGamesPlayed(season, team.id) : 0,
        ...(r.teamName ? { teamName: r.teamName } : {}), ...(r.race ? { race: r.race } : {}),
        ...(r.teamSnapshot ? { players: r.teamSnapshot.players.length, cost: r.teamSnapshot.cost } : {}),
        ...(r.validation ? { validation: { ok: r.validation.ok, problems: [...r.validation.problems] } } : {}),
        ...(contact ? { shared: contact } : {}),
      };
    });
  }
  return res(200, body);
}

function myTeams(seasonId: string, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): LeagueApiResult {
  if (!auth) return fail(401, "Sign in to apply.");
  if (!league) return fail(404, "League not found.");
  const season = deps.store.season(league.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  return res(200, { items: libraryItems(league, season, auth.coach, deps, { leagueTeams: true }) });
}

function serviceFor(deps: LeagueApiDeps, onApproved?: (info: TakeoverApproval) => void, openRecorder?: ReadonlySet<string>) {
  return takeoverService(deps.store, {
    ...(openRecorder ? { openRecorder } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.teamLibraryBeforeWrite ? { beforeWrite: deps.teamLibraryBeforeWrite } : {}),
    ...(onApproved ? { onApproved } : {}),
    notify: (coach, input) => { try { deps.notify?.(coach, input); } catch { /* fire-and-forget */ } },
  });
}

async function apply(seasonId: string, listingId: string, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  if (!auth) return fail(401, "Sign in to apply.");
  if (!league) return fail(404, "League not found.");
  if (!LISTING_ID.test(listingId)) return fail(404, "That team isn't available for takeover.");
  const body = await readJsonObject(deps, BODY_MAX);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const input = body.value;
  const extra = Object.keys(input).filter((k) => !["mode", "teamRef", "share", "acknowledged"].includes(k));
  if (extra.length) return fail(400, `Unknown field: ${extra[0]}.`);
  const lg = deps.store.league(league.id);
  const season = lg ? deps.store.season(lg.id, seasonId) : undefined;
  if (!lg || !season) return fail(404, "Season not found.");
  const team = listedTeam(season, listingId);
  if (!team) return fail(404, "That team isn't available for takeover.");
  if (ckey(seatOf(team)) === ckey(auth.coach)) return fail(400, "This is your team: you can't apply to take it over.");
  if (input.mode !== "team" && input.mode !== "takeover") return fail(400, 'mode must be "team" (apply with your team) or "takeover" (take this team over).', { field: "mode" });
  const member = rosterAccounts(deps.store.competitions(lg.id)).has(ckey(auth.coach));
  let share: ShareField[] = [];
  if (!member) {
    if (input.acknowledged !== true) return fail(400, "Tick the box to confirm you agree to share your data with this league's organisers.", { field: "acknowledged" });
    try { share = parseShareFields(input.share); } catch (e) { return fail(400, (e as ContactValidationError).message, { field: "share" }); }
  }
  const now = deps.now?.() ?? new Date();
  const data: TakeoverEntryData = { teamId: team.id, listedTeam: team.name, mode: input.mode, member };
  if (input.mode === "team") {
    const ref = typeof input.teamRef === "string" ? input.teamRef.trim() : "";
    if (!ref) return fail(400, "Pick one of your teams.", { field: "teamRef" });
    if (parseLeagueTeamRef(ref)) {
      // A league team of yours (transfer permitted when it plays elsewhere) moves with its record.
      const found = transferSource(deps.store, auth.coach, ref, { league: lg, season });
      if ("error" in found) return fail(found.status, found.error, { code: "invalid-team", field: "teamRef" });
      Object.assign(data, {
        teamRef: ref, teamName: found.source.team.name, race: canonicalRace(found.source.team.race), teamSnapshot: snapshotOfLeagueTeam(found.source.team),
        validation: { ok: true, problems: [], checkedAt: now.toISOString() },
      });
    } else {
      if (!TEAM_REF.test(ref)) return fail(400, "teamRef must name a saved team (save:<id>) or one of your league teams.", { field: "teamRef" });
      const checked = checkSheet(lg, season, auth.coach, ref, deps, now);
      if (!checked.ok) return fail(400, checked.reason, { code: "invalid-team", field: "teamRef" });
      Object.assign(data, {
        teamRef: ref, teamName: checked.name, race: checked.race, teamSnapshot: checked.snapshot,
        validation: { ok: true, problems: [], checkedAt: now.toISOString() }, ...(checked.libraryTeamId ? { libraryTeamId: checked.libraryTeamId } : {}),
      });
    }
  }
  const cid = takeoverCompetitionId(lg.id, season.id, listingId);
  const result = await serviceFor(deps).submit(cid, auth.coach, actorOf(auth), { data: data as unknown as Record<string, unknown> });
  if (!result.changed) return fail(409, "You already applied for this team.", { code: "already" });
  // The acknowledgement and the grant are written after the application, so the grant counts for it (as at join).
  let sharingSaved = true;
  if (!member && deps.registrationSharing) {
    try { deps.registrationSharing.acknowledge(auth.coach, lg.id, share, deps.now?.() ?? new Date()); } catch { sharingSaved = false; }
  }
  const saved = deps.store.season(lg.id, season.id) ?? season;
  const row = (saved.takeoverApplications ?? []).find((r) => r.id === result.entry.id);
  return res(201, { application: row ? mineView(row) : { id: result.entry.id, state: result.entry.state }, ...(sharingSaved ? {} : { sharingSaved: false }) });
}

async function decide(
  seasonId: string, listingId: string, appId: string, verb: "approve" | "decline" | "withdraw", league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult> {
  if (!auth) return fail(401, "Sign in first.");
  if (!league) return fail(404, "League not found.");
  if (!LISTING_ID.test(listingId) || !APPLICATION_ID.test(appId)) return fail(404, "Application not found.");
  const body = await readJsonObject(deps, BODY_MAX);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const input = body.value;
  let reason: string | undefined;
  if (input.reason !== undefined && input.reason !== null) {
    if (typeof input.reason !== "string" || [...input.reason.trim()].length > REASON_MAX) return fail(400, `reason must be text of at most ${REASON_MAX} characters.`, { field: "reason" });
    reason = input.reason.trim() || undefined;
  }
  const lg = deps.store.league(league.id);
  const season = lg ? deps.store.season(lg.id, seasonId) : undefined;
  if (!lg || !season) return fail(404, "Season not found.");
  const row = (season.takeoverApplications ?? []).find((r) => r.id === appId && r.listingId === listingId);
  if (!row) return fail(404, "Application not found.");
  const manager = managesLeague(lg, auth);
  if (verb !== "withdraw" && !manager) return fail(403, "Only this league's organisers and site admins can decide applications.");
  if (verb === "withdraw" && !manager && ckey(row.coach) !== ckey(auth.coach)) return fail(404, "Application not found.");
  const cid = takeoverCompetitionId(lg.id, season.id, listingId);
  let approval: TakeoverApproval | undefined;
  const actor = actorOf(auth);
  let result;
  if (verb === "approve") {
    // An approval changes the team behind the entry: no recorder match may be open on its fixtures, and it runs under the
    // same fork locks as a swap (a generate / launch in flight finishes first; the adapter re-checks every guard).
    const open = await openRecorderFixtures(deps, lg.id, season.id);
    if (!open) return fail(503, "The tabletop recorder can't be read right now (or a match file is unreadable), so the approval can't be checked. Try again or ask a site admin.");
    const block = entryChangeBlock(season, row.teamId, open);
    if (block) return fail(409, block);
    const service = serviceFor(deps, (info) => { approval = info; }, open);
    result = await entryLocks(lg.id, season, row.teamId, () => service.accept(cid, appId, actor, reason));
  } else {
    const service = serviceFor(deps);
    result = verb === "decline" ? await service.decline(cid, appId, actor, reason) : await service.withdraw(cid, appId, actor, reason);
  }
  const released: string[] = [];
  if (result.changed && verb !== "approve" && !row.member) released.push(row.coach);
  if (approval) {
    const { change } = approval;
    const link = teamLink(lg.id, season.id, change.after.id);
    const old = seatOf(change.before);
    const what = approval.row.mode === "team"
      ? `${change.after.coach}'s ${change.after.name} took over the entry of ${change.before.name} in ${lg.name} ${season.name}.`
      : `${change.after.coach} took over ${change.after.name} in ${lg.name} ${season.name}.`;
    if (old && ckey(old) !== ckey(auth.coach)) {
      send(deps, old, { type: "league-broadcast", title: `${change.before.name} has a new coach`, body: `${what} Your played games stay on your record.`, link, from: auth.coach, subject: lg.name });
    }
    notifyRecordChange(lg, auth.coach, { title: `${lg.name}: ${change.before.name} taken over`, body: `${what} Approved by ${auth.coach}.`, link }, deps.notify);
    for (const r of approval.declined) {
      send(deps, r.coach, { type: "registration-outcome", title: `Application closed: ${r.listedTeam}`, body: "Another application was approved.", link: takeoverLink(lg.id, season.id), subject: lg.name });
      if (!r.member) released.push(r.coach);
    }
  }
  if (released.length) deps.store.releaseRegistrationAcks(lg.id, released);
  const saved = deps.store.season(lg.id, season.id) ?? season;
  return res(200, {
    application: { id: result.entry.id, state: result.entry.state },
    changed: result.changed,
    revision: saved.revision ?? 0,
    ...(approval ? { teamId: approval.change.after.id, games: approval.change.games, mode: approval.row.mode, editLink: `${teamLink(lg.id, season.id, approval.change.after.id)}&edit=1` } : {}),
  });
}
