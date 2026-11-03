/**
 * League registration routes (registration spec 2026-11-02 §5 (c), lane L6) over the league adapter (registration.ts) and
 * the shared registration core. Every write needs a session (CSRF X-CW-Auth and the 428 onboarding gate run in front of
 * every /api write in server.ts); GETs never change state.
 *
 *   GET  /api/leagues/:id/seasons/:seasonId/join                      public facts (open, places, approval, regions, fee)
 *                                                                     + the signed-in coach's own entry (`mine`)
 *   POST /api/leagues/:id/seasons/:seasonId/registrations             { teamRef, region?, share, acknowledged } join
 *   GET  /api/leagues/:id/seasons/:seasonId/registrations             organisers + admins: the Registrations tab
 *   POST /api/leagues/:id/seasons/:seasonId/registrations/:rid/(accept|waitlist|decline|promote|remove)  { reason? }
 *   POST /api/leagues/:id/seasons/:seasonId/registrations/:rid/withdraw   the coach (pending / waitlisted entries)
 *   POST /api/leagues/:id/seasons/:seasonId/registrations/:rid/paid-claim { paid }  the coach's "I've paid"
 *
 * Join: the team is a Roster Builder save built in league mode for this season (default), or, only when the organisers
 * allow existing teams, any other save or library team; either way it is composed and checked against the season's
 * rules (leagueTeamSheet) and refused when it fails. Region from the league's list when it has one. The league notice
 * acknowledgement is required and is written, with the league:<id> grant, after the entry (no NAF: law 23).
 *
 * Privacy: pending, waitlisted and declined entries never reach a public read or count; a coach sees only their own
 * entry; organisers of league A get 403 on league B, and an entry id of another season answers 404. What an organiser
 * sees of a registering coach is registrationContactFor (the grant given for the current entry; nothing after decline or
 * withdrawal). Notifications go through api.ts's draft-aware notifier (a draft league notifies its organisers only).
 */
import type { Roster } from "@bb/validator";
import { houseRulesOf, type HouseRules } from "../competition/houseRules.js";
import { ContactValidationError, leagueShareText, parseShareFields, type ShareField } from "../auth/contactSchema.js";
import type { SharedContact } from "../auth/contactFor.js";
import { leaguePackageName } from "../leagueBuilderMarker.js";
import { registrationCounts, registrationLocks, RegistrationError, waitlistOrder, waitlistPosition, type EntryState, type RegistrationActor } from "../registration/index.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { readJsonObject } from "./http.js";
import { canonicalRace, rosterAllowed } from "./leagueBuilder.js";
import { managesLeague, seasonStage } from "./lifecycle.js";
import { participantOf } from "./participants.js";
import {
  acceptedRaceCounts, competitionIdOf, leagueRegistrationLink, leagueRegistrationService, PAID_CLAIM_NOTICE_MS, refCodeOf, rowToEntry,
  seasonEntries, seasonRegistrationSettings, snapshotFromRoster, type LeagueEntryData, type LeagueRegistrationRow,
} from "./registration.js";
import { seasonRegistrationOf, seasonSnapshot, seasonWindowStatus, seasonWindow } from "./seasonRegistration.js";
import { leagueOwner } from "./store.js";
import type { LeagueRecord, SeasonRecord } from "./types.js";
import { paymentLinksView } from "../payments/links.js";

/** The composed, checked sheet of a coach's team (server.ts: the coach's own saves and library only). */
export interface LeagueTeamSheet {
  teamName: string;
  race?: string;
  /** The library team behind the sheet, when the coach owns it. */
  libraryTeamId?: string;
  /** The ruleset marker the save was built under (league mode for this season = "league:<id>:<seasonId>"). */
  savePackage?: string;
  validation: { ok: boolean; problems: string[] };
  /** The composed roster (validator model); absent when the sheet can't be composed on this host. */
  roster?: Roster;
}

export interface LeagueRegistrationApiDeps {
  /** Composes and checks the coach's `save:<id>` / `library:<teamId>` against the season's package marker. */
  leagueTeamSheet?: (coach: string, teamRef: string, packageName: string, houseRules: HouseRules, now: Date) => LeagueTeamSheet | { error: string; status?: number };
  registrationSharing?: {
    /** Stores the league notice acknowledgement and the league:<id> grant together (src/auth/leagueSharing.ts). */
    acknowledge(coach: string, leagueId: string, fields: ShareField[], at: Date): void;
    /** What a manager sees of each live entry's coach (src/registration registrationContactFor, scope league:<id>). */
    contacts(viewer: { coach: string; admin?: boolean }, entries: ReadonlyArray<{ coach: string; state: EntryState; enteredAt: string; competitionId: string }>, managers: readonly string[]): Array<SharedContact | undefined>;
  };
  /** Fault injection (tests): runs inside the registration write just before the season file is written. */
  registrationBeforeWrite?: (season: SeasonRecord) => void;
}

