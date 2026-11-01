/**
 * League season Participants (League page, Participants tab; organisers and site admins only; landing-nav spec §2.2).
 * One row per season team with the five participant flags the tournament entrants carry: paid, roster verified, frozen,
 * checked in, active (standby when off). Owner 10-29: "allow organizers to mark all as paid, all as validated."
 *
 *   GET   /api/leagues/:id/seasons/:seasonId/participants          rows + the season revision
 *   PATCH /api/leagues/:id/seasons/:seasonId/participants/:teamId  { revision, paid?, rosterVerified?, frozen?, checkedIn?, active? }
 *   POST  /api/leagues/:id/seasons/:seasonId/participants          { revision, teamIds?: string[] (default every team), set: { <flag>: boolean, ... } }
 *
 * Anonymous 401, unknown league 404, neither organiser nor admin 403. Writes name the season revision as last read
 * (body.revision or If-Match): 428 missing, 409 stale. They answer the rows and the new revision. CSRF and the
 * onboarding 428 gate run in front of every /api write (server.ts).
 *
 * Storage: the flags live on the team's season participant row (LeagueParticipant: `active` was already there, the
 * TourPlay export's value; paid / rosterVerified / frozen / checkedIn are added, absent = false), matched to the team
 * as Assign coach account matches it (team name, then coach). A team without a participant row gets one on its first
 * change (as a redraft does). `flagsUpdated` records who changed them last (anonymised on account deletion).
 *
 * Privacy: a row carries the coach's contact only as the coach shared it with this league (sharedContactFor: preferred
 * name, email, phones), never otherwise and never Discord ids. The public season read drops the four new flags and
 * flagsUpdated (participantsForPublic).
 *
 * Notifications: the coach account on the team (coachId) hears what changed, once per coach per request (a bulk change
 * over several of one coach's teams is one notification). The acting organiser is not told about their own team.
 */
import type { NotificationInput } from "../notifications.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { readJsonObject, requestRevision } from "./http.js";
import { isLeagueOrganiser } from "./store.js";
import type { LeagueParticipant, LeagueRecord, LeagueTeam, SeasonRecord } from "./types.js";

export const PARTICIPANT_FLAGS = ["paid", "rosterVerified", "frozen", "checkedIn", "active"] as const;
export type ParticipantFlag = (typeof PARTICIPANT_FLAGS)[number];
export type ParticipantFlags = Record<ParticipantFlag, boolean>;

/** What an organiser sees of a coach's contact (sharedContactFor's grant fields only). */
export interface ParticipantContact {
  preferredName?: string;
  email?: string;
  phones?: Array<{ number: string; country?: string; label?: string }>;
}

export interface ParticipantRow {
  teamId: string;
  team: string;
  race: string;
  coach: string;
  coachId?: string;
  flags: ParticipantFlags;
  updated?: { by: string; at: string };
  contact?: ParticipantContact;
}

