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
import { ContactValidationError, parseShareFields, type ShareField } from "../auth/contactSchema.js";
import type { SharedContact } from "../auth/contactFor.js";
import { houseRulesOf } from "../competition/houseRules.js";
import { leaguePackageName } from "../leagueBuilderMarker.js";
import { RegistrationError, type RegistrationActor } from "../registration/index.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
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
  applyEntrySwap, entryChangeBlock, entryHistoryLine, leagueTeamProblem, leagueTeamRef, leagueTeamsOf, parseLeagueTeamRef, setTakeoverListing, teamFromLeagueTeam,
  type CoachTeamRow, type LibraryItem,
} from "./teamLibrary.js";
import { addHistory, publicTeam, settleServedMng, teamGamesPlayed } from "./teamOps.js";
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
const TEAM_REF = /^(?:save|library):[A-Za-z0-9_.:-]{1,110}$/;
const ckey = (c: string | undefined): string => (c ?? "").normalize("NFC").trim().toLowerCase();
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
  if (!rosterAccounts(deps.store.seasons(league.id)).has(ckey(coach))) return false;
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
export function libraryItems(league: LeagueRecord, season: SeasonRecord, coach: string, deps: LeagueApiDeps, opts: { teamId?: string; leagueTeams: boolean }): LibraryItem[] {
  const now = deps.now?.() ?? new Date();
  let rows: CoachTeamRow[] = [];
  try { rows = (deps.coachTeams?.(coach) ?? []).slice(0, LIBRARY_MAX); } catch { rows = []; }
  const own: LibraryItem[] = rows.filter((r) => TEAM_REF.test(r.ref)).map((r) => {
    const c = checkSheet(league, season, coach, r.ref, deps, now);
    return {
      ref: r.ref, kind: r.kind, name: c.name || r.name, race: c.race || r.race, tv: r.tv, ok: c.ok,
      ...(c.ok ? {} : { reason: c.reason }),
    };
  });
  const lg: LibraryItem[] = !opts.leagueTeams ? [] : leagueTeamsOf(deps.store, coach, { leagueId: league.id }).map((x) => {
    const problem = leagueTeamProblem(x, { league, season, ...(opts.teamId ? { teamId: opts.teamId } : {}) });
    return {
      ref: leagueTeamRef(x.league.id, x.season.id, x.team.id), kind: "league" as const, name: x.team.name, race: x.team.race,
      tv: x.team.teamValue ?? null, source: `${x.league.name} ${x.season.name}`, ok: !problem, ...(problem ? { reason: problem } : {}),
    };
  });
  const order = { save: 0, library: 1, league: 2 } as const;
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
  return res(200, { coach: coach.trim(), items: libraryItems(league!, season, coach.trim(), deps, { leagueTeams: true }) });
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
  return res(200, { ...base, coach, items: libraryItems(league!, season, coach, deps, { teamId: team.id, leagueTeams: true }) });
}

