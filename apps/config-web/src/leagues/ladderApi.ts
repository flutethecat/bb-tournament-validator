/**
 * League ladder routes (spec-league-ladder-2026-11-02, lane 8b). Reads follow the league's visibility (a draft league is not
 * there for anyone else) and a ladder in setup is seen by organisers and site admins only. Every write needs a session (CSRF
 * X-CW-Auth and the onboarding 428 gate run in front of every /api write in server.ts); GETs never change state: expiries,
 * discards and played challenges are derived on read (ladder.ts challengeState) and stored by the job (ladderJob.ts).
 *
 *   GET    /api/leagues/:id/ladders                                  the ladders (summaries + their dated fixtures, for the calendar)
 *   POST   /api/leagues/:id/ladders                                  organisers: { name, ranking? } a new ladder in setup (copies the
 *                                                                    current season's ruleset, team building table, house rules,
 *                                                                    ruleset card and played-on; Discord auto-populated)
 *   GET    /api/leagues/:id/ladders/:ladderId                        the Ladder tab: ranking, challenges, results, rounds, the viewer's
 *                                                                    teams and what each may challenge
 *   PATCH  /api/leagues/:id/ladders/:ladderId                        organisers: { revision, step?, general?, rules?, settings?, complete? }
 *   POST   /api/leagues/:id/ladders/:ladderId/start | close          organisers: setup -> open; open -> closed (live challenges and
 *                                                                    unplayed fixtures are discarded, the ranking freezes)
 *   GET    /api/leagues/:id/ladders/:ladderId/join                   join facts + the viewer's entry + their movable league teams
 *   POST   /api/leagues/:id/ladders/:ladderId/registrations          { teamRef | move: { id, teamId }, share, acknowledged }
 *   GET    /api/leagues/:id/ladders/:ladderId/registrations          organisers: entries with redraft status, TV and games played
 *   POST   /api/leagues/:id/ladders/:ladderId/registrations/:rid/(accept|decline|withdraw)
 *   POST   /api/leagues/:id/ladders/:ladderId/challenges             { challengerTeamId, defenderTeamId } the challenger's coach
 *   POST   /api/leagues/:id/ladders/:ladderId/challenges/:cid/(accept|decline|withdraw)
 *   POST   /api/leagues/:id/ladders/:ladderId/rounds                 organisers: { name?, deadline?, pairs: [{ home, away }] }
 *   POST   /api/leagues/:id/ladders/:ladderId/teams/:teamId/move     organisers: { seasonId } back to a season, with its progression
 *   Titles (ladderTitles.ts; each write runs the title rules in the same write, then tells the coaches):
 *   POST   .../ladders/:ladderId/titles/(vacate|crown|inactive|return)  organisers: { reason? } / { teamId }
 *   POST   .../ladders/:ladderId/bouts/:boutId/(extend|cancel)          organisers: { days } a title game's deadline, or call it off
 *   POST   .../ladders/:ladderId/contracts                              organisers: { teamId, note? } a Money in the Bank contract
 *   POST   .../ladders/:ladderId/contracts/:contractId/cash-in          the contract's coach: the champion can't decline
 *   POST   .../ladders/:ladderId/rumbles                                organisers: { name?, date, field: top8|open, roundDays?, points? }
 *   POST   .../ladders/:ladderId/rumbles/:rumbleId/(enter|withdraw)     a coach: { teamId } (open entry, before the date)
 *   POST   .../ladders/:ladderId/rumbles/:rumbleId/cancel               organisers
 *   GET    /api/leagues/:id/champions                                   public: the Current Champions panel (cups and belts)
 *
 * Fixture, team, recorder and Super FUMBBL routes read a ladder like a season (/api/leagues/:id/seasons/<ladderId>/...).
 * Privacy: challenges and members carry team ids only; coach names come from the (public) team rows; registration contacts
 * follow the league's share scope like a season's.
 */
import { houseRulesOf } from "../competition/houseRules.js";
import { ContactValidationError, leagueShareText, parseShareFields, type ShareField } from "../auth/contactSchema.js";
import { leaguePackageName } from "../leagueBuilderMarker.js";
import { populateSeasonDiscord } from "../discord/api.js";
import { RegistrationError, type RegistrationActor } from "../registration/index.js";
import type { NotificationInput } from "../notifications.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { assertRulesetPackage, seasonForViewer } from "./api.js";
import { readJsonObject, requestRevision } from "./http.js";
import {
  activeMembers, challengeFixture, challengeRefusal, challengesPaused, challengeState, countsInRanking, currentRedraftWindow, DAY_MS, declineLosses,
  defaultLadderSettings, fixtureOpen, HOUR_MS, isLadder, LADDER_PHASES, ladderRanking, ladderRedraftRules, ladderState, ladderVisible, LADDERS_PER_LEAGUE_MAX, LadderError,
  liveChallenge, moveRefusal, newLadderId, openWork, ownsTeam, parseLadderDescription, parseLadderName, parseLadderSettings, RANKING_LABEL, resultTime, roundFixture, settingsOf,
  STATE_LABEL, supersededTeams, teamAccount, teamKey, teamRedraftBlock, type LadderRankRow,
} from "./ladder.js";
import { copyTeamForMove, ladderRegistrationService, myLadderEntry, snapshotFromTeam } from "./ladderRegistration.js";
import { clubLabel, priorClubEntry, resolveClubPick } from "../clubs/pick.js";
import { teamGamesPlayed } from "./teamOps.js";
import type { LadderChallenge, LadderRanking, LadderRound } from "./ladderTypes.js";
import {
  awardContract, beltHolders, beltOn, cancelBout, cashIn, createRumble, finalHonours, safeTitleTick, settleForClose, titleReplay, titlesOf, titleView, type TitleNote, type TitleTickContext,
} from "./ladderTitles.js";
import { hallOfFame } from "./awards.js";
import { deriveStandings } from "./standings.js";
import { LADDER_RANKINGS } from "./ladderTypes.js";
import { canonicalRace, rosterAllowed } from "./leagueBuilder.js";
import { managesLeague } from "./lifecycle.js";
import { competitionIdOf, rowToEntry, snapshotFromRoster, type LeagueEntryData } from "./registration.js";
import { defaultSeasonRegistration, seasonRegistrationOf, seasonWindowStatus } from "./seasonRegistration.js";
import { gateBlock } from "./gates.js";
import { LEAGUE_RULESETS, type LeagueFixture, type LeagueRecord, type LeagueRuleset, type LeagueTeam, type SeasonRecord } from "./types.js";
import { leagueOwner, LeagueStoreError } from "./store.js";
import { parseLeagueHouseRules, SettingsError } from "./settings.js";