const PARTICIPANTS_MAX_BYTES = 64 * 1024;
const NO_STORE = { "cache-control": "private, no-store" };
const res = (status: number, body: unknown): LeagueApiResult => ({ status, body, headers: { ...NO_STORE } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => res(status, { error, ...extra });
const key = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

function gate(league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined): LeagueApiResult | undefined {
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!league) return fail(404, "League not found.");
  if (!auth.admin && !isLeagueOrganiser(league, auth.coach)) return fail(403, "This league is not one of yours: only its organisers and site admins can see its participants.");
  return undefined;
}

/** The team's participant row: same team name and coach, else the only row with the team name. */
export function participantOf(season: Pick<SeasonRecord, "participants">, team: Pick<LeagueTeam, "name" | "coach">): LeagueParticipant | undefined {
  const named = season.participants.filter((p) => key(p.team) === key(team.name));
  return named.find((p) => key(p.coach) === key(team.coach)) ?? (named.length === 1 ? named[0] : undefined);
}

export function flagsOf(p: LeagueParticipant | undefined): ParticipantFlags {
  return {
    paid: p?.paid === true, rosterVerified: p?.rosterVerified === true, frozen: p?.frozen === true, checkedIn: p?.checkedIn === true,
    // A team without a row is active until an organiser says otherwise; a row keeps the export's value.
    active: p ? p.active !== false : true,
  };
}

function cleanContact(c: unknown): ParticipantContact | undefined {
  if (!c || typeof c !== "object") return undefined;
  const o = c as Record<string, unknown>;
  const out: ParticipantContact = {};
  if (typeof o.preferredName === "string" && o.preferredName) out.preferredName = o.preferredName;
  if (typeof o.email === "string" && o.email) out.email = o.email;
  if (Array.isArray(o.phones)) {
    const phones = o.phones.filter((p): p is { number: string; country?: unknown; label?: unknown } => Boolean(p) && typeof (p as { number?: unknown }).number === "string")
      .map((p) => ({ number: p.number, ...(typeof p.country === "string" ? { country: p.country } : {}), ...(typeof p.label === "string" ? { label: p.label } : {}) }));
    if (phones.length) out.phones = phones;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The table rows, in team-name order, with each coach's shared contact (best effort). */
export function participantRows(league: LeagueRecord, season: SeasonRecord, viewer: LeagueApiIdentity, deps: Pick<LeagueApiDeps, "memberContact">): ParticipantRow[] {
  const contacts = new Map<string, ParticipantContact | undefined>();
  const contactOf = (coachId: string | undefined): ParticipantContact | undefined => {
    if (!coachId || !deps.memberContact) return undefined;
    const k = key(coachId);
    if (!contacts.has(k)) {
      let c: ParticipantContact | undefined;
      try { c = cleanContact(deps.memberContact(viewer, coachId, league.id)); } catch { c = undefined; }
      contacts.set(k, c);
    }
    return contacts.get(k);
  };
  return [...season.teams].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((t) => {
    const p = participantOf(season, t);
    // The team's account wins (an organiser-cleared assignment means none); else the participant row's.
    const coachId = t.coachAssigned?.cleared ? undefined : t.coachId ?? p?.coachId;
    const contact = contactOf(coachId);
    return {
      teamId: t.id, team: t.name, race: t.race, coach: t.coach,
      ...(coachId ? { coachId } : {}),
      flags: flagsOf(p),
      ...(p?.flagsUpdated ? { updated: { ...p.flagsUpdated } } : {}),
      ...(contact ? { contact } : {}),
    };
  });
}

/** The public season read: the organiser-only flags and who set them never leave the server. */
export function participantsForPublic(rows: LeagueParticipant[]): LeagueParticipant[] {
  return rows.map(({ paid: _p, rosterVerified: _r, frozen: _f, checkedIn: _c, flagsUpdated: _u, ...rest }) => rest);
}

/** Re-import: the organiser's flags on `prior` go back on the matching rows of `next` (team name + coach). */
export function carryParticipantFlags(prior: SeasonRecord | undefined, next: SeasonRecord): number {
  if (!prior) return 0;
  let carried = 0;
  for (const old of prior.participants) {
    if (!old.flagsUpdated) continue;
    const row = next.participants.find((p) => key(p.team) === key(old.team) && key(p.coach) === key(old.coach));
    if (!row) continue;
    for (const f of ["paid", "rosterVerified", "frozen", "checkedIn"] as const) { if (old[f]) row[f] = true; else delete row[f]; }
    row.active = old.active;
    row.flagsUpdated = { ...old.flagsUpdated };
    carried++;
  }
  return carried;
}

/** { flag: boolean } from the body (only the five flags; at least one). Undefined + an error when it is not that. */
function parseFlags(raw: unknown): { ok: true; set: Partial<ParticipantFlags> } | { ok: false; error: string; field?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send the flags to change.", field: "set" };
  const set: Partial<ParticipantFlags> = {};
  for (const f of PARTICIPANT_FLAGS) {
    const v = (raw as Record<string, unknown>)[f];
    if (v === undefined) continue;
    if (typeof v !== "boolean") return { ok: false, error: `${f} must be true or false.`, field: f };
    set[f] = v;
  }
  if (!Object.keys(set).length) return { ok: false, error: "Send at least one of paid, rosterVerified, frozen, checkedIn, active.", field: "set" };
  return { ok: true, set };
}

const FLAG_WORDS: Record<ParticipantFlag, [on: string, off: string]> = {
  paid: ["Marked as paid", "Marked as not paid"],
  rosterVerified: ["Roster verified", "Roster marked invalid"],
  frozen: ["Roster frozen", "Roster unfrozen"],
  checkedIn: ["Checked in", "Check-in cleared"],
  active: ["Moved to active", "Moved to standby"],
};

/**
 * Applies `set` to each team (creating a participant row when missing). Returns per coach account the lines of what
 * changed (team-prefixed when the coach has several changed teams). Mutates `season`.
 */
function applyFlags(season: SeasonRecord, teamIds: string[], set: Partial<ParticipantFlags>, by: string, at: string): { changed: number; byCoach: Map<string, { coach: string; teams: Array<{ team: string; lines: string[] }> }> } {
  const byCoach = new Map<string, { coach: string; teams: Array<{ team: string; lines: string[] }> }>();
  let changed = 0;
  for (const id of teamIds) {
    const team = season.teams.find((t) => t.id === id)!;
    let row = participantOf(season, team);
    const before = flagsOf(row);
    const lines = PARTICIPANT_FLAGS.filter((f) => set[f] !== undefined && set[f] !== before[f]).map((f) => FLAG_WORDS[f][set[f] ? 0 : 1]);
    if (!lines.length) continue;
    if (!row) {
      row = { coach: team.coach, ...(team.coachId && !team.coachAssigned?.cleared ? { coachId: team.coachId } : {}), country: "", race: team.race, team: team.name, active: true };
      season.participants.push(row);
    }
    for (const f of PARTICIPANT_FLAGS) {
      const v = set[f];
      if (v === undefined) continue;
      if (f === "active") row.active = v;
      else if (v) row[f] = true;
      else delete row[f];
    }
    row.flagsUpdated = { by, at };
    changed++;
    const coachId = team.coachAssigned?.cleared ? undefined : team.coachId ?? row.coachId;
    if (!coachId) continue;
    const k = key(coachId);
    const entry = byCoach.get(k) ?? { coach: coachId.trim(), teams: [] };
    entry.teams.push({ team: team.name, lines });
    byCoach.set(k, entry);
  }
  return { changed, byCoach };
}

function notifyCoaches(deps: LeagueApiDeps, league: LeagueRecord, season: SeasonRecord, actor: string, byCoach: ReturnType<typeof applyFlags>["byCoach"]): void {
  if (!deps.notify) return;
  const link = `/app/leagues/${encodeURIComponent(league.id)}?season=${encodeURIComponent(season.id)}`;
  for (const [k, entry] of byCoach) {
    if (k === key(actor)) continue;
    const body = entry.teams.length === 1
      ? `${entry.teams[0]!.team}: ${entry.teams[0]!.lines.join(". ")}.`
      : entry.teams.map((t) => `${t.team}: ${t.lines.join(". ")}.`).join(" ");
    const input: NotificationInput = { type: "entrant-flag", title: `${league.name}, ${season.name}: your entry was updated`, body, link, from: actor };
    try { deps.notify(entry.coach, input); } catch { /* fire-and-forget */ }
  }
}

/** The route dispatcher (api.ts calls it before the settings routes); undefined = not a participants route. */
export async function leagueParticipantRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, seasonId, what, teamId, ...more] = rest;
  if (first !== "seasons" || !seasonId || what !== "participants" || more.length) return undefined;
  const read = method === "GET" || method === "HEAD";
  if (teamId === undefined ? !read && method !== "POST" : method !== "PATCH") return fail(405, teamId === undefined ? "Use GET or POST." : "Use PATCH.");
  const early = gate(league, auth);
  if (early) return early;
  let input: Record<string, unknown> = {};
  if (!read) {
    const body = await readJsonObject(deps, PARTICIPANTS_MAX_BYTES);
    if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
    input = body.value;
  }
  // Judged against the league as it is now (after the body arrived); synchronous from here to the write.
  const lg = deps.store.league(league!.id);
  const refused = gate(lg, auth);
  if (refused || !lg) return refused ?? fail(404, "League not found.");
  const season = deps.store.season(lg.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  const who = auth!;
  if (read) return res(200, { participants: participantRows(lg, season, who, deps), revision: season.revision ?? 0 });

  if (teamId !== undefined && !season.teams.some((t) => t.id === teamId)) return fail(404, "Team not found in this season.");
  const current = season.revision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return fail(428, "Send the season revision you loaded (revision or If-Match).", { revision: current });
  if (asked === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  if (asked !== current) return fail(409, "This season changed since you opened it. Reload to see the latest.", { revision: current });

  let ids: string[];
  let parsed: ReturnType<typeof parseFlags>;
  if (teamId !== undefined) {
    ids = [teamId];
    parsed = parseFlags(input);
  } else {
    if (input.teamIds === undefined) ids = season.teams.map((t) => t.id);
    else if (Array.isArray(input.teamIds) && input.teamIds.length <= 500 && input.teamIds.every((t) => typeof t === "string")) {
      ids = [...new Set(input.teamIds as string[])];
      const unknown = ids.find((id) => !season.teams.some((t) => t.id === id));
      if (unknown !== undefined) return fail(400, "Pick teams of this season.", { field: "teamIds" });
      if (!ids.length) return fail(400, "Pick at least one team.", { field: "teamIds" });
    } else return fail(400, "teamIds must be a list of team ids.", { field: "teamIds" });
    parsed = parseFlags(input.set);
  }
  if (!parsed.ok) return fail(400, parsed.error, parsed.field ? { field: parsed.field } : {});

  const at = (deps.now?.() ?? new Date()).toISOString();
  const { changed, byCoach } = applyFlags(season, ids, parsed.set, who.coach, at);
  if (changed) deps.store.putSeason(season);
  const saved = changed ? deps.store.season(lg.id, season.id) ?? season : season;
  notifyCoaches(deps, lg, saved, who.coach, byCoach);
  return res(200, { ok: true, changed, participants: participantRows(lg, saved, who, deps), revision: saved.revision ?? 0 });
}