function revisionError(input: Record<string, unknown>, season: SeasonRecord, deps: LeagueApiDeps): LeagueApiResult | undefined {
  const current = season.revision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return fail(428, "Send the season revision you loaded (revision or If-Match).", { revision: current });
  if (asked === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  if (asked !== current) return fail(409, "This season changed since you opened it. Reload to see the latest.", { revision: current });
  return undefined;
}

async function swap(seasonId: string, teamId: string, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  const gate = managerGate(league, auth);
  if (gate) return gate;
  const body = await readJsonObject(deps, BODY_MAX);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const input = body.value;
  // Judged against the league and season as they are now (after the body arrived); synchronous from here to the write.
  const lg = deps.store.league(league!.id);
  if (!lg || !managesLeague(lg, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can do that.");
  const season = deps.store.season(lg.id, seasonId);
  const team = season?.teams.find((t) => t.id === teamId);
  if (!season || !team) return fail(404, "Team not found.");
  const stale = revisionError(input, season, deps);
  if (stale) return stale;
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (!ref) return fail(400, "Pick a team from the coach's library.", { field: "ref" });
  const block = entryChangeBlock(season, team.id);
  if (block) return fail(409, block);
  const coach = seatOf(team);
  if (!coach) return fail(409, "This team has no coach account: assign one first.");
  if (!libraryVisible(lg, coach, auth!, deps)) return fail(403, "This coach hasn't shared their teams with this league yet.");
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const seasons = deps.store.seasons(lg.id);
  let incoming: LeagueTeam;
  const leagueRef = parseLeagueTeamRef(ref);
  if (leagueRef) {
    const source = leagueTeamsOf(deps.store, coach, { leagueId: lg.id })
      .find((x) => x.league.id === leagueRef.leagueId && x.season.id === leagueRef.seasonId && x.team.id === leagueRef.teamId);
    if (!source) return fail(404, "That team isn't in this coach's library.", { field: "ref" });
    const problem = leagueTeamProblem(source, { league: lg, season, teamId: team.id });
    if (problem) return fail(400, problem, { code: "invalid-team", field: "ref" });
    const used = new Set(seasons.flatMap((s) => s.teams.flatMap((t) => [...t.players, ...(t.formerPlayers ?? [])].map((p) => p.playerId))));
    incoming = teamFromLeagueTeam(source.team, season, { id: team.id, usedIds: used });
    incoming.coachId = coach;
  } else if (TEAM_REF.test(ref)) {
    if (!(deps.coachTeams?.(coach) ?? []).some((r) => r.ref === ref)) return fail(404, "That team isn't in this coach's library.", { field: "ref" });
    const checked = checkSheet(lg, season, coach, ref, deps, now);
    if (!checked.ok) return fail(400, checked.reason, { code: "invalid-team", field: "ref" });
    incoming = teamFromSnapshot(lg, season, checked.snapshot, {
      id: freshTeamId(season), coach, teamName: checked.name, race: checked.race, by: auth!.coach, at,
      teamUid: lineageFor(seasons, checked.libraryTeamId), entryId: team.entryId ?? "", ...(checked.libraryTeamId ? { libraryTeamId: checked.libraryTeamId } : {}),
    });
  } else return fail(400, "ref must name a save, a library team or a league team of the coach.", { field: "ref" });
  // The re-read season is written in one go: the entry, its fixtures, its participant row, the log.
  settleServedMng(season);
  const change = applyEntrySwap(season, team.id, incoming, auth!.coach, at, "swap");
  try {
    deps.teamLibraryBeforeWrite?.(season);
    deps.store.putSeason(season);
  } catch {
    return fail(500, "Could not save the swap right now. Nothing was changed.");
  }
  const link = teamLink(lg.id, season.id, team.id);
  const line = `${auth!.coach} swapped ${change.before.name} for ${change.after.name} in ${lg.name} ${season.name}. The entry keeps its standings and fixtures.`;
  if (ckey(coach) !== ckey(auth!.coach)) send(deps, coach, { type: "league-broadcast", title: `Your team in ${lg.name} was swapped`, body: line, link, from: auth!.coach, subject: lg.name, action: true });
  notifyRecordChange(lg, auth!.coach, { title: `${lg.name}: ${change.before.name} swapped for ${change.after.name}`, body: line, link }, deps.notify);
  const saved = deps.store.season(lg.id, season.id) ?? season;
  const after = saved.teams.find((t) => t.id === team.id)!;
  return res(200, { ok: true, revision: saved.revision ?? 0, team: publicTeam(after), entryHistory: entryHistoryLine(after.entryHistory) });
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
  const member = rosterAccounts(deps.store.seasons(league.id)).has(ckey(auth.coach));
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
  return res(200, { items: libraryItems(league, season, auth.coach, deps, { leagueTeams: false }) });
}

function serviceFor(deps: LeagueApiDeps, onApproved?: (info: TakeoverApproval) => void) {
  return takeoverService(deps.store, {
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
  const member = rosterAccounts(deps.store.seasons(lg.id)).has(ckey(auth.coach));
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
    if (!TEAM_REF.test(ref)) return fail(400, "teamRef must name a Roster Builder save (save:<id>) or a library team (library:<teamId>).", { field: "teamRef" });
    const checked = checkSheet(lg, season, auth.coach, ref, deps, now);
    if (!checked.ok) return fail(400, checked.reason, { code: "invalid-team", field: "teamRef" });
    Object.assign(data, {
      teamRef: ref, teamName: checked.name, race: checked.race, teamSnapshot: checked.snapshot,
      validation: { ok: true, problems: [], checkedAt: now.toISOString() }, ...(checked.libraryTeamId ? { libraryTeamId: checked.libraryTeamId } : {}),
    });
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
  const service = serviceFor(deps, (info) => { approval = info; });
  const actor = actorOf(auth);
  const result = verb === "approve" ? await service.accept(cid, appId, actor, reason)
    : verb === "decline" ? await service.decline(cid, appId, actor, reason)
      : await service.withdraw(cid, appId, actor, reason);
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