const BODY_MAX = 32 * 1024;
const NO_STORE = { "cache-control": "private, no-store" };
/** A Roster Builder save (a fork library team is never a source, owner 11-03; a league team moves in with `move`). */
const TEAM_REF = /^save:[A-Za-z0-9_.:-]{1,110}$/;
const ROUND_PAIRS_MAX = 64;
const ckey = (c: string | undefined): string => (c ?? "").trim().toLowerCase();
const res = (status: number, body: unknown, headers: Record<string, string> = NO_STORE): LeagueApiResult => ({ status, body, headers: { ...headers } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => res(status, { error, ...extra });
const actorOf = (auth: LeagueApiIdentity): RegistrationActor => ({ coach: auth.coach, ...(auth.admin ? { admin: true } : {}), ...(auth.test ? { test: true } : {}) });
const managersOf = (league: LeagueRecord): string[] => { const o = leagueOwner(league); return [...new Set([...(o ? [o] : []), ...league.organisers])]; };
const enc = encodeURIComponent;

/** SPA links (the base is /app/). */
export const ladderLink = (leagueId: string, ladderId: string): string => `/app/leagues/${enc(leagueId)}?tab=ladder&ladder=${enc(ladderId)}`;
export const ladderManageLink = (leagueId: string, ladderId: string, part = ""): string => `/app/leagues/${enc(leagueId)}/settings?tab=ladders&ladder=${enc(ladderId)}${part ? `&part=${part}` : ""}`;
export const proposeLink = (leagueId: string, ladderId: string, fixtureId: string): string => `/app/schedule?propose=${enc(`league:${leagueId}:${ladderId}:${fixtureId}`)}`;

function tell(deps: LeagueApiDeps, coach: string | undefined, input: NotificationInput): void {
  if (!coach?.trim()) return;
  try { deps.notify?.(coach.trim(), input); } catch { /* fire-and-forget */ }
}

function known(e: unknown): LeagueApiResult | undefined {
  if (e instanceof LadderError) return fail(e.status, e.message, { ...(e.field ? { field: e.field } : {}), ...(e.code ? { code: e.code } : {}) });
  if (e instanceof RegistrationError) return fail(e.status, e.message, { code: e.code });
  if (e instanceof SettingsError) return fail(e.status, e.message, e.field ? { field: e.field } : {});
  if (e instanceof LeagueStoreError) return fail(e.status, e.message);
  return undefined;
}

// ---- read models ---------------------------------------------------------------------------------------------------------

export interface LadderSummary {
  id: string;
  name: string;
  state: "setup" | "active" | "closed";
  stateLabel: string;
  ranking: LadderRanking;
  rankingLabel: string;
  style: "league" | "tournament";
  teamCount: number;
  openChallenges: number;
  startedAt?: string;
  closedAt?: string;
  endsAt?: string;
}

function summaryOf(ladder: SeasonRecord, now: Date, comps: readonly SeasonRecord[]): LadderSummary {
  const s = settingsOf(ladder.ladder);
  const st = ladderState(ladder);
  return {
    id: ladder.id, name: ladder.name, state: st, stateLabel: STATE_LABEL[st], ranking: s.ranking, rankingLabel: RANKING_LABEL[s.ranking], style: s.style,
    teamCount: activeMembers(ladder, supersededTeams(comps)).length,
    openChallenges: (ladder.ladder?.challenges ?? []).filter((ch) => liveChallenge(challengeState(ch, ladder, now))).length,
    ...(ladder.ladder?.startedAt ? { startedAt: ladder.ladder.startedAt } : {}),
    ...(ladder.ladder?.closedAt ? { closedAt: ladder.ladder.closedAt } : {}),
    ...(s.endsAt ? { endsAt: s.endsAt } : {}),
  };
}

/** A fixture as the public read shows it (the season read's filter), with what the ladder knows about it. */
function publicFixtures(league: LeagueRecord, ladder: SeasonRecord, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): LeagueFixture[] {
  return seasonForViewer(league, ladder, auth, deps.gamePage).fixtures;
}

function challengeView(ladder: SeasonRecord, ch: LadderChallenge, now: Date, viewer: string, league: LeagueRecord) {
  const team = (id: string) => ladder.teams.find((t) => t.id === id);
  const c = team(ch.challengerTeamId);
  const d = team(ch.defenderTeamId);
  const st = challengeState(ch, ladder, now);
  const mine = c && ownsTeam(c, viewer) ? "challenger" : d && ownsTeam(d, viewer) ? "defender" : undefined;
  return {
    id: ch.id, state: st,
    challenger: { teamId: ch.challengerTeamId, team: c?.name ?? "", coach: c?.coach ?? "", race: c?.race ?? "" },
    defender: { teamId: ch.defenderTeamId, team: d?.name ?? "", coach: d?.coach ?? "", race: d?.race ?? "" },
    createdAt: ch.createdAt, expiresAt: ch.expiresAt,
    ...(ch.answeredAt ? { answeredAt: ch.answeredAt } : {}),
    ...(ch.deadline ? { deadline: ch.deadline } : {}),
    ...(ch.fixtureId ? { fixtureId: ch.fixtureId } : {}),
    ...(ch.reason && (st === "discarded" || st === "expired") ? { reason: ch.reason } : {}),
    ...(mine ? { mine } : {}),
    ...(mine && ch.fixtureId && st === "accepted" ? { scheduleRef: `league:${league.id}:${ladder.id}:${ch.fixtureId}` } : {}),
  };
}

function ladderView(league: LeagueRecord, ladder: SeasonRecord, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date) {
  const comps = deps.store.competitions(league.id);
  const s = settingsOf(ladder.ladder);
  const manage = managesLeague(league, auth);
  const ranking = ladderRanking(ladder, now, comps);
  const viewer = auth?.coach ?? "";
  const challenges = [...(ladder.ladder?.challenges ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const views = challenges.map((ch) => challengeView(ladder, ch, now, viewer, league));
  const live = views.filter((v) => liveChallenge(v.state));
  const closed = views.filter((v) => !liveChallenge(v.state)).slice(0, 20);
  const fixtures = publicFixtures(league, ladder, auth, deps);
  const results = fixtures.filter(countsInRanking).sort((a, b) => resultTime(ladder, b) - resultTime(ladder, a)).slice(0, 15).map((f) => ({
    fixtureId: f.id, home: { team: f.home.team, teamId: f.home.teamId, score: f.home.score }, away: { team: f.away.team, teamId: f.away.teamId, score: f.away.score },
    at: new Date(resultTime(ladder, f)).toISOString(), kind: f.ladder?.roundId ? "round" as const : "challenge" as const,
  }));
  const rounds = (ladder.ladder?.rounds ?? []).map((r) => ({
    id: r.id, number: r.number, name: r.name, ...(r.deadline ? { deadline: r.deadline } : {}),
    fixtures: r.fixtureIds.map((id) => fixtures.find((f) => f.id === id)).filter((f): f is LeagueFixture => Boolean(f)),
  }));
  // The viewer's teams in the ladder and, for each, why it may not challenge each other team ("" = it may).
  const members = activeMembers(ladder, supersededTeams(comps));
  const mine = viewer ? members.filter((m) => ownsTeam(m.team, viewer)) : [];
  const targets: Record<string, Record<string, string>> = {};
  for (const m of mine) {
    targets[m.team.id] = {};
    for (const o of members) {
      if (o.team.id === m.team.id) continue;
      targets[m.team.id]![o.team.id] = challengeRefusal({ ladder, league, challenger: m.team, defender: o.team, ranking, now });
    }
  }
  const window = currentRedraftWindow(league, ladder, now);
  const titles = beltOn(ladder.ladder) || ladder.ladder?.titles || ladder.ladder?.rumbles?.length ? titleView(league, ladder, now, viewer, manage) : null;
  return {
    titles,
    ladder: {
      ...summaryOf(ladder, now, comps),
      description: ladder.ladder?.description ?? "",
      ruleset: ladder.ruleset,
      rulesetPackage: ladder.ladder?.rulesetPackage ?? null,
      houseRules: houseRulesOf(ladder.ladder ?? {}, "league"),
      playOnFork: ladder.ladder?.playOnFork === true,
      authorised: league.authorised !== false,
      settings: { ...s, ...(manage ? {} : { redraft: { ...s.redraft, rules: undefined } }) },
      paused: challengesPaused(league, ladder, now),
      ...(window ? { redraftWindow: window } : {}),
      revision: ladder.revision ?? 0,
      ...(manage && ladder.ladder?.wizard ? { wizard: ladder.ladder.wizard } : {}),
      // Organisers only: title steps that failed on the last pass (the Ladder tab shows "Title processing needs attention").
      ...(manage && ladder.ladder?.titleFailures?.length ? { titleFailures: ladder.ladder.titleFailures.map((f) => ({ step: f.step, at: f.at })) } : {}),
    },
    ranking,
    challenges: { live, closed },
    results,
    rounds,
    fixtures,
    manage,
    me: { teams: mine.map((m) => m.team.id), targets },
  };
}

// ---- dispatcher -------------------------------------------------------------------------------------------------------

export async function leagueLadderRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, lid, what, sub, verb, ...more] = rest;
  if (first !== "ladders" || more.length) return undefined;
  if (lid && what === "discord") return undefined; // src/discord/api.ts
  try {
    return await route(method, lid, what, sub, verb, league, auth, deps);
  } catch (e) {
    const k = known(e);
    if (k) return k;
    throw e;
  }
}

async function route(
  method: string, lid: string | undefined, what: string | undefined, sub: string | undefined, verb: string | undefined,
  league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult> {
  const read = method === "GET" || method === "HEAD";
  const now = deps.now?.() ?? new Date();
  if (!league) return fail(404, "League not found.");
  const manage = managesLeague(league, auth);

  if (!lid) {
    if (read) {
      const comps = deps.store.competitions(league.id);
      const ladders = deps.store.ladders(league.id).filter((l) => ladderVisible(l, manage));
      const body = {
        ladders: ladders.map((l) => ({
          ...summaryOf(l, now, comps),
          // The dated fixtures (the league calendar): the public season-read filter.
          fixtures: publicFixtures(league, l, auth, deps).filter((f) => f.date || f.finishedAt || f.scheduledTime?.start),
        })),
      };
      return res(200, body, auth || manage ? NO_STORE : { "cache-control": "no-store" });
    }
    if (method !== "POST") return fail(405, "Use GET or POST.");
    return createLadder(league, auth, deps, now);
  }

  const found = deps.store.season(league.id, lid);
  if (!found || !isLadder(found) || !ladderVisible(found, manage)) return fail(404, "Ladder not found.");
  const ladder = found;

  if (what === undefined) {
    if (read) return res(200, ladderView(league, ladder, auth, deps, now));
    if (method !== "PATCH") return fail(405, "Use GET or PATCH.");
    return patchLadder(league, ladder.id, auth, deps, now);
  }
  if ((what === "start" || what === "close") && sub === undefined) {
    if (method !== "POST") return fail(405, "Use POST.");
    return what === "start" ? startLadder(league, ladder.id, auth, deps, now) : closeLadder(league, ladder.id, auth, deps, now, "closed by an organiser");
  }
  if (what === "join" && sub === undefined) {
    if (!read) return fail(405, "Use GET.");
    return res(200, joinView(league, ladder, auth, deps, now));
  }
  if (what === "registrations") {
    if (sub === undefined && read) return organiserEntries(league, ladder, auth, deps, now);
    if (read) return fail(405, "Use POST.");
    if (method !== "POST") return fail(405, "Use POST.");
    if (sub === undefined) return join(league, ladder.id, auth, deps, now);
    return decideEntry(league, ladder.id, sub, verb, auth, deps);
  }
  if (what === "challenges") {
    if (method !== "POST") return fail(405, "Use POST.");
    if (sub === undefined) return issueChallenge(league, ladder.id, auth, deps, now);
    return answerChallenge(league, ladder.id, sub, verb, auth, deps, now);
  }
  if (what === "rounds" && sub === undefined) {
    if (method !== "POST") return fail(405, "Use POST.");
    return createRound(league, ladder.id, auth, deps, now);
  }
  if (what === "titles" && sub && verb === undefined) {
    if (method !== "POST") return fail(405, "Use POST.");
    if (!["vacate", "crown", "inactive", "return"].includes(sub)) return fail(404, "Not found.");
    return titleAction(league, ladder.id, sub as "vacate" | "crown" | "inactive" | "return", auth, deps);
  }
  if (what === "bouts" && sub && (verb === "extend" || verb === "cancel")) {
    if (method !== "POST") return fail(405, "Use POST.");
    return boutAction(league, ladder.id, sub, verb, auth, deps);
  }
  if (what === "contracts") {
    if (method !== "POST") return fail(405, "Use POST.");
    if (sub === undefined) return contractAward(league, ladder.id, auth, deps);
    if (verb === "cash-in") return contractCashIn(league, ladder.id, sub, auth, deps);
    return fail(404, "Not found.");
  }
  if (what === "rumbles") {
    if (method !== "POST") return fail(405, "Use POST.");
    if (sub === undefined) return rumbleCreate(league, ladder.id, auth, deps);
    if (verb === "enter" || verb === "withdraw" || verb === "cancel") return rumbleAction(league, ladder.id, sub, verb, auth, deps);
    return fail(404, "Not found.");
  }
  if (what === "teams" && sub && verb === "move") {
    if (method !== "POST") return fail(405, "Use POST.");
    return moveToSeason(league, ladder.id, sub, auth, deps, now);
  }
  return fail(404, "Not found.");
}

// ---- body + organiser gate ----------------------------------------------------------------------------------------------

async function body(deps: LeagueApiDeps): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; result: LeagueApiResult }> {
  const r = await readJsonObject(deps, BODY_MAX);
  if (r.ok) return r;
  return { ok: false, result: { ...fail(r.status, r.error), ...(r.close ? { close: true } : {}) } };
}

/** Body first, then the league and ladder as they are NOW (organiser routes): anonymous 401, others 403. */
async function organiserWrite(league: LeagueRecord, ladderId: string | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps) {
  if (!auth) return { result: fail(401, "Sign in to manage this league.") } as const;
  if (!managesLeague(league, auth)) return { result: fail(403, "This league is not one of yours: only its organisers and site admins can manage its ladders.") } as const;
  const b = await body(deps);
  if (!b.ok) return { result: b.result } as const;
  const lg = deps.store.league(league.id);
  if (!lg || !managesLeague(lg, auth)) return { result: fail(403, "This league is not one of yours: only its organisers and site admins can manage its ladders.") } as const;
  const ladder = ladderId ? deps.store.season(lg.id, ladderId) : undefined;
  if (ladderId && (!ladder || !isLadder(ladder))) return { result: fail(404, "Ladder not found.") } as const;
  return { input: b.value, league: lg, ladder, who: auth, now: deps.now?.() ?? new Date() } as const;
}

// ---- create / edit / start / close -------------------------------------------------------------------------------------

async function createLadder(league: LeagueRecord, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date): Promise<LeagueApiResult> {
  const w = await organiserWrite(league, undefined, auth, deps);
  if ("result" in w) return w.result!;
  now = w.now; // the time of the write: taken after the body arrived, never before (a slow body cannot slip past an expiry)
  const { input, league: lg } = w;
  const extra = Object.keys(input).filter((k) => k !== "name" && k !== "ranking");
  if (extra.length) return fail(400, `Unknown field: ${extra[0]!.slice(0, 40)}.`);
  const name = parseLadderName(input.name);
  if (input.ranking !== undefined && !LADDER_RANKINGS.includes(input.ranking as LadderRanking)) return fail(400, "Pick a ranking method: rating, points or position swap.", { field: "ranking" });
  const existing = deps.store.ladders(lg.id);
  if (existing.length >= LADDERS_PER_LEAGUE_MAX) return fail(409, `A league can have at most ${LADDERS_PER_LEAGUE_MAX} ladders.`);
  const n = Math.max(0, ...existing.map((l) => Number(l.id.slice("ladder-".length)) || 0)) + 1;
  const id = `ladder-${n}`;
  // Copied from the current season and the league (spec Q6), editable in the wizard's General and Rules steps.
  const current = deps.store.seasons(lg.id)[0];
  const at = now.toISOString();
  const teamBuilding = current?.rules?.teamBuilding;
  const ladder: SeasonRecord = {
    id, leagueId: lg.id, number: n, name, sourceSlug: id, ruleset: current?.ruleset ?? lg.ruleset ?? "BB2025", status: "active", stage: "setup",
    phases: LADDER_PHASES(), fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [], importedAt: at, source: "manual",
    ...(teamBuilding ? { rules: { teamBuilding: structuredClone(teamBuilding) } } : {}),
    // Joining is open while the ladder is (any time), no cap, no waitlist; approval is decided per entry (ladderRegistration.ts).
    registration: { ...defaultSeasonRegistration(lg), allowRegistration: true, approval: "organiser", waitlist: false, allowExistingTeams: true, allowMidSeason: true, maxRegistrations: null, maxPerRace: null },
    competition: "ladder",
    ladder: {
      settings: defaultLadderSettings((input.ranking as LadderRanking | undefined) ?? "position"),
      playOnFork: lg.playOnFork === true,
      ...(lg.rulesetPackage ? { rulesetPackage: lg.rulesetPackage } : {}),
      houseRules: houseRulesOf(lg, "league"),
      description: "", challenges: [], rounds: [], members: [], wizard: { step: 1 },
    },
  };
  deps.store.putSeason(ladder);
  // Its own Discord webhook and options, auto-populated from the league's (spec round 2); never fails the create.
  populateSeasonDiscord(deps.store, lg.id, id);
  return res(201, { ok: true, id, ladder: ladderView(lg, deps.store.season(lg.id, id)!, auth, deps, now).ladder });
}

async function patchLadder(league: LeagueRecord, ladderId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date): Promise<LeagueApiResult> {
  const w = await organiserWrite(league, ladderId, auth, deps);
  if ("result" in w) return w.result!;
  now = w.now; // the time of the write: taken after the body arrived, never before (a slow body cannot slip past an expiry)
  const { input, league: lg } = w;
  const ladder = w.ladder!;
  const allowed = new Set(["revision", "step", "general", "rules", "settings", "complete"]);
  const extra = Object.keys(input).filter((k) => !allowed.has(k));
  if (extra.length) return fail(400, `Unknown field: ${extra[0]!.slice(0, 40)}.`);
  const rev = requestRevision(input, deps.ifMatch);
  if (rev === "missing") return fail(428, "Send the ladder's revision.");
  if (rev === "bad") return fail(400, "revision must be a whole number.");
  if (rev !== (ladder.revision ?? 0)) return fail(409, "The ladder changed since you loaded it. Reload and try again.", { revision: ladder.revision ?? 0 });
  const next = structuredClone(ladder) as SeasonRecord & { ladder: NonNullable<SeasonRecord["ladder"]> };
  // Every part is validated before anything is written.
  if (input.general !== undefined) {
    const g = input.general as Record<string, unknown> | null;
    if (!g || typeof g !== "object" || Array.isArray(g)) return fail(400, "general must be an object.", { field: "general" });
    for (const k of Object.keys(g)) if (!["name", "description", "playOnFork"].includes(k)) return fail(400, `Unknown field: general.${k.slice(0, 40)}.`);
    if (g.name !== undefined) next.name = parseLadderName(g.name);
    if (g.description !== undefined) next.ladder.description = parseLadderDescription(g.description);
    if (g.playOnFork !== undefined) {
      if (typeof g.playOnFork !== "boolean") return fail(400, "playOnFork must be true or false.", { field: "general.playOnFork" });
      next.ladder.playOnFork = g.playOnFork;
    }
  }
  if (input.rules !== undefined) {
    const r = input.rules as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || Array.isArray(r)) return fail(400, "rules must be an object.", { field: "rules" });
    for (const k of Object.keys(r)) if (!["ruleset", "rulesetPackage", "houseRules"].includes(k)) return fail(400, `Unknown field: rules.${k.slice(0, 40)}.`);
    if (r.ruleset !== undefined) {
      if (!LEAGUE_RULESETS.includes(r.ruleset as LeagueRuleset)) return fail(400, "ruleset must be BB2020 or BB2025.", { field: "rules.ruleset" });
      if (ladderState(ladder) !== "setup" && r.ruleset !== ladder.ruleset) return fail(409, "The ruleset can't change once the ladder has started.", { field: "rules.ruleset" });
      next.ruleset = r.ruleset as LeagueRuleset;
    }
    if (r.rulesetPackage !== undefined) {
      if (r.rulesetPackage !== null && (typeof r.rulesetPackage !== "string" || r.rulesetPackage.length > 120)) return fail(400, "rulesetPackage must be a ruleset name or null.", { field: "rules.rulesetPackage" });
      assertRulesetPackage(r.rulesetPackage as string | null, deps);
      if (r.rulesetPackage) next.ladder.rulesetPackage = r.rulesetPackage as string; else delete next.ladder.rulesetPackage;
    }
    if (r.houseRules !== undefined) next.ladder.houseRules = parseLeagueHouseRules(r.houseRules, { houseRules: next.ladder.houseRules });
  }
  if (input.settings !== undefined) {
    const was = settingsOf(ladder.ladder).titles;
    next.ladder.settings = parseLadderSettings(input.settings, settingsOf(ladder.ladder), now);
    const is = next.ladder.settings.titles;
    if (is?.belt && !was?.belt) titlesOf(next.ladder).beltOnAt = now.toISOString();
    if (is?.mitb.enabled && !was?.mitb.enabled) titlesOf(next.ladder).mitbOnAt = now.toISOString();
  }
  if (input.step !== undefined) {
    if (typeof input.step !== "number" || !Number.isInteger(input.step) || input.step < 1 || input.step > 4) return fail(400, "step must be 1 to 4.", { field: "step" });
    next.ladder.wizard = { ...(next.ladder.wizard ?? {}), step: Math.max(next.ladder.wizard?.step ?? 1, input.step) };
  }
  if (input.complete !== undefined) {
    if (input.complete !== true) return fail(400, "complete must be true.", { field: "complete" });
    next.ladder.wizard = { ...(next.ladder.wizard ?? { step: 4 }), step: 4, completedAt: next.ladder.wizard?.completedAt ?? now.toISOString() };
  }
  deps.store.putSeason(next);
  return res(200, { ok: true, ladder: ladderView(lg, deps.store.season(lg.id, ladderId)!, auth, deps, now).ladder });
}

async function startLadder(league: LeagueRecord, ladderId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date): Promise<LeagueApiResult> {
  const w = await organiserWrite(league, ladderId, auth, deps);
  if ("result" in w) return w.result!;
  now = w.now; // the time of the write: taken after the body arrived, never before (a slow body cannot slip past an expiry)
  const ladder = w.ladder!;
  if (ladderState(ladder) !== "setup") return fail(409, ladderState(ladder) === "active" ? "The ladder is already open." : "The ladder is closed.");
  ladder.stage = "active";
  ladder.startedAt = now.toISOString();
  ladder.ladder!.startedAt = now.toISOString();
  ladder.ladder!.wizard = { ...(ladder.ladder!.wizard ?? { step: 4 }), step: 4, completedAt: ladder.ladder!.wizard?.completedAt ?? now.toISOString() };
  deps.store.putSeason(ladder);
  return res(200, { ok: true, ladder: ladderView(w.league, deps.store.season(w.league.id, ladderId)!, auth, deps, now).ladder });
}

/**
 * Closes a ladder (organiser, or the job at the scheduled end): live challenges and unplayed ladder fixtures are discarded
 * (no result, no penalty), the ranking freezes. Answers the coaches to tell (the caller sends after the write).
 */
export function closeLadderRecord(
  ladder: SeasonRecord, now: Date, reason: string,
  opts: { league?: TitleTickContext["league"]; competitions?: readonly SeasonRecord[]; titleNotes?: TitleNote[] } = {},
): Array<{ coach: string; text: string }> {
  const at = now.toISOString();
  const competitions = opts.competitions ?? [ladder];
  // First the results already in (finished Rumble games, the last period's honours), at the close instant; then the discards.
  settleForClose({ league: opts.league ?? { id: ladder.leagueId, name: "" }, ladder, competitions, now, notes: opts.titleNotes ?? [] });
  const notes: Array<{ coach: string; text: string }> = [];
  const coachOf = (id: string) => teamAccount(ladder.teams.find((t) => t.id === id) ?? { coachId: "" });
  for (const ch of ladder.ladder?.challenges ?? []) {
    const st = challengeState(ch, ladder, now);
    // What the reads derived is stored first (an expired or played challenge stays as it ended).
    if (st === "expired" && ch.state === "open") { ch.state = "expired"; ch.closedAt = ch.expiresAt; continue; }
    if (st === "played" && ch.state === "accepted") { ch.state = "played"; ch.closedAt = at; continue; }
    if (!liveChallenge(st)) continue;
    ch.state = st === "open" ? "withdrawn" : "discarded";
    ch.closedAt = at;
    ch.reason = `The ladder was ${reason}.`;
    for (const id of [ch.challengerTeamId, ch.defenderTeamId]) notes.push({ coach: coachOf(id), text: `${ladder.teams.find((t) => t.id === ch.challengerTeamId)?.name ?? "A team"} v ${ladder.teams.find((t) => t.id === ch.defenderTeamId)?.name ?? "a team"}: discarded because the ladder was ${reason}.` });
  }
  for (const f of ladder.fixtures) {
    if (!fixtureOpen(f)) continue;
    f.deadlineOutcome = { outcome: "no-result", auto: true, at };
  }
  for (const b of ladder.ladder?.titles?.bouts ?? []) if (b.state === "scheduled") cancelBout(ladder, b, at, `The ladder was ${reason}.`);
  for (const ru of ladder.ladder?.rumbles ?? []) if (ru.state === "entry" || ru.state === "running") { ru.state = "cancelled"; ru.note = `The ladder was ${reason}.`; }
  ladder.status = "completed";
  ladder.endedAt = at;
  if (ladder.ladder) { ladder.ladder.closedAt = at; ladder.ladder.closedReason = reason; }
  // The final standings freeze: the top 3 and the belt holder at close go into league Honours.
  finalHonours(ladder, now, competitions);
  return notes;
}

async function closeLadder(league: LeagueRecord, ladderId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date, reason: string): Promise<LeagueApiResult> {
  const w = await organiserWrite(league, ladderId, auth, deps);
  if ("result" in w) return w.result!;
  now = w.now; // the time of the write: taken after the body arrived, never before (a slow body cannot slip past an expiry)
  const ladder = w.ladder!;
  if (ladderState(ladder) === "closed") return fail(409, "The ladder is already closed.");
  const titleNotes: TitleNote[] = [];
  const notes = closeLadderRecord(ladder, now, reason, { league: w.league, competitions: deps.store.competitions(w.league.id).map((c) => (c.id === ladder.id ? ladder : c)), titleNotes });
  deps.store.putSeason(ladder);
  for (const n of notes) tell(deps, n.coach, { type: "ladder", title: `${w.league.name} ${ladder.name}: challenge discarded`, body: n.text, link: ladderLink(w.league.id, ladderId), subject: ladder.name });
  sendTitleNotes(deps, w.league, ladder, titleNotes, w.who.coach);
  return res(200, { ok: true, ladder: ladderView(w.league, deps.store.season(w.league.id, ladderId)!, auth, deps, now).ladder });
}

// ---- joining ----------------------------------------------------------------------------------------------------------------

/** The league teams a coach could move into this ladder: their current rows in the league's other competitions. */
function movableTeams(league: LeagueRecord, ladder: SeasonRecord, coach: string, deps: LeagueApiDeps, now: Date) {
  const comps = deps.store.competitions(league.id);
  const superseded = supersededTeams(comps);
  const out: Array<{ id: string; competition: string; kind: "season" | "ladder"; teamId: string; team: string; race: string; teamValue: number | null; games: number; blocked?: string }> = [];
  for (const c of comps) {
    if (c.id === ladder.id) continue;
    if (isLadder(c) && ladderState(c) === "setup") continue;
    for (const t of c.teams ?? []) {
      if (!ownsTeam(t, coach) || superseded.has(teamKey(c.id, t.id))) continue;
      if (isLadder(c) && !(c.ladder?.members ?? []).some((m) => m.teamId === t.id && !m.leftAt)) continue;
      const games = c.fixtures.filter((f) => (f.home.teamId === t.id || f.away.teamId === t.id) && countsInRanking(f)).length;
      const blocked = moveRefusal(c) || openWork(c, t.id, now);
      out.push({ id: c.id, competition: c.name, kind: isLadder(c) ? "ladder" : "season", teamId: t.id, team: t.name, race: t.race, teamValue: t.teamValue ?? null, games, ...(blocked ? { blocked } : {}) });
    }
  }
  return out;
}

function joinView(league: LeagueRecord, ladder: SeasonRecord, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date) {
  const s = settingsOf(ladder.ladder);
  const window = seasonWindowStatus(league, ladder, now);
  const mine = auth ? myLadderEntry(ladder, auth.coach) : undefined;
  return {
    status: {
      open: window.open && ladderState(ladder) === "active",
      ...(window.open && ladderState(ladder) === "active" ? {} : { message: ladderState(ladder) === "active" ? (window.open ? "" : window.message) : ladderState(ladder) === "closed" ? "The ladder is closed." : "The ladder has not started yet." }),
      style: s.style, autoApprove: s.autoApproveValidated, moves: s.style === "league",
      packageName: leaguePackageName(league.id, ladder.id), shareText: leagueShareText(league.name), regions: [...(league.regions ?? [])],
    },
    ...(mine ? { mine } : {}),
    ...(auth && s.style === "league" ? { movable: movableTeams(league, ladder, auth.coach, deps, now) } : {}),
  };
}

async function join(league: LeagueRecord, ladderId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date): Promise<LeagueApiResult> {
  if (!auth) return fail(401, "Sign in to join the ladder.");
  const b = await body(deps);
  if (!b.ok) return b.result;
  const input = b.value;
  now = deps.now?.() ?? new Date(); // after the body arrived
  const lg = deps.store.league(league.id);
  const ladder = lg ? deps.store.season(lg.id, ladderId) : undefined;
  if (!lg || !ladder || !isLadder(ladder) || !ladderVisible(ladder, managesLeague(lg, auth))) return fail(404, "Ladder not found.");
  const extra = Object.keys(input).filter((k) => !["teamRef", "move", "region", "clubId", "share", "acknowledged"].includes(k));
  if (extra.length) return fail(400, `Unknown field: ${extra[0]!.slice(0, 40)}.`);
  if (ladderState(ladder) !== "active") return fail(409, ladderState(ladder) === "closed" ? "The ladder is closed." : "The ladder has not started yet.", { code: "closed" });
  if (!managesLeague(lg, auth)) {
    const shut = gateBlock(deps.store, lg, "registration", ladder.id, now);
    if (shut) return shut;
    const window = seasonWindowStatus(lg, ladder, now);
    if (!window.open) return fail(409, window.message, { code: window.reason });
  }
  if (input.acknowledged !== true) return fail(400, "Tick the box to confirm you agree to share your data with this league's organisers.", { field: "acknowledged" });
  let share: ShareField[];
  try { share = parseShareFields(input.share); } catch (e) { return fail(400, (e as ContactValidationError).message, { field: "share" }); }
  const regions = lg.regions ?? [];
  let region: string | undefined;
  if (input.region !== undefined && input.region !== null && input.region !== "") {
    if (typeof input.region !== "string" || !regions.includes(input.region.trim())) return fail(400, "Pick a region from the organisers' list.", { code: "region", field: "region" });
    region = input.region.trim();
  } else if (regions.length) return fail(400, "Pick your region.", { code: "region", field: "region" });
  // Club (clubs lane): one of the coach's clubs or none; fixed once the entry was accepted (src/clubs/pick.ts).
  const clubPick = resolveClubPick(auth.coach, input.clubId, priorClubEntry(ladder.registrations, auth.coach));
  if (!clubPick.ok) return fail(clubPick.status, clubPick.error, { code: clubPick.code, field: "clubId" });
  const s = settingsOf(ladder.ladder);
  const reg = seasonRegistrationOf(lg, ladder);
  let data: LeagueEntryData;
  let approval: "auto" | "organiser" = "organiser";
  let flag: string | undefined;
  if (input.move !== undefined) {
    // A league team moving in with its progression (league-style ladders only): organiser approval always.
    if (s.style === "tournament") return fail(400, "This ladder resets rosters every game: it takes new teams only.", { code: "new-teams-only", field: "move" });
    const m = input.move as Record<string, unknown> | null;
    if (!m || typeof m !== "object" || typeof m.id !== "string" || typeof m.teamId !== "string") return fail(400, "move must be { id, teamId }.", { field: "move" });
    const option = movableTeams(lg, ladder, auth.coach, deps, now).find((o) => o.id === m.id && o.teamId === m.teamId);
    if (!option) return fail(404, "That team is not one of yours in this league.", { field: "move" });
    if (option.blocked) return fail(409, option.blocked, { code: "busy", field: "move" });
    const source = deps.store.season(lg.id, option.id)!;
    const team = source.teams.find((t) => t.id === option.teamId)!;
    const snapshot = snapshotFromTeam(team);
    data = {
      teamRef: `move:${source.id}:${team.id}`, kind: "existing", teamName: team.name, race: canonicalRace(team.race), teamSnapshot: snapshot,
      validation: { ok: true, problems: [], checkedAt: now.toISOString() }, ...(region ? { region } : {}), ...(clubPick.clubId ? { clubId: clubPick.clubId } : {}),
      move: { kind: isLadder(source) ? "ladder" : "season", id: source.id, teamId: team.id },
    };
    flag = `moving ${team.name} from ${source.name}`;
  } else {
    const teamRef = typeof input.teamRef === "string" ? input.teamRef.trim() : "";
    if (!teamRef) return fail(400, "Pick a team.", { field: "teamRef" });
    if (teamRef.startsWith("library:")) return fail(400, "A Super FUMBBL library team can't join a league. Pick a saved team, or move one of your league teams in.", { code: "library-source", field: "teamRef" });
    if (!TEAM_REF.test(teamRef)) return fail(400, "teamRef must name a Roster Builder save (save:<id>).", { field: "teamRef" });
    if (!deps.leagueTeamSheet) return fail(503, "Team validation is unavailable on this host.");
    const marker = leaguePackageName(lg.id, ladder.id);
    const sheet = deps.leagueTeamSheet(auth.coach, teamRef, marker, houseRulesOf(ladder.ladder ?? {}, "league"), now);
    if ("error" in sheet) return fail(sheet.status ?? 400, sheet.error, { field: "teamRef" });
    const kind: "new" | "existing" = teamRef.startsWith("save:") && sheet.savePackage === marker && !sheet.libraryTeamId ? "new" : "existing";
    if (kind === "existing" && s.style === "tournament") return fail(400, "This ladder takes new teams built under its rules. Build one in the Roster Builder.", { code: "new-teams-only", field: "teamRef" });
    if (!sheet.validation.ok || !sheet.roster)
      return fail(400, "This team doesn't meet the ladder's rules.", { code: "invalid-team", problems: sheet.validation.problems.length ? sheet.validation.problems : ["The team can't be checked automatically."] });
    const race = canonicalRace(sheet.roster.rosterName || sheet.race || "");
    const allowedRoster = rosterAllowed(race, reg.allowedRosters);
    if (!allowedRoster.allowed) return fail(400, allowedRoster.reason, { code: "roster" });
    const snapshot = snapshotFromRoster(sheet.roster, sheet.teamName);
    data = {
      teamRef, kind, ...(sheet.libraryTeamId ? { libraryTeamId: sheet.libraryTeamId } : {}), teamName: snapshot.teamName, race,
      teamSnapshot: snapshot, validation: { ok: true, problems: [], checkedAt: now.toISOString() }, ...(region ? { region } : {}), ...(clubPick.clubId ? { clubId: clubPick.clubId } : {}),
    };
    // A team built and validated in the Roster Builder for this ladder joins straight away when the organisers allow it.
    if (kind === "new" && s.autoApproveValidated) { approval = "auto"; flag = "approved through the validator"; }
    else if (kind === "existing") flag = "a pre-existing team: review it";
  }
  const service = ladderRegistrationService(deps.store, {
    approval, ...(deps.now ? { now: deps.now } : {}), ...(deps.registrationBeforeWrite ? { beforeWrite: deps.registrationBeforeWrite } : {}),
    notify: (coach, n) => tell(deps, coach, n),
  });
  const result = await service.submit(competitionIdOf(lg.id, ladder.id), auth.coach, actorOf(auth), { race: data.race, data: data as unknown as Record<string, unknown>, ...(flag ? { organiserFlag: flag } : {}) });
  if (!result.changed) return fail(409, "You already have an entry for this ladder.", { code: "already" });
  let sharingSaved = true;
  if (deps.registrationSharing) {
    try { deps.registrationSharing.acknowledge(auth.coach, lg.id, share, deps.now?.() ?? new Date()); } catch { sharingSaved = false; }
  }
  const saved = deps.store.season(lg.id, ladder.id) ?? ladder;
  return res(201, { registration: myLadderEntry(saved, auth.coach), ...(sharingSaved ? {} : { sharingSaved: false }) });
}

/** The redraft status the organiser sees for a team moving in: its source season's redraft task, else how it was drafted. */
function redraftStatus(source: SeasonRecord | undefined, team: LeagueTeam | undefined, comps: readonly SeasonRecord[]): string {
  if (!team) return "Not known";
  for (const c of comps) {
    const task = c.redraft?.teams.find((t) => t.teamId === team.id && c.id === source?.id) ?? c.redraft?.teams.find((t) => t.teamId === team.id && t.sourceSeasonId === source?.id);
    if (!task || !task.selected) continue;
    if (task.needsRedraft) return "Needs redraft";
    if (task.status === "pending") return c.redraft?.closedAt ? "Redraft closed without a list" : "Redrafting now";
    if (task.status === "submitted") return "Redrafted";
  }
  if (team.redraftedFrom) return `Redrafted from ${comps.find((c) => c.id === team.redraftedFrom!.seasonId)?.name ?? "an earlier season"}`;
  return "Never redrafted";
}

function organiserEntries(league: LeagueRecord, ladder: SeasonRecord, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date): LeagueApiResult {
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!managesLeague(league, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can see its entries.");
  const comps = deps.store.competitions(league.id);
  const rows = ladder.registrations ?? [];
  const live = rows.filter((r) => r.state === "pending" || r.state === "accepted" || r.state === "waitlisted");
  let contacts: Array<unknown> = [];
  try {
    contacts = deps.registrationSharing?.contacts(auth, live.map((r) => ({ ...rowToEntry(r), competitionId: league.id })), managersOf(league)) ?? [];
  } catch { contacts = []; }
  const shared = new Map(live.map((r, i) => [r.id, contacts[i]] as const));
  const entries = rows.map((r) => {
    const base = { id: r.id, coachId: r.coach, state: r.state, teamName: r.teamName, race: r.race, enteredAt: r.enteredAt, kind: r.kind, ...(r.decided ? { decided: { ...r.decided } } : {}) };
    if (!(r.state === "pending" || r.state === "accepted" || r.state === "waitlisted")) return base;
    const last = r.registrationLog.at(-1);
    const viaValidator = r.state === "accepted" && !r.move && last?.action !== "accept" && ckey(last?.by) === ckey(r.coach);
    const source = r.move ? deps.store.season(league.id, r.move.id) : undefined;
    const moving = r.move ? source?.teams.find((t) => t.id === r.move!.teamId) : undefined;
    const games = moving && source ? source.fixtures.filter((f) => (f.home.teamId === moving.id || f.away.teamId === moving.id) && countsInRanking(f)).length : 0;
    // What the organiser decides a pre-existing team on (spec round 2): redraft status, TV and games played.
    const review = r.kind === "existing" ? {
      from: r.move ? source?.name ?? "Another competition" : "Outside this league",
      redraft: r.move ? redraftStatus(source, moving, comps) : "Not drafted in this league",
      teamValue: moving?.teamValue ?? r.teamSnapshot.cost,
      gamesPlayed: r.move ? games : null,
      busy: r.move && source && moving ? openWork(source, moving.id, now) || undefined : undefined,
    } : undefined;
    const contact = shared.get(r.id);
    return {
      ...base, submittedAt: r.submittedAt, players: r.teamSnapshot.players.length, cost: r.teamSnapshot.cost,
      ...(viaValidator ? { viaValidator: true } : {}), ...(review ? { review } : {}), ...(contact ? { shared: contact } : {}),
      ...(r.teamId && r.state === "accepted" ? { teamId: r.teamId } : {}),
      ...clubLabel(r.clubId),
    };
  });
  const rank: Record<string, number> = { pending: 0, waitlisted: 1, accepted: 2, declined: 3, withdrawn: 4, dropped: 5 };
  entries.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || b.enteredAt.localeCompare(a.enteredAt));
  return res(200, { entries, autoApprove: settingsOf(ladder.ladder).autoApproveValidated, style: settingsOf(ladder.ladder).style });
}

async function decideEntry(league: LeagueRecord, ladderId: string, rid: string, verb: string | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!rid.startsWith("lr-")) return fail(404, "Entry not found.");
  if (verb !== "accept" && verb !== "decline" && verb !== "withdraw") return fail(404, "Not found.");
  const b = await body(deps);
  if (!b.ok) return b.result;
  const lg = deps.store.league(league.id);
  const ladder = lg ? deps.store.season(lg.id, ladderId) : undefined;
  if (!lg || !ladder || !isLadder(ladder)) return fail(404, "Ladder not found.");
  const reason = b.value.reason === undefined || b.value.reason === null ? undefined : typeof b.value.reason === "string" && [...b.value.reason.trim()].length <= 500 ? b.value.reason.trim() || undefined : null;
  if (reason === null) return fail(400, "reason must be text of at most 500 characters.", { field: "reason" });
  const service = ladderRegistrationService(deps.store, { ...(deps.now ? { now: deps.now } : {}), notify: (coach, n) => tell(deps, coach, n) });
  const cid = competitionIdOf(lg.id, ladder.id);
  if (verb === "withdraw") {
    const result = await service.withdraw(cid, rid, actorOf(auth));
    return res(200, { entry: { id: result.entry.id, state: result.entry.state }, changed: result.changed });
  }
  if (!managesLeague(lg, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can decide entries.");
  const result = verb === "accept" ? await service.accept(cid, rid, actorOf(auth), reason) : await service.decline(cid, rid, actorOf(auth), reason);
  return res(200, { entry: { id: result.entry.id, coachId: result.entry.coach, state: result.entry.state }, changed: result.changed });
}

// ---- challenges -------------------------------------------------------------------------------------------------------------

async function coachWrite(league: LeagueRecord, ladderId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps) {
  if (!auth) return { result: fail(401, "Sign in to use the ladder.") } as const;
  const b = await body(deps);
  if (!b.ok) return { result: b.result } as const;
  const lg = deps.store.league(league.id);
  const ladder = lg ? deps.store.season(lg.id, ladderId) : undefined;
  if (!lg || !ladder || !isLadder(ladder) || !ladderVisible(ladder, managesLeague(lg, auth))) return { result: fail(404, "Ladder not found.") } as const;
  return { input: b.value, league: lg, ladder, who: auth, now: deps.now?.() ?? new Date() } as const;
}

async function issueChallenge(league: LeagueRecord, ladderId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date): Promise<LeagueApiResult> {
  const w = await coachWrite(league, ladderId, auth, deps);
  if ("result" in w) return w.result!;
  now = w.now; // the time of the write: taken after the body arrived, never before (a slow body cannot slip past an expiry)
  const { input, league: lg, ladder, who } = w;
  const comps = deps.store.competitions(lg.id);
  const members = activeMembers(ladder, supersededTeams(comps));
  const challenger = members.find((m) => m.team.id === input.challengerTeamId)?.team;
  const defender = members.find((m) => m.team.id === input.defenderTeamId)?.team;
  if (!challenger || !defender) return fail(404, "Both teams must be in the ladder.");
  if (!ownsTeam(challenger, who.coach)) return fail(403, "Only the team's coach can issue its challenges.");
  // The ladder challenge gate (gates.ts): refused with the countdown until it opens.
  const shut = gateBlock(deps.store, lg, "ladder-challenges", ladder.id, now);
  if (shut) return shut;
  const ranking = ladderRanking(ladder, now, comps);
  const refusal = challengeRefusal({ ladder, league: lg, challenger, defender, ranking, now });
  if (refusal) return fail(409, refusal, { code: "refused" });
  const s = settingsOf(ladder.ladder);
  const rankOf = (id: string) => ranking.find((r) => r.teamId === id)?.rank ?? 0;
  const taken = new Set(ladder.ladder!.challenges.map((c) => c.id));
  let id = newLadderId("lc");
  while (taken.has(id)) id = newLadderId("lc");
  const ch: LadderChallenge = {
    id, challengerTeamId: challenger.id, defenderTeamId: defender.id, state: "open", createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + s.expiryHours * HOUR_MS).toISOString(), ranks: { challenger: rankOf(challenger.id), defender: rankOf(defender.id) }, told: ["issued"],
  };
  ladder.ladder!.challenges.push(ch);
  deps.store.putSeason(ladder);
  tell(deps, teamAccount(defender), {
    type: "ladder", title: `${challenger.name} challenged ${defender.name}`,
    body: `${challenger.coach} challenged your team in ${ladder.name}. Accept or decline within ${s.expiryHours} hours.${s.declineRule.enabled ? ` ${s.declineRule.count} declines within ${s.declineRule.days} days count as a loss.` : ""}`,
    link: ladderLink(lg.id, ladder.id), from: who.coach, subject: `${lg.name} ${ladder.name}`, action: true,
  });
  return res(201, { challenge: challengeView(deps.store.season(lg.id, ladder.id)!, ch, now, who.coach, lg) });
}

async function answerChallenge(league: LeagueRecord, ladderId: string, cid: string, verb: string | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date): Promise<LeagueApiResult> {
  if (verb !== "accept" && verb !== "decline" && verb !== "withdraw") return fail(404, "Not found.");
  const w = await coachWrite(league, ladderId, auth, deps);
  if ("result" in w) return w.result!;
  now = w.now; // the time of the write: taken after the body arrived, never before (a slow body cannot slip past an expiry)
  const { league: lg, ladder, who } = w;
  const ch = ladder.ladder!.challenges.find((c) => c.id === cid);
  if (!ch) return fail(404, "Challenge not found.");
  const challenger = ladder.teams.find((t) => t.id === ch.challengerTeamId);
  const defender = ladder.teams.find((t) => t.id === ch.defenderTeamId);
  if (!challenger || !defender) return fail(404, "Challenge not found.");
  const st = challengeState(ch, ladder, now);
  if (st !== "open") return fail(409, st === "expired" ? "This challenge expired." : "This challenge has already been answered.", { state: st });
  const at = now.toISOString();
  const subject = `${lg.name} ${ladder.name}`;
  const link = ladderLink(lg.id, ladder.id);
  if (verb === "withdraw") {
    if (!ownsTeam(challenger, who.coach)) return fail(403, "Only the challenger's coach can withdraw it.");
    ch.state = "withdrawn";
    ch.answeredAt = at;
    ch.closedAt = at;
    deps.store.putSeason(ladder);
    tell(deps, teamAccount(defender), { type: "ladder", title: `${challenger.name} withdrew its challenge`, body: `The challenge to ${defender.name} in ${ladder.name} was withdrawn.`, link, from: who.coach, subject });
    return res(200, { challenge: challengeView(ladder, ch, now, who.coach, lg) });
  }
  if (!ownsTeam(defender, who.coach)) return fail(403, "Only the challenged team's coach can answer.");
  if (verb === "decline") {
    const before = new Set(declineLosses(ladder, now).map((l) => l.challengeId));
    ch.state = "declined";
    ch.answeredAt = at;
    ch.closedAt = at;
    const loss = declineLosses(ladder, now).find((l) => l.challengeId === ch.id && !before.has(l.challengeId));
    ch.told = [...(ch.told ?? []), "answered", ...(loss ? ["loss"] : [])];
    deps.store.putSeason(ladder);
    const s = settingsOf(ladder.ladder);
    tell(deps, teamAccount(challenger), {
      type: "ladder", title: `${defender.name} declined your challenge`,
      body: loss ? `${defender.name} has declined ${s.declineRule.count} challenges within ${s.declineRule.days} days, so this one counts as a win for ${challenger.name}.` : `${defender.coach} declined the challenge in ${ladder.name}.`,
      link, from: who.coach, subject,
    });
    if (loss) tell(deps, teamAccount(defender), { type: "ladder", title: `${defender.name}: a decline counted as a loss`, body: `${s.declineRule.count} declines within ${s.declineRule.days} days count as a loss in ${ladder.name}.`, link, subject });
    return res(200, { challenge: challengeView(ladder, ch, now, who.coach, lg), ...(loss ? { countedAsLoss: true } : {}) });
  }
  // Accept: the fixture is made now and goes straight into the time-proposal flow (inbox + DM to both coaches).
  const comps = deps.store.competitions(lg.id);
  const members = activeMembers(ladder, supersededTeams(comps));
  if (!members.some((m) => m.team.id === challenger.id) || !members.some((m) => m.team.id === defender.id)) return fail(409, "Both teams must still be in the ladder.");
  // Every challenge rule again, now (range, rematch, limits, pauses, redraft blocks): ranks and games may have changed since
  // it was issued. The challenge itself is left out, so it does not count against its own pair or the open limit.
  const without = { ...ladder, ladder: { ...ladder.ladder!, challenges: ladder.ladder!.challenges.filter((c) => c.id !== ch.id) } } as SeasonRecord;
  const refusal = challengeRefusal({ ladder: without, league: lg, challenger, defender, ranking: ladderRanking(without, now, comps), now });
  if (refusal) return fail(409, refusal, { code: "refused" });
  const s = settingsOf(ladder.ladder);
  ch.state = "accepted";
  ch.answeredAt = at;
  ch.deadline = new Date(now.getTime() + s.playByDays * DAY_MS).toISOString();
  const fixture = challengeFixture(ladder, ch, defender, challenger);
  // Titles: a challenge the champion accepts (only the top N may make one) is a title defence.
  if (beltOn(ladder.ladder)) {
    const held = titleReplay(ladder, now);
    if (held.holder?.teamId === defender.id && !held.inactiveSince) fixture.ladder = { ...fixture.ladder, title: "defence" };
  }
  ch.fixtureId = fixture.id;
  ch.told = [...(ch.told ?? []), "answered"];
  ladder.fixtures.push(fixture);
  deps.store.putSeason(ladder);
  const label = `${defender.name} v ${challenger.name}`;
  for (const [team, other] of [[challenger, defender], [defender, challenger]] as const) {
    tell(deps, teamAccount(team), {
      type: "ladder", title: `Challenge accepted: propose a time for ${label}`,
      body: `${team === challenger ? `${defender.coach} accepted your challenge` : `You accepted ${challenger.name}'s challenge`} in ${ladder.name}. Agree a time with ${other.coach}: play by ${ch.deadline.slice(0, 10)}, or the game is discarded (no penalty).`,
      link: proposeLink(lg.id, ladder.id, fixture.id), from: who.coach, subject: `${label} · ${ladder.name}`, action: true,
    });
  }
  return res(200, {
    challenge: challengeView(deps.store.season(lg.id, ladder.id)!, ch, now, who.coach, lg),
    fixture: { id: fixture.id, ref: `league:${lg.id}:${ladder.id}:${fixture.id}`, deadline: ch.deadline },
  });
}

// ---- scheduled rounds --------------------------------------------------------------------------------------------------------

async function createRound(league: LeagueRecord, ladderId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date): Promise<LeagueApiResult> {
  const w = await organiserWrite(league, ladderId, auth, deps);
  if ("result" in w) return w.result!;
  now = w.now; // the time of the write: taken after the body arrived, never before (a slow body cannot slip past an expiry)
  const { input, league: lg } = w;
  const ladder = w.ladder!;
  if (ladderState(ladder) !== "active") return fail(409, "Rounds can be set while the ladder is open.");
  const extra = Object.keys(input).filter((k) => !["name", "deadline", "pairs"].includes(k));
  if (extra.length) return fail(400, `Unknown field: ${extra[0]!.slice(0, 40)}.`);
  const number = (ladder.ladder!.rounds.at(-1)?.number ?? 0) + 1;
  const name = input.name === undefined || input.name === null || input.name === "" ? `Round ${number}` : parseLadderName(input.name);
  let deadline: string | undefined;
  if (input.deadline !== undefined && input.deadline !== null && input.deadline !== "") {
    const t = typeof input.deadline === "string" ? Date.parse(input.deadline) : NaN;
    if (!Number.isFinite(t) || t <= now.getTime() || t > now.getTime() + 366 * DAY_MS) return fail(400, "The deadline must be a date in the coming year.", { field: "deadline" });
    deadline = new Date(t).toISOString();
  }
  if (!Array.isArray(input.pairs) || !input.pairs.length || input.pairs.length > ROUND_PAIRS_MAX) return fail(400, `Give 1 to ${ROUND_PAIRS_MAX} matches.`, { field: "pairs" });
  const members = activeMembers(ladder, supersededTeams(deps.store.competitions(lg.id)));
  const byId = new Map(members.map((m) => [m.team.id, m.team] as const));
  const used = new Set<string>();
  const pairs: Array<[LeagueTeam, LeagueTeam]> = [];
  for (const [i, p] of (input.pairs as unknown[]).entries()) {
    const o = p as Record<string, unknown> | null;
    const home = o && typeof o.home === "string" ? byId.get(o.home) : undefined;
    const away = o && typeof o.away === "string" ? byId.get(o.away) : undefined;
    if (!home || !away) return fail(400, "Every match needs two teams of the ladder.", { field: `pairs[${i}]` });
    if (home.id === away.id) return fail(400, "A team can't play itself.", { field: `pairs[${i}]` });
    if (used.has(home.id) || used.has(away.id)) return fail(400, `${used.has(home.id) ? home.name : away.name} is in two matches of this round.`, { field: `pairs[${i}]` });
    used.add(home.id); used.add(away.id);
    pairs.push([home, away]);
  }
  const roundId = newLadderId("lr");
  const fixtures = pairs.map(([h, a], i) => roundFixture(ladder, roundId, number, i + 1, h, a, deadline));
  // ids are unique across the batch (roundFixture checks the stored list only)
  const ids = new Set<string>(ladder.fixtures.map((f) => f.id));
  for (const f of fixtures) { while (ids.has(f.id)) f.id = newLadderId("lf"); ids.add(f.id); }
  const round: LadderRound = { id: roundId, number, name, ...(deadline ? { deadline } : {}), fixtureIds: fixtures.map((f) => f.id), createdAt: now.toISOString() };
  ladder.fixtures.push(...fixtures);
  ladder.ladder!.rounds.push(round);
  deps.store.putSeason(ladder);
  for (const f of fixtures) {
    for (const side of [f.home, f.away]) {
      tell(deps, side.coachId, {
        type: "ladder", title: `${ladder.name} ${name}: ${f.home.team} v ${f.away.team}`,
        body: `The organisers scheduled this game${deadline ? `: play by ${deadline.slice(0, 10)}` : ""}. Propose a time to your opponent.`,
        link: proposeLink(lg.id, ladder.id, f.id), subject: `${f.home.team} v ${f.away.team} · ${ladder.name}`, action: true,
      });
    }
  }
  return res(201, { round: { ...round, fixtures } });
}

// ---- moving a team back to a season ----------------------------------------------------------------------------------------

async function moveToSeason(league: LeagueRecord, ladderId: string, teamId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, now: Date): Promise<LeagueApiResult> {
  const w = await organiserWrite(league, ladderId, auth, deps);
  if ("result" in w) return w.result!;
  now = w.now; // the time of the write: taken after the body arrived, never before (a slow body cannot slip past an expiry)
  const { input, league: lg, who } = w;
  const ladder = w.ladder!;
  const comps = deps.store.competitions(lg.id);
  const member = activeMembers(ladder, supersededTeams(comps)).find((m) => m.team.id === teamId);
  if (!member) return fail(404, "That team is not in the ladder.");
  if (typeof input.seasonId !== "string") return fail(400, "Pick the season to move the team to.", { field: "seasonId" });
  const target = deps.store.season(lg.id, input.seasonId);
  if (!target || isLadder(target)) return fail(404, "Season not found.", { field: "seasonId" });
  if (target.status === "completed") return fail(409, "That season is finished.");
  const busy = openWork(ladder, teamId, now);
  if (busy) return fail(409, busy, { code: "busy" });
  const at = now.toISOString();
  // The season write first (its movedFrom makes the ladder row superseded, ladder.ts), then the ladder's own record.
  const refused = moveRefusal(ladder);
  if (refused) return fail(409, refused, { code: "tournament-style" });
  const copy = copyTeamForMove(member.team, target, { kind: "ladder", id: ladder.id }, at, teamGamesPlayed(ladder, teamId));
  target.teams.push(copy);
  target.participants.push({ coach: copy.coach, ...(copy.coachId ? { coachId: copy.coachId } : {}), ...(copy.coachAssigned && !copy.coachAssigned.cleared ? { coachAssigned: true as const } : {}), country: "", race: copy.race, team: copy.name, registeredAt: at, active: true, teamId: copy.id, addedHere: true });
  deps.store.putSeason(target);
  const fresh = deps.store.season(lg.id, ladder.id)!;
  const m = fresh.ladder!.members.find((x) => x.teamId === teamId);
  if (m) { m.leftAt = at; m.movedTo = { kind: "season", id: target.id, teamId: copy.id }; }
  const row = (fresh.registrations ?? []).find((r) => r.teamId === teamId && r.state === "accepted");
  if (row) {
    row.state = "withdrawn";
    row.registrationLog = [...row.registrationLog, { action: "withdraw", from: "accepted", to: "withdrawn", by: who.coach, at, reason: `Moved to ${target.name}` }];
  }
  deps.store.putSeason(fresh);
  tell(deps, teamAccount(member.team), { type: "ladder", title: `${member.team.name} moved to ${target.name}`, body: `The organisers moved your team from ${ladder.name} to ${target.name}, with its progression.`, link: `/app/leagues/${enc(lg.id)}?season=${enc(target.id)}&tab=teams`, from: who.coach, subject: lg.name });
  return res(200, { ok: true, teamId: copy.id, seasonId: target.id });
}


// ---- titles (ladderTitles.ts) -------------------------------------------------------------------------------------------------

/** Sends the title rules' notes (after the write). */
function sendTitleNotes(deps: LeagueApiDeps, lg: LeagueRecord, ladder: SeasonRecord, notes: readonly TitleNote[], from?: string): void {
  for (const n of notes) {
    const fixtureId = n.propose ? n.propose.split(":")[3] : undefined;
    tell(deps, n.coach, { type: "ladder", title: n.title, body: n.body, link: fixtureId ? proposeLink(lg.id, ladder.id, fixtureId) : ladderLink(lg.id, ladder.id), subject: `${lg.name} ${ladder.name}`, ...(n.propose ? { action: true } : {}), ...(from ? { from } : {}) });
  }
}
export { sendTitleNotes };

type TitleFn = (ctx: TitleTickContext, input: Record<string, unknown>, who: LeagueApiIdentity) => string | void;

/**
 * A title write: the body, the league and ladder as they are now (organiser routes need an organiser; coach routes a session),
 * the action, then the title rules (titleTick) in the SAME write, then the notes. Answers the Ladder tab's titles part.
 */
async function titleWrite(league: LeagueRecord, ladderId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps, organiser: boolean, fn: TitleFn): Promise<LeagueApiResult> {
  const w = organiser ? await organiserWrite(league, ladderId, auth, deps) : await coachWrite(league, ladderId, auth, deps);
  if ("result" in w) return w.result!;
  const { input, league: lg, who, now } = w;
  const ladder = w.ladder!;
  if (ladderState(ladder) !== "active") return fail(409, ladderState(ladder) === "closed" ? "The ladder is closed." : "The ladder has not started yet.");
  const ctx: TitleTickContext = { league: lg, ladder, competitions: deps.store.competitions(lg.id).map((c) => (c.id === ladder.id ? ladder : c)), now, notes: [] };
  const done = fn(ctx, input, who);
  safeTitleTick(ctx);
  deps.store.putSeason(ladder);
  sendTitleNotes(deps, lg, ladder, ctx.notes, who.coach);
  const saved = deps.store.season(lg.id, ladder.id) ?? ladder;
  return res(200, { ok: true, ...(done ? { notice: done } : {}), titles: titleView(lg, saved, now, who.coach, managesLeague(lg, who)) });
}

const noteText = (v: unknown, field: string): string => {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string" || [...v.trim()].length > 200) throw new LadderError(400, `${field} must be text of at most 200 characters.`, field);
  return v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
};

function titleAction(league: LeagueRecord, ladderId: string, verb: "vacate" | "crown" | "inactive" | "return", auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  return titleWrite(league, ladderId, auth, deps, true, (ctx, input) => {
    const rec = ctx.ladder.ladder!;
    if (!beltOn(rec)) throw new LadderError(409, "This ladder has no belt.");
    const state = titleReplay(ctx.ladder, ctx.now);
    const at = ctx.now.toISOString();
    const t = titlesOf(rec);
    const id = newLadderId("te");
    const name = (tid?: string) => ctx.ladder.teams.find((x) => x.id === tid)?.name ?? "A team";
    if (verb === "vacate") {
      if (!state.holder) throw new LadderError(409, "The belt is already vacant.");
      const reason = noteText(input.reason, "reason") || "by the organisers";
      t.events.push({ id, kind: "vacated", at, by: "organiser", reason });
      const holder = ctx.ladder.teams.find((x) => x.id === state.holder!.teamId);
      ctx.notes.push({ coach: holder ? teamAccount(holder) : "", title: `${league.name} ${ctx.ladder.name}: the title was vacated`, body: `The organisers vacated the belt (${reason}).` });
      return "The belt is vacant.";
    }
    if (verb === "crown") {
      const members = activeMembers(ctx.ladder, supersededTeams(ctx.competitions));
      const team = members.find((m) => m.team.id === input.teamId)?.team;
      if (!team) throw new LadderError(404, "That team is not in the ladder.", "teamId");
      if (state.holder?.teamId === team.id && !state.inactiveSince) throw new LadderError(409, `${team.name} already holds the belt.`);
      t.events.push({ id, kind: "crowned", teamId: team.id, at, by: "organiser", reason: noteText(input.reason, "reason") || "organiser" });
      return `${team.name} holds the belt.`;
    }
    if (verb === "inactive") {
      if (!state.holder) throw new LadderError(409, "The belt is vacant.");
      if (state.inactiveSince) throw new LadderError(409, "The champion is already marked inactive.");
      t.events.push({ id, kind: "inactive", at, by: "organiser", reason: noteText(input.reason, "reason") || "marked inactive" });
      return `${name(state.holder.teamId)} is marked inactive: the top two contenders play for the interim belt.`;
    }
    if (!state.holder || !state.inactiveSince) throw new LadderError(409, "The champion is not marked inactive.");
    t.events.push({ id, kind: "returned", at, by: "organiser", reason: "returned" });
    return state.interim ? "The champion is back: the unification game is scheduled." : "The champion is back.";
  });
}

function boutAction(league: LeagueRecord, ladderId: string, boutId: string, verb: "extend" | "cancel", auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  return titleWrite(league, ladderId, auth, deps, true, (ctx, input) => {
    const bout = ctx.ladder.ladder?.titles?.bouts.find((b) => b.id === boutId);
    if (!bout) throw new LadderError(404, "Title game not found.");
    if (bout.state !== "scheduled") throw new LadderError(409, "This title game is no longer scheduled.");
    if (verb === "cancel") {
      cancelBout(ctx.ladder, bout, ctx.now.toISOString(), noteText(input.reason, "reason") || "Called off by the organisers.");
      return "Title game called off.";
    }
    if (typeof input.days !== "number" || !Number.isInteger(input.days) || input.days < 1 || input.days > 60) throw new LadderError(400, "days must be a whole number from 1 to 60.", "days");
    const deadline = new Date(Math.max(Date.parse(bout.deadline), ctx.now.getTime()) + input.days * DAY_MS).toISOString();
    bout.deadline = deadline;
    const f = ctx.ladder.fixtures.find((x) => x.id === bout.fixtureId);
    if (f) f.deadline = deadline;
    for (const id of [bout.homeTeamId, bout.awayTeamId]) {
      const t = ctx.ladder.teams.find((x) => x.id === id);
      if (t) ctx.notes.push({ coach: teamAccount(t), title: `${league.name} ${ctx.ladder.name}: more time for a title game`, body: `The organisers moved the deadline to ${deadline.slice(0, 10)}.` });
    }
    return `New deadline ${deadline.slice(0, 10)}.`;
  });
}

function contractAward(league: LeagueRecord, ladderId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  return titleWrite(league, ladderId, auth, deps, true, (ctx, input) => {
    for (const k of Object.keys(input)) if (k !== "teamId" && k !== "note") throw new LadderError(400, `Unknown field: ${k.slice(0, 40)}.`);
    if (typeof input.teamId !== "string") throw new LadderError(400, "Pick a team.", "teamId");
    const c = awardContract(ctx, input.teamId, noteText(input.note, "note"));
    return `Contract given to ${ctx.ladder.teams.find((x) => x.id === c.teamId)?.name ?? "the team"}.`;
  });
}

function contractCashIn(league: LeagueRecord, ladderId: string, contractId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  return titleWrite(league, ladderId, auth, deps, false, (ctx, _input, who) => {
    const c = ctx.ladder.ladder?.titles?.contracts.find((x) => x.id === contractId);
    if (!c) throw new LadderError(404, "Contract not found.");
    const team = ctx.ladder.teams.find((x) => x.id === c.teamId);
    if (!team || !ownsTeam(team, who.coach)) throw new LadderError(403, "Only the contract's coach can cash it in.");
    cashIn(ctx, contractId);
    return "Cashed in: the champion can't decline. Agree a time now.";
  });
}

function rumbleCreate(league: LeagueRecord, ladderId: string, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  return titleWrite(league, ladderId, auth, deps, true, (ctx, input, who) => {
    const ru = createRumble(ctx.ladder, input, who.coach, ctx.now);
    const members = activeMembers(ctx.ladder, supersededTeams(ctx.competitions));
    for (const m of members) ctx.notes.push({ coach: teamAccount(m.team), title: `${league.name} ${ctx.ladder.name}: ${ru.name} on ${ru.date.slice(0, 10)}`, body: ru.field === "top8" ? "The top 8 of the ranking on that day play a quick knockout. The winner gets a guaranteed title shot." : "Enter from the Ladder tab before the date. The winner gets a guaranteed title shot." });
    return `${ru.name} set for ${ru.date.slice(0, 10)}.`;
  });
}

function rumbleAction(league: LeagueRecord, ladderId: string, rumbleId: string, verb: "enter" | "withdraw" | "cancel", auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  return titleWrite(league, ladderId, auth, deps, verb === "cancel", (ctx, input, who) => {
    const ru = ctx.ladder.ladder?.rumbles?.find((r) => r.id === rumbleId);
    if (!ru) throw new LadderError(404, "Rumble not found.");
    if (verb === "cancel") {
      if (ru.state !== "entry" && ru.state !== "running") throw new LadderError(409, "This Rumble is over.");
      ru.state = "cancelled";
      ru.note = "Called off by the organisers.";
      for (const r of ru.rounds) for (const m of r.matches) if (!m.winnerTeamId && m.fixtureId) {
        const f = ctx.ladder.fixtures.find((x) => x.id === m.fixtureId);
        if (f && fixtureOpen(f)) f.deadlineOutcome = { outcome: "no-result", auto: true, at: ctx.now.toISOString() };
      }
      return `${ru.name} called off.`;
    }
    if (ru.field !== "open") throw new LadderError(409, "The top 8 play this Rumble: there is no entry.");
    if (ru.state !== "entry" || ctx.now.getTime() >= Date.parse(ru.date)) throw new LadderError(409, "Entry for this Rumble has closed.");
    const members = activeMembers(ctx.ladder, supersededTeams(ctx.competitions));
    const team = members.find((m) => m.team.id === input.teamId)?.team;
    if (!team) throw new LadderError(404, "That team is not in the ladder.", "teamId");
    if (!ownsTeam(team, who.coach)) throw new LadderError(403, "Only the team's coach can enter it.");
    if (verb === "enter") {
      if (ru.entries.includes(team.id)) throw new LadderError(409, `${team.name} is already entered.`);
      if (ru.entries.length >= 64) throw new LadderError(409, "The Rumble is full.");
      ru.entries.push(team.id);
      return `${team.name} is in ${ru.name}.`;
    }
    if (!ru.entries.includes(team.id)) throw new LadderError(409, `${team.name} is not entered.`);
    ru.entries = ru.entries.filter((x) => x !== team.id);
    return `${team.name} withdrew from ${ru.name}.`;
  });
}

// ---- the Current Champions panel ------------------------------------------------------------------------------------------------

/**
 * GET /api/leagues/:id/champions (public, the league's visibility): cups = the latest finished season's champion, plus each
 * division's winner when that season's table had divisions; belts = every open belt ladder's champion with days held and
 * defences (and the interim champion). The panel hides an empty part, and itself when both are empty.
 */
export function leagueChampionsRoute(method: string, rest: string[], league: LeagueRecord | undefined, deps: LeagueApiDeps): LeagueApiResult | undefined {
  if (rest[0] !== "champions" || rest.length !== 1) return undefined;
  if (method !== "GET" && method !== "HEAD") return fail(405, "Use GET.");
  if (!league) return fail(404, "League not found.");
  const now = deps.now?.() ?? new Date();
  const seasons = deps.store.seasons(league.id);
  const cups: Array<{ seasonId: string; seasonName: string; label: string; division?: string; team: string; coach: string; race: string; teamId?: string }> = [];
  const latest = seasons.filter((s) => s.status === "completed").sort((a, b) => b.number - a.number)[0];
  if (latest) {
    const card = hallOfFame([latest])[0];
    if (card?.champion) cups.push({ seasonId: latest.id, seasonName: latest.name, label: "Champion", team: card.champion.team, coach: card.champion.coach, race: card.champion.race, ...(card.champion.teamId ? { teamId: card.champion.teamId } : {}) });
    const table = deriveStandings(latest).find((p) => p.format !== "knockout" && new Set(p.standings.map((r) => r.group)).size > 1);
    for (const g of [...new Set(table?.standings.map((r) => r.group) ?? [])]) {
      const top = table!.standings.filter((r) => r.group === g).sort((a, b) => a.rank - b.rank)[0];
      if (top && top.played > 0) cups.push({ seasonId: latest.id, seasonName: latest.name, label: `${g || "Division"} winner`, division: g, team: top.team, coach: top.coach, race: top.race, ...(top.teamId ? { teamId: top.teamId } : {}) });
    }
  }
  const belts = beltHolders(deps.store.ladders(league.id), now);
  return res(200, { cups, belts }, { "cache-control": "no-store" });
}

export type { LadderRankRow };
export { ladderView as ladderReadModel, ladderRedraftRules };