const BODY_MAX = 16 * 1024;
const REASON_MAX = 500;
const NO_STORE = { "cache-control": "private, no-store" };
const LIVE = new Set<EntryState>(["pending", "waitlisted", "accepted"]);
const TEAM_REF = /^(?:save|library):[A-Za-z0-9_.:-]{1,110}$/;
const ckey = (c: string | undefined) => (c ?? "").trim().toLowerCase();
const res = (status: number, body: unknown, extra: Partial<LeagueApiResult> = {}): LeagueApiResult => ({ status, body, headers: { ...NO_STORE }, ...extra });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => res(status, { error, ...extra });

const actorOf = (auth: LeagueApiIdentity): RegistrationActor => ({ coach: auth.coach, ...(auth.admin ? { admin: true } : {}), ...(auth.test ? { test: true } : {}) });
const managersOf = (league: LeagueRecord): string[] => { const o = leagueOwner(league); return [...new Set([...(o ? [o] : []), ...league.organisers])]; };

function serviceFor(deps: LeagueApiDeps, opts: { quiet?: boolean } = {}) {
  return leagueRegistrationService(deps.store, {
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.registrationBeforeWrite ? { beforeWrite: deps.registrationBeforeWrite } : {}),
    notify: (coach, input) => { if (!opts.quiet) { try { deps.notify?.(coach, input); } catch { /* fire-and-forget */ } } },
  });
}

/** Every manager except the actor hears an organiser decision the core does not announce (a removal, a reminder). */
function tellManagers(deps: LeagueApiDeps, league: LeagueRecord, actor: string | undefined, input: Parameters<NonNullable<LeagueApiDeps["notify"]>>[1]): void {
  for (const m of managersOf(league)) {
    if (actor && ckey(m) === ckey(actor)) continue;
    try { deps.notify?.(m, input); } catch { /* fire-and-forget */ }
  }
}

/**
 * Mid-season joining (spec §5: "an accepted team joins with no fixtures"): when entries were accepted while the season is
 * in progress, every organiser (the deciding one too: it is a reminder, not a registration notice) is told to add their
 * fixtures. Returns whether it reminded anyone.
 */
function remindMidSeason(deps: LeagueApiDeps, lg: LeagueRecord, seasonId: string, entries: ReadonlyArray<{ id: string; state: EntryState; coach: string }>): boolean {
  const saved = deps.store.season(lg.id, seasonId);
  if (!saved || seasonStage(saved) !== "active") return false;
  const names = entries.filter((e) => e.state === "accepted").map((e) => (saved.registrations ?? []).find((r) => r.id === e.id)?.teamName ?? e.coach);
  if (!names.length) return false;
  tellManagers(deps, lg, undefined, {
    type: "registration", title: `Add fixtures for ${names.join(", ")}`,
    body: `${names.join(", ")} joined ${saved.name} while it is in progress. No fixtures were made: add them in the Fixtures editor.`,
    link: `/app/leagues/${encodeURIComponent(lg.id)}?season=${encodeURIComponent(seasonId)}&tab=fixtures`, action: true,
  });
  return true;
}

function optionalReason(input: Record<string, unknown>): string | undefined | { error: string } {
  if (input.reason === undefined || input.reason === null) return undefined;
  if (typeof input.reason !== "string") return { error: "reason must be text." };
  const r = input.reason.trim();
  if ([...r].length > REASON_MAX) return { error: `reason must be at most ${REASON_MAX} characters.` };
  return r || undefined;
}

/** The public registration facts of a season: open or not (and why), approval, places from accepted teams only. */
export function registrationStatusView(league: LeagueRecord, season: SeasonRecord, now: Date) {
  const status = seasonWindowStatus(league, season, now);
  const settings = seasonRegistrationSettings(league, season);
  const entries = seasonEntries(league, season);
  const accepted = entries.filter((e) => e.state === "accepted").length;
  const reg = seasonRegistrationOf(league, season);
  const links = paymentLinksView(reg.payPal, reg.venmo);
  return {
    open: status.open,
    ...(status.open ? {} : { reason: status.reason, message: status.message }),
    ...settings,
    ...(reg.opensAt ? { opensAt: reg.opensAt } : {}),
    ...(reg.closesAt ? { closesAt: reg.closesAt } : {}),
    stage: seasonStage(season),
    midSeason: seasonStage(season) === "active",
    accepted,
    placesLeft: settings.cap === null ? null : Math.max(0, settings.cap - accepted),
    raceCounts: acceptedRaceCounts(league, season),
    regions: [...(league.regions ?? [])],
    packageName: leaguePackageName(league.id, season.id),
    shareText: leagueShareText(league.name),
    ...(links ? { links } : {}),
  };
}

/** The coach's own entry (latest), as only they see it. The reason for a decline or removal, never who decided. */
export function myRegistrationView(season: SeasonRecord, coach: string) {
  const rows = (season.registrations ?? []).filter((r) => ckey(r.coach) === ckey(coach)).sort((a, b) => b.enteredAt.localeCompare(a.enteredAt));
  const mine = rows[0];
  if (!mine) return undefined;
  const live = LIVE.has(mine.state);
  const position = waitlistPosition((season.registrations ?? []).map(rowToEntry), mine.id);
  const team = mine.teamId ? (season.teams ?? []).find((t) => t.id === mine.teamId) : undefined;
  const paid = team ? participantOf(season, team)?.paid === true : false;
  const code = live ? refCodeOf(mine) : undefined;
  return {
    id: mine.id, state: mine.state, teamName: mine.teamName, race: mine.race, kind: mine.kind, enteredAt: mine.enteredAt,
    ...(mine.region ? { region: mine.region } : {}),
    ...(position ? { position } : {}),
    ...(mine.teamId && mine.state === "accepted" ? { teamId: mine.teamId } : {}),
    ...(mine.midSeason && mine.state === "accepted" ? { midSeason: true } : {}),
    ...(code ? { refCode: code } : {}),
    ...(live && mine.coachSaysPaid ? { coachSaysPaid: { ...mine.coachSaysPaid } } : {}),
    ...(live ? { paid } : {}),
    ...(mine.decided?.reason && (mine.state === "declined" || mine.state === "dropped") ? { reason: mine.decided.reason } : {}),
  };
}

function registrationError(e: unknown): LeagueApiResult | undefined {
  if (e instanceof RegistrationError) return fail(e.status, e.message, { code: e.code });
  return undefined;
}

/** The route dispatcher (api.ts, before the settings routes); undefined = not a registration route. */
export async function leagueRegistrationRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, seasonId, what, rid, verb, ...more] = rest;
  if (first !== "seasons" || !seasonId || more.length) return undefined;
  // GET .../registration (no s) is the season's registration settings (lane L5, wizard.ts); the join facts are .../join.
  if (what !== "join" && what !== "registrations") return undefined;
  if (what === "join" && rid !== undefined) return undefined;
  try {
    return await route(method, seasonId, what, rid, verb, league, auth, deps);
  } catch (e) {
    const mapped = registrationError(e);
    if (mapped) return mapped;
    throw e;
  }
}

async function route(
  method: string, seasonId: string, what: "join" | "registrations", rid: string | undefined, verb: string | undefined,
  league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult> {
  const read = method === "GET" || method === "HEAD";
  const now = deps.now?.() ?? new Date();

  // ---- GET .../join: public facts + the viewer's own entry ----
  if (what === "join") {
    if (!read) return fail(405, "Use GET.");
    if (!league) return fail(404, "League not found.");
    const season = deps.store.season(league.id, seasonId);
    if (!season) return fail(404, "Season not found.");
    const mine = auth ? myRegistrationView(season, auth.coach) : undefined;
    return {
      status: 200, ...(auth ? { headers: { ...NO_STORE } } : { headers: { "cache-control": "no-store" } }),
      body: { status: registrationStatusView(league, season, now), ...(mine ? { mine } : {}) },
    };
  }

  // ---- GET .../registrations: the organisers' Registrations tab ----
  if (rid === undefined && read) {
    if (!auth) return fail(401, "Sign in to manage this league.");
    if (!league) return fail(404, "League not found.");
    if (!managesLeague(league, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can see its registrations.");
    const season = deps.store.season(league.id, seasonId);
    if (!season) return fail(404, "Season not found.");
    return res(200, organiserView(league, season, auth, deps));
  }

  if (read) return fail(405, "Use POST.");
  if (method !== "POST") return fail(405, "Use POST.");
  if (!auth) return fail(401, "Sign in to register.");
  const body = await readJsonObject(deps, BODY_MAX);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const input = body.value;
  // Judged against the league as it is now (after the body arrived).
  const lg = league ? deps.store.league(league.id) : undefined;
  if (!lg) return fail(404, "League not found.");
  const season = deps.store.season(lg.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  const cid = competitionIdOf(lg.id, season.id);

  // ---- POST .../registrations: join ----
  if (rid === undefined) return join(lg, season, cid, auth, input, deps, now);

  // ---- POST .../registrations/:rid/<verb> ----
  if (!rid.startsWith("lr-")) return fail(404, "Entry not found.");
  if (verb === "withdraw") {
    const row = (season.registrations ?? []).find((r) => r.id === rid);
    if (!row) return fail(404, "Entry not found.");
    const result = await serviceFor(deps).withdraw(cid, rid, actorOf(auth));
    if (result.changed && ckey(row.coach) !== ckey(auth.coach)) {
      try {
        deps.notify?.(row.coach, { type: "withdrawal", title: `${lg.name}: you were withdrawn`, body: `An organiser withdrew your entry for ${season.name}.`, link: leagueRegistrationLink(lg.id, season.id, "coach"), from: auth.coach });
      } catch { /* fire-and-forget */ }
    }
    remindMidSeason(deps, lg, season.id, result.promoted);
    return res(200, { entry: { id: result.entry.id, state: result.entry.state }, changed: result.changed });
  }
  if (verb === "paid-claim") return paidClaim(lg, season, cid, rid, auth, input, deps, now);

  if (verb !== "accept" && verb !== "waitlist" && verb !== "decline" && verb !== "promote" && verb !== "remove") return fail(404, "Not found.");
  if (!managesLeague(lg, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can decide registrations.");
  const reason = optionalReason(input);
  if (reason && typeof reason === "object") return fail(400, reason.error, { field: "reason" });
  if (input.promote !== undefined && typeof input.promote !== "boolean") return fail(400, "promote must be true or false.");
  const service = serviceFor(deps);
  const actor = actorOf(auth);
  // The entry must belong to THIS season: the core looks it up among this season's entries only (404 otherwise).
  let result;
  if (verb === "accept" || verb === "promote") result = await service.accept(cid, rid, actor, reason);
  else if (verb === "waitlist") result = await service.waitlist(cid, rid, actor, reason);
  else if (verb === "decline") result = await service.decline(cid, rid, actor, reason);
  else {
    result = await service.drop(cid, rid, actor, reason, { promoteNext: input.promote === true });
    if (result.changed) {
      tellManagers(deps, lg, auth.coach, {
        type: "withdrawal", title: `${result.entry.coach} was removed from ${lg.name} ${season.name}`, body: `${auth.coach} removed the team of ${result.entry.coach}.`,
        link: leagueRegistrationLink(lg.id, season.id, "organiser"), from: auth.coach,
      });
    }
  }
  const midSeason = remindMidSeason(deps, lg, season.id, result.changed ? [result.entry, ...result.promoted] : result.promoted);
  return res(200, {
    entry: { id: result.entry.id, coachId: result.entry.coach, state: result.entry.state },
    changed: result.changed,
    promoted: result.promoted.map((p) => ({ id: p.id, coachId: p.coach, state: p.state })),
    ...(midSeason ? { midSeason: true } : {}),
  });
}

async function join(
  lg: LeagueRecord, season: SeasonRecord, cid: string, auth: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps, now: Date,
): Promise<LeagueApiResult> {
  const extra = Object.keys(input).filter((k) => !["teamRef", "region", "share", "acknowledged"].includes(k));
  if (extra.length) return fail(400, `Unknown field: ${extra[0]}.`);
  const manager = managesLeague(lg, auth);
  if (!manager) {
    const window = seasonWindowStatus(lg, season, now);
    if (!window.open) return fail(409, window.message, { code: window.reason });
  }
  const teamRef = typeof input.teamRef === "string" ? input.teamRef.trim() : "";
  if (!teamRef) return fail(400, "Pick a team.", { field: "teamRef" });
  if (!TEAM_REF.test(teamRef)) return fail(400, "teamRef must name a Roster Builder save (save:<id>) or a library team (library:<teamId>).", { field: "teamRef" });
  if (input.acknowledged !== true)
    return fail(400, "Tick the box to confirm you agree to share your data with this league's organisers.", { field: "acknowledged" });
  let share: ShareField[];
  try { share = parseShareFields(input.share); } catch (e) { return fail(400, (e as ContactValidationError).message, { field: "share" }); }
  const regions = lg.regions ?? [];
  let region: string | undefined;
  if (input.region !== undefined && input.region !== null && input.region !== "") {
    if (typeof input.region !== "string" || !regions.includes(input.region.trim())) return fail(400, "Pick a region from the organisers' list.", { code: "region", field: "region" });
    region = input.region.trim();
  } else if (regions.length) return fail(400, "Pick your region.", { code: "region", field: "region" });

  if (!deps.leagueTeamSheet) return fail(503, "Team validation is unavailable on this host.");
  const marker = leaguePackageName(lg.id, season.id);
  const sheet = deps.leagueTeamSheet(auth.coach, teamRef, marker, houseRulesOf(lg, "league"), now);
  if ("error" in sheet) return fail(sheet.status ?? 400, sheet.error, { field: "teamRef" });
  const reg = seasonRegistrationOf(lg, season);
  const kind: "new" | "existing" = teamRef.startsWith("save:") && sheet.savePackage === marker && !sheet.libraryTeamId ? "new" : "existing";
  if (kind === "existing" && !reg.allowExistingTeams)
    return fail(400, "This season takes new teams built under its rules. Build one in the Roster Builder.", { code: "existing-teams", field: "teamRef" });
  if (!sheet.validation.ok || !sheet.roster)
    return fail(400, "This team doesn't meet the season's rules.", { code: "invalid-team", problems: sheet.validation.problems.length ? sheet.validation.problems : ["The team can't be checked automatically."] });
  const race = canonicalRace(sheet.roster.rosterName || sheet.race || "");
  const allowed = rosterAllowed(race, reg.allowedRosters);
  if (!allowed.allowed) return fail(400, allowed.reason, { code: "roster" });
  const snapshot = snapshotFromRoster(sheet.roster, sheet.teamName);
  const data: LeagueEntryData = {
    teamRef, kind, ...(sheet.libraryTeamId ? { libraryTeamId: sheet.libraryTeamId } : {}), teamName: snapshot.teamName, race,
    teamSnapshot: snapshot, validation: { ok: true, problems: [], checkedAt: now.toISOString() }, ...(region ? { region } : {}),
  };
  const result = await serviceFor(deps).submit(cid, auth.coach, actorOf(auth), { race, data: data as unknown as Record<string, unknown> });
  if (!result.changed) return fail(409, "You already have an entry for this season.", { code: "already" });
  remindMidSeason(deps, lg, season.id, [result.entry, ...result.promoted]);
  // The acknowledgement and the grant are written after the entry, so the grant counts for it (src/registration/privacy.ts).
  let sharingSaved = true;
  if (deps.registrationSharing) {
    try { deps.registrationSharing.acknowledge(auth.coach, lg.id, share, deps.now?.() ?? new Date()); } catch { sharingSaved = false; }
  }
  const saved = deps.store.season(lg.id, season.id) ?? season;
  return res(201, { registration: myRegistrationView(saved, auth.coach), ...(sharingSaved ? {} : { sharingSaved: false }) });
}

async function paidClaim(
  lg: LeagueRecord, season: SeasonRecord, cid: string, rid: string, auth: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps, now: Date,
): Promise<LeagueApiResult> {
  if (typeof input.paid !== "boolean") return fail(400, "paid must be true or false.");
  const paid = input.paid;
  if (season.status === "completed") return fail(409, "This season is finished.");
  const found = (season.registrations ?? []).find((r) => r.id === rid);
  if (!found || !LIVE.has(found.state)) return fail(404, "No active entry with that id.");
  if (ckey(found.coach) !== ckey(auth.coach)) return fail(403, "Only the coach can say they paid.");
  // Same lock as the registration actions, so a claim never races a decision on the same season file.
  const out = await registrationLocks.run(`league:${cid}`, () => {
    const s = deps.store.season(lg.id, season.id);
    const row = s?.registrations?.find((r) => r.id === rid);
    if (!s || !row || !LIVE.has(row.state) || ckey(row.coach) !== ckey(auth.coach)) return undefined;
    // The organisers hear about "I've paid" once per 24 hours however often it is toggled (the guard is stored).
    let notify = false;
    if (paid) {
      row.coachSaysPaid ??= { at: now.toISOString() };
      const last = row.paidClaimNotifiedAt ? Date.parse(row.paidClaimNotifiedAt) : Number.NaN;
      if (!(now.getTime() - last < PAID_CLAIM_NOTICE_MS)) { row.paidClaimNotifiedAt = now.toISOString(); notify = true; }
    } else delete row.coachSaysPaid;
    deps.store.putSeason(s);
    return { row: structuredClone(row), notify, season: s };
  });
  if (!out) return fail(404, "No active entry with that id.");
  if (out.notify) {
    const code = refCodeOf(out.row);
    tellManagers(deps, lg, auth.coach, {
      type: "registration", title: `${auth.coach} says they paid: ${lg.name} ${season.name}`,
      body: `${code ? `Reference ${code}. ` : ""}Check the payment, then tick Paid in Participants.`,
      link: `/app/leagues/${encodeURIComponent(lg.id)}/settings?season=${encodeURIComponent(season.id)}&tab=participants`, from: auth.coach,
    });
  }
  return res(200, { registration: myRegistrationView(deps.store.season(lg.id, season.id) ?? out.season, auth.coach) });
}

/** The Registrations tab: counts, the season's settings, live entries with what each coach shared, decided ones bare. */
function organiserView(league: LeagueRecord, season: SeasonRecord, viewer: LeagueApiIdentity, deps: LeagueApiDeps) {
  const rows = season.registrations ?? [];
  const entries = seasonEntries(league, season);
  const managers = managersOf(league);
  const live = rows.filter((r) => LIVE.has(r.state));
  let contacts: Array<SharedContact | undefined> = [];
  try {
    // The share scope is the league (league:<id>): the entry is checked against it with the league's id.
    contacts = deps.registrationSharing?.contacts(viewer, live.map((r) => ({ ...rowToEntry(r), competitionId: league.id })), managers) ?? [];
  } catch { contacts = []; }
  const shared = new Map(live.map((r, i) => [r.id, contacts[i]] as const));
  const order = waitlistOrder(rows.map(rowToEntry));
  const rank = new Map(order.map((e, i) => [e.id, i + 1]));
  const nextInLine = order[0]?.id;
  const paidOf = (r: LeagueRegistrationRow): boolean => {
    const team = r.teamId ? (season.teams ?? []).find((t) => t.id === r.teamId) : undefined;
    return team ? participantOf(season, team)?.paid === true : false;
  };
  const out = rows.map((r) => {
    const base = { id: r.id, coachId: r.coach, state: r.state, teamName: r.teamName, race: r.race, enteredAt: r.enteredAt, ...(r.decided ? { decided: { ...r.decided } } : {}) };
    if (!LIVE.has(r.state)) return base; // declined, withdrawn, removed: the decision only, never what the coach shared
    const contact = shared.get(r.id);
    const code = refCodeOf(r);
    return {
      ...base,
      kind: r.kind, submittedAt: r.submittedAt,
      ...(r.region ? { region: r.region } : {}),
      players: r.teamSnapshot.players.length, cost: r.teamSnapshot.cost,
      validation: { ok: r.validation.ok, problems: [...r.validation.problems] },
      ...(contact ? { shared: contact } : {}),
      ...(code ? { refCode: code } : {}),
      ...(r.coachSaysPaid ? { coachSaysPaid: { ...r.coachSaysPaid } } : {}),
      ...(r.state === "accepted" ? { paid: paidOf(r), ...(r.teamId ? { teamId: r.teamId } : {}), ...(r.midSeason ? { midSeason: true } : {}) } : {}),
      ...(rank.has(r.id) ? { position: rank.get(r.id)! } : {}),
      ...(r.id === nextInLine ? { nextInLine: true } : {}),
    };
  });
  const stateRank: Record<string, number> = { pending: 0, waitlisted: 1, accepted: 2, declined: 3, withdrawn: 4, dropped: 5 };
  const pos = (row: object) => (row as { position?: number }).position ?? 0;
  out.sort((a, b) => (stateRank[a.state] ?? 9) - (stateRank[b.state] ?? 9) || pos(a) - pos(b) || a.enteredAt.localeCompare(b.enteredAt));
  const window = seasonWindow(seasonRegistrationOf(league, season));
  const snapshot = seasonSnapshot(league, season);
  return {
    counts: registrationCounts(window, entries),
    settings: { ...seasonRegistrationSettings(league, season), stage: seasonStage(season), open: seasonWindowStatus(league, season, deps.now?.() ?? new Date()).open, test: snapshot.test },
    raceCounts: acceptedRaceCounts(league, season),
    entries: out,
  };
}
