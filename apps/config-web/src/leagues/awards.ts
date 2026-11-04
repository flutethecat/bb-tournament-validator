/**
 * League awards and the Hall of Fame (spec-main-landing-nav-2026-10-29 §2 items 3-4; rulings §6(c), §7).
 *
 * Two kinds of award show in one list:
 *   - season awards: the podium Finish season writes (season.awards, `podium: true`) and the TourPlay import's awards and
 *     honorary awards. They live with their season and are never changed here: the podium follows Reopen.
 *   - custom awards an organiser of the league (or a site admin) gives: league.awards[] { id, title, icon, toCoach?,
 *     toCoachId?, toTeam?, teamId?, race?, seasonId?, note, by, at }. Only these can be removed here.
 *
 * The Hall of Fame is computed (one card per finished season: champion, runner-up, consolation, dates, from the podium or
 * imported awards) plus organiser-curated pins (league.hallOfFame[]: a season champion, an award or a free-text record,
 * with an optional note), kept in the stored order.
 *
 *   GET    /api/leagues/:id/honours                         public: { hallOfFame, pins, awards, revision, icons, recipients? (organisers) }
 *   POST   /api/leagues/:id/awards                          { revision, title, icon, recipient, seasonId?, note? } organisers + admins
 *          recipient = { kind: "team", seasonId, teamId } | { kind: "coach", coachId } (an account id, never a display name)
 *   DELETE /api/leagues/:id/awards/:awardId                 { revision } (custom awards only)
 *   POST   /api/leagues/:id/hall-of-fame/pins               { revision, kind: champion|award|record, seasonId?, awardId?, text?, note? }
 *   DELETE /api/leagues/:id/hall-of-fame/pins/:pinId        { revision }
 *   PUT    /api/leagues/:id/hall-of-fame/order              { revision, order: pinId[] } (a permutation of the pins)
 *   GET    /api/leagues?awards=mine                         the signed-in coach's awards in every league (coach page)
 *
 * Every write names league.honoursRevision as last read (body.revision or If-Match): 428 missing, 409 stale. Its own
 * counter, so giving an award never makes an open League settings page stale. CSRF and the onboarding gate (428) run in
 * front of every /api write (server.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { readJsonObject, requestRevision } from "./http.js";
import { PODIUM_AWARD } from "./standings.js";
import { isLeagueOrganiser, type LeagueStore } from "./store.js";
import type { HallOfFamePin, LeagueAward, LeagueCustomAward, LeagueRecord, SeasonRecord } from "./types.js";
import { publishedLeagues } from "./lifecycle.js";
import { isLadder } from "./ladder.js";
import { ladderHonourAwards } from "./ladderTitles.js";

export const HONOURS_MAX_BYTES = 16 * 1024;
export const AWARDS_MAX = 500;
export const PINS_MAX = 30;
export const AWARD_TITLE_MAX = 60;
export const AWARD_NOTE_MAX = 280;
export const RECORD_TEXT_MAX = 120;
const NO_STORE = { "cache-control": "private, no-store" };

/**
 * The award icons: our own icon set only (public/icons; asset-provenance law). Keys are stored on the award; the SPA
 * keeps the same table (spa/src/leagues/honours.ts AWARD_ICONS, checked equal by test/leagueAwards.test.ts).
 */
export const AWARD_ICONS: Readonly<Record<string, { label: string; src: string }>> = {
  legend: { label: "Legend", src: "/icons/coach-badges/legend-retro.png" },
  "mega-star": { label: "Mega star", src: "/icons/coach-badges/mega-star-retro.png" },
  "super-star": { label: "Super star", src: "/icons/coach-badges/super-star-retro.png" },
  star: { label: "Star", src: "/icons/coach-badges/star-retro.png" },
  "emerging-star": { label: "Emerging star", src: "/icons/coach-badges/emerging-star-retro.png" },
  veteran: { label: "Veteran", src: "/icons/coach-badges/veteran-retro.png" },
  experienced: { label: "Experienced", src: "/icons/coach-badges/experienced-retro.png" },
  rookie: { label: "Rookie", src: "/icons/coach-badges/rookie-retro.png" },
  captain: { label: "Captain", src: "/icons/builder/team-captain-gold-48.png" },
  fans: { label: "Fans", src: "/icons/ui/dedicated_fans.png" },
  helmet: { label: "Helmet", src: "/icons/ui/football-helmet.png" },
  apothecary: { label: "Apothecary", src: "/icons/ui/apothecary.png" },
  foul: { label: "Foul", src: "/icons/ui/action-foul.png" },
  pass: { label: "Pass", src: "/icons/skills/pass.png" },
  catch: { label: "Catch", src: "/icons/skills/catch.png" },
  block: { label: "Block", src: "/icons/skills/block.png" },
  "mighty-blow": { label: "Mighty blow", src: "/icons/skills/mightyblow.png" },
  dodge: { label: "Dodge", src: "/icons/skills/dodge.png" },
  guard: { label: "Guard", src: "/icons/skills/guard.png" },
  leader: { label: "Leader", src: "/icons/skills/leader.png" },
};
export const isAwardIcon = (v: unknown): v is string => typeof v === "string" && Object.prototype.hasOwnProperty.call(AWARD_ICONS, v);

/** The icon a season award shows (podium places by slot; every other imported award a star). */
export const seasonAwardIcon = (a: Pick<LeagueAward, "type">): string =>
  a.type === PODIUM_AWARD.champion ? "legend" : a.type === PODIUM_AWARD.runnerUp ? "super-star" : a.type === PODIUM_AWARD.consolation ? "star" : "emerging-star";

// ---- read model ----------------------------------------------------------------------------------------------------

export type AwardSource = "podium" | "imported" | "custom";

export interface AwardView {
  id: string;
  source: AwardSource;
  title: string;
  icon: string;
  toCoach?: string;
  toTeam?: string;
  teamId?: string;
  race?: string;
  seasonId?: string;
  seasonName?: string;
  note: string;
  by?: string;
  at?: string;
  /** The season champion (the golden star). */
  star: boolean;
}

export interface HallPlace { team: string; coach: string; race: string; teamId?: string }

export interface HallSeason {
  seasonId: string;
  number: number;
  name: string;
  ruleset: string;
  startedAt?: string;
  endedAt?: string;
  champion?: HallPlace;
  runnerUp?: HallPlace;
  consolation?: HallPlace;
  /** Where the podium came from: crowned on this site (Finish season) or the TourPlay import. */
  source: "podium" | "imported" | "none";
}

export interface PinView extends HallOfFamePin {
  /** What the pin points at now; unset = the season champion / award is no longer recorded (organisers may remove it). */
  resolved?: { title: string; team?: string; coach?: string; race?: string; seasonName?: string; icon?: string };
}

export interface HonoursRecipients {
  seasons: Array<{ id: string; name: string; number: number }>;
  teams: Array<{ seasonId: string; id: string; name: string; race: string; coach: string }>;
  /** Coaches with a fork account only (id = the account): a coach without one is reached through their team. */
  coaches: Array<{ id: string; name: string; seasonIds: string[] }>;
}

export interface HonoursView {
  revision: number;
  hallOfFame: HallSeason[];
  pins: PinView[];
  awards: AwardView[];
  recipients?: HonoursRecipients;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const key = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * A season award's id, from fields account deletion never rewrites (coach names are left out, so a Hall of Fame pin
 * survives anonymisation). Podium places: season + slot type + team (a re-crowned podium with another team is another
 * award). Imported awards: season + position among the season's non-podium awards + category + type + name + team, so
 * two otherwise equal rows never share an id.
 */
export const seasonAwardId = (seasonId: string, a: Pick<LeagueAward, "category" | "type" | "name" | "team" | "podium">, index: number): string =>
  `s-${sha(a.podium ? `${seasonId}\0podium\0${a.type}\0${a.team}` : `${seasonId}\0${index}\0${a.category}\0${a.type}\0${a.name}\0${a.team}`).slice(0, 24)}`;

/** The ids of a season's awards, in season.awards order (index = position among the non-podium awards). */
export function seasonAwardIds(s: Pick<SeasonRecord, "id" | "awards">): string[] {
  let n = 0;
  return s.awards.map((a) => seasonAwardId(s.id, a, a.podium ? -1 : n++));
}

const seasonAt = (s: SeasonRecord): string | undefined => s.podium?.at ?? s.endedAt ?? s.importedAt;

/**
 * A competition's award rows with their ids: a season's stored awards, or a ladder's honours (ladderTitles.ts: the stored period
 * and final places plus every finished reign, derived), whose ids come from their stable keys.
 */
export function competitionAwards(s: SeasonRecord, now = new Date()): Array<{ id: string; award: LeagueAward }> {
  if (isLadder(s)) return ladderHonourAwards(s, now).map((a, i) => ({ id: `l-${sha(`${s.id}\0${a.key ?? i}`).slice(0, 24)}`, award: a }));
  const ids = seasonAwardIds(s);
  return s.awards.map((a, i) => ({ id: ids[i]!, award: a }));
}
const seasonsOnly = (list: readonly SeasonRecord[]): SeasonRecord[] => list.filter((s) => !isLadder(s));

/** The season awards and the custom awards, newest first. */
export function awardList(league: Pick<LeagueRecord, "awards">, seasons: readonly SeasonRecord[]): AwardView[] {
  const names = new Map(seasons.map((s) => [s.id, s.name]));
  const out: Array<AwardView & { n: number }> = [];
  for (const s of seasons) {
    const at = seasonAt(s);
    for (const { id, award: a } of competitionAwards(s)) {
      out.push({
        id, source: a.podium ? "podium" : "imported", title: a.type === "Honorary award" ? a.name || a.type : a.type,
        icon: seasonAwardIcon(a), ...(a.coach ? { toCoach: a.coach } : {}), ...(a.team ? { toTeam: a.team } : {}), ...(a.race ? { race: a.race } : {}),
        seasonId: s.id, seasonName: s.name, note: a.description ?? "", ...(a.at ?? at ? { at: a.at ?? at } : {}), star: a.goldenStar === true, n: s.number,
      });
    }
  }
  const number = new Map(seasons.map((s) => [s.id, s.number]));
  for (const a of league.awards ?? []) {
    out.push({
      id: a.id, source: "custom", title: a.title, icon: isAwardIcon(a.icon) ? a.icon : "star",
      ...(a.toCoach ? { toCoach: a.toCoach } : {}), ...(a.toTeam ? { toTeam: a.toTeam } : {}), ...(a.teamId ? { teamId: a.teamId } : {}), ...(a.race ? { race: a.race } : {}),
      ...(a.seasonId ? { seasonId: a.seasonId, ...(names.has(a.seasonId) ? { seasonName: names.get(a.seasonId)! } : {}) } : {}),
      note: a.note, by: a.by, at: a.at, star: false, n: a.seasonId ? number.get(a.seasonId) ?? 0 : 0,
    });
  }
  out.sort((x, y) => (y.at ?? "").localeCompare(x.at ?? "") || y.n - x.n || x.title.localeCompare(y.title));
  return out.map(({ n: _n, ...a }) => a);
}

const placeOf = (a: LeagueAward | undefined, teamId?: string): HallPlace | undefined =>
  a ? { team: a.team, coach: a.coach, race: a.race, ...(teamId ? { teamId } : {}) } : undefined;

/** One card per finished season, newest first: the podium (crowned here) or the imported places. */
export function hallOfFame(seasons: readonly SeasonRecord[]): HallSeason[] {
  return seasonsOnly(seasons).filter((s) => s.status === "completed").sort((a, b) => b.number - a.number).map((s) => {
    const podium = s.awards.filter((a) => a.podium);
    const pool = podium.length ? podium : s.awards.filter((a) => !a.podium);
    const pick = (type: string): LeagueAward | undefined => pool.find((a) => a.type === type);
    const ref = (slot: "champion" | "runnerUp" | "consolation"): string | undefined => {
      const r = s.podium?.final[slot];
      return r && !r.startsWith("name:") ? r : undefined;
    };
    const champion = placeOf(pick(PODIUM_AWARD.champion), ref("champion"));
    const runnerUp = placeOf(pick(PODIUM_AWARD.runnerUp), ref("runnerUp"));
    const consolation = placeOf(pick(PODIUM_AWARD.consolation), ref("consolation"));
    const source: HallSeason["source"] = !champion && !runnerUp && !consolation ? "none" : podium.length ? "podium" : "imported";
    return {
      seasonId: s.id, number: s.number, name: s.name, ruleset: s.ruleset, ...(s.startedAt ? { startedAt: s.startedAt } : {}), ...(s.endedAt ? { endedAt: s.endedAt } : {}),
      ...(champion ? { champion } : {}), ...(runnerUp ? { runnerUp } : {}), ...(consolation ? { consolation } : {}), source,
    };
  });
}

function resolvePins(pins: readonly HallOfFamePin[], hall: HallSeason[], awards: AwardView[]): PinView[] {
  return pins.map((p) => {
    if (p.kind === "record") return { ...p, resolved: { title: p.text ?? "" } };
    if (p.kind === "champion") {
      const card = hall.find((h) => h.seasonId === p.seasonId);
      const c = card?.champion;
      return c ? { ...p, resolved: { title: "Champion", team: c.team, coach: c.coach, race: c.race, seasonName: card!.name, icon: "legend" } } : { ...p };
    }
    const a = awards.find((x) => x.id === p.awardId);
    return a ? { ...p, resolved: { title: a.title, ...(a.toTeam ? { team: a.toTeam } : {}), ...(a.toCoach ? { coach: a.toCoach } : {}), ...(a.race ? { race: a.race } : {}), ...(a.seasonName ? { seasonName: a.seasonName } : {}), icon: a.icon } } : { ...p };
  });
}

/** Teams and coaches an award may go to (managers only): every season's teams and participants. */
export function honoursRecipients(seasons: readonly SeasonRecord[]): HonoursRecipients {
  const ordered = seasonsOnly(seasons).sort((a, b) => b.number - a.number);
  const coaches = new Map<string, { id: string; name: string; seasonIds: string[] }>();
  const addCoach = (name: string | undefined, account: string | undefined, seasonId: string): void => {
    const id = (account ?? "").trim();
    if (!id) return;
    const k = key(id);
    const c = coaches.get(k) ?? { id, name: (name ?? "").trim() || id, seasonIds: [] };
    if (!c.seasonIds.includes(seasonId)) c.seasonIds.push(seasonId);
    coaches.set(k, c);
  };
  const teams: HonoursRecipients["teams"] = [];
  for (const s of ordered) {
    for (const t of s.teams) { teams.push({ seasonId: s.id, id: t.id, name: t.name, race: t.race, coach: t.coach }); addCoach(t.coach, t.coachId, s.id); }
    for (const p of s.participants) addCoach(p.coach, p.coachId, s.id);
  }
  return {
    seasons: ordered.map((s) => ({ id: s.id, name: s.name, number: s.number })),
    teams,
    coaches: [...coaches.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const isManager = (league: LeagueRecord, auth: LeagueApiIdentity | undefined): boolean => Boolean(auth && (auth.admin || isLeagueOrganiser(league, auth.coach)));

export function honoursView(league: LeagueRecord, seasons: readonly SeasonRecord[], auth: LeagueApiIdentity | undefined): HonoursView {
  const hall = hallOfFame(seasons);
  const awards = awardList(league, seasons);
  return {
    revision: league.honoursRevision ?? 0,
    hallOfFame: hall,
    pins: resolvePins(league.hallOfFame ?? [], hall, awards),
    awards,
    ...(isManager(league, auth) ? { recipients: honoursRecipients(seasons) } : {}),
  };
}

/** The signed-in coach's awards in every league (custom awards to their account, season awards linked to it), newest first. */
export function myAwards(store: LeagueStore, coach: string): Array<AwardView & { leagueId: string; leagueName: string }> {
  const me = key(coach);
  if (!me) return [];
  const out: Array<AwardView & { leagueId: string; leagueName: string }> = [];
  for (const league of publishedLeagues(store.list())) {
    // Seasons and ladders (a ladder's honours: period / final places and reigns).
    const seasons = store.competitions(league.id).filter((s) => !isLadder(s) || s.stage !== "setup");
    const mine = new Set<string>();
    for (const s of seasons) for (const { id, award } of competitionAwards(s)) if (key(award.coachId) === me) mine.add(id);
    for (const a of league.awards ?? []) if (key(a.toCoachId) === me) mine.add(a.id);
    if (!mine.size) continue;
    for (const a of awardList(league, seasons)) if (mine.has(a.id)) out.push({ ...a, leagueId: league.id, leagueName: league.name });
  }
  out.sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""));
  return out.slice(0, 50);
}

// ---- writes ---------------------------------------------------------------------------------------------------------

export class HonoursError extends Error {
  constructor(readonly status: number, message: string, readonly field?: string) { super(message); }
}

/** Award text: control characters folded to spaces, trimmed, length-capped (also the tournament awards' check). */
export const text = (v: unknown, field: string, max: number, required: boolean, label: string): string => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HonoursError(400, `${label} is required.`, field);
    return "";
  }
  if (typeof v !== "string") throw new HonoursError(400, `${label} must be text.`, field);
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (required && !t) throw new HonoursError(400, `${label} is required.`, field);
  if (t.length > max) throw new HonoursError(400, `${label} must be at most ${max} characters.`, field);
  return t;
};

type Recipient = Pick<LeagueCustomAward, "toCoach" | "toCoachId" | "toTeam" | "teamId" | "race">;

/**
 * Validates { kind: "team", seasonId, teamId } | { kind: "coach", coachId } against the league's seasons. A coach is
 * resolved only by the exact account id on the league's team / participant rows, never by a display name (two coaches
 * may show the same name).
 */
export function parseRecipient(input: unknown, seasons: readonly SeasonRecord[], scope: string | undefined): Recipient {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HonoursError(400, "Pick who receives the award.", "recipient");
  const r = input as Record<string, unknown>;
  if (r.kind === "team") {
    const sid = typeof r.seasonId === "string" ? r.seasonId : "";
    if (scope && sid !== scope) throw new HonoursError(400, "Pick a team of that season.", "recipient");
    const season = seasons.find((s) => s.id === sid);
    const team = season?.teams.find((t) => t.id === r.teamId);
    if (!season || !team) throw new HonoursError(400, "Pick a team of this league.", "recipient");
    return {
      toTeam: team.name, teamId: team.id, ...(team.race ? { race: team.race } : {}),
      ...(team.coach ? { toCoach: team.coach } : {}), ...(team.coachId ? { toCoachId: team.coachId } : {}),
    };
  }
  if (r.kind === "coach") {
    const want = typeof r.coachId === "string" ? key(r.coachId) : "";
    if (!want) throw new HonoursError(400, "Pick a coach of this league (by account).", "recipient");
    for (const s of [...seasons].sort((a, b) => b.number - a.number)) {
      if (scope && s.id !== scope) continue;
      for (const row of [...s.teams, ...s.participants]) {
        if (row.coachId && key(row.coachId) === want) return { toCoach: row.coach || row.coachId, toCoachId: row.coachId };
      }
    }
    throw new HonoursError(400, scope ? "That coach did not play in that season." : "Pick a coach of this league.", "recipient");
  }
  throw new HonoursError(400, "Pick a team or a coach.", "recipient");
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => ({ status, headers: NO_STORE, body: { error, ...extra } });
const ok = (status: number, body: Record<string, unknown>): LeagueApiResult => ({ status, headers: NO_STORE, body });

function gate(league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined): LeagueApiResult | undefined {
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!league) return fail(404, "League not found.");
  if (!isManager(league, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can give awards or edit the Hall of Fame.");
  return undefined;
}

/** The award on the league page's Awards tab (its own tab since the shared section header). */
const awardLink = (leagueId: string, awardId: string): string => `/app/leagues/${encodeURIComponent(leagueId)}?tab=awards#award-${encodeURIComponent(awardId)}`;

/** Routes this module owns (undefined = not one of them). */
export async function leagueHonoursRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, second, third, ...more] = rest;
  const read = method === "GET" || method === "HEAD";
  if (first === "honours" && second === undefined) {
    if (!read) return fail(405, "Use GET.");
    if (!league) return fail(404, "League not found.");
    return ok(200, { ...honoursView(league, honoursCompetitions(deps, league.id), auth) });
  }
  const awards = first === "awards" && third === undefined && more.length === 0;
  const pins = first === "hall-of-fame" && ((second === "pins" && more.length === 0) || (second === "order" && third === undefined && more.length === 0));
  if (!awards && !pins) return undefined;
  if (awards) {
    if (second === undefined && method !== "POST") return fail(405, "POST to /awards to give an award.");
    if (second !== undefined && method !== "DELETE") return fail(405, "Use DELETE.");
  } else if (second === "pins") {
    if (third === undefined && method !== "POST") return fail(405, "POST to /hall-of-fame/pins to pin an entry.");
    if (third !== undefined && method !== "DELETE") return fail(405, "Use DELETE.");
  } else if (method !== "PUT") return fail(405, "Use PUT.");

  const early = gate(league, auth);
  if (early) return early;
  const body = await readJsonObject(deps, HONOURS_MAX_BYTES);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const input = body.value;
  // Judged against the league as it is now (after the body arrived); synchronous from here to the write.
  const lg = deps.store.league(league!.id);
  const refused = gate(lg, auth);
  if (refused || !lg) return refused ?? fail(404, "League not found.");
  const current = lg.honoursRevision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return fail(428, "Send the honours revision you loaded (revision or If-Match).", { revision: current });
  if (asked === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  if (asked !== current) return fail(409, "The awards or Hall of Fame changed since you opened them. Reload to see the latest.", { revision: current });
  const who = auth!;
  const now = (deps.now?.() ?? new Date()).toISOString();
  const seasons = honoursCompetitions(deps, lg.id);
  try {
    if (awards && second === undefined) return giveAward(lg, seasons, who, input, now, deps);
    if (awards) return removeAward(lg, second!, who, deps);
    if (second === "pins" && third === undefined) return addPin(lg, seasons, who, input, now, deps);
    if (second === "pins") return removePin(lg, third!, who, deps);
    return reorderPins(lg, who, input, deps);
  } catch (e) {
    if (e instanceof HonoursError) return fail(e.status, e.message, e.field ? { field: e.field } : {});
    return fail(500, "Could not save that right now.");
  }
}

function write(lg: LeagueRecord, deps: LeagueApiDeps, mutate: (l: LeagueRecord) => void): LeagueRecord {
  return deps.store.updateLeague(lg.id, (l) => { mutate(l); l.honoursRevision = (l.honoursRevision ?? 0) + 1; }, deps.now?.() ?? new Date());
}

function giveAward(lg: LeagueRecord, seasons: SeasonRecord[], who: LeagueApiIdentity, input: Record<string, unknown>, at: string, deps: LeagueApiDeps): LeagueApiResult {
  if ((lg.awards ?? []).length >= AWARDS_MAX) return fail(409, `A league can hold at most ${AWARDS_MAX} awards; remove an old one first.`);
  const title = text(input.title, "title", AWARD_TITLE_MAX, true, "Title");
  if (!isAwardIcon(input.icon)) throw new HonoursError(400, "Pick an icon.", "icon");
  let seasonId: string | undefined;
  if (input.seasonId !== undefined && input.seasonId !== null && input.seasonId !== "") {
    if (typeof input.seasonId !== "string" || !seasons.some((s) => s.id === input.seasonId)) throw new HonoursError(400, "Pick a season of this league.", "seasonId");
    seasonId = input.seasonId;
  }
  const recipient = parseRecipient(input.recipient, seasons, seasonId);
  const note = text(input.note, "note", AWARD_NOTE_MAX, false, "Note");
  const award: LeagueCustomAward = { id: `a-${randomBytes(6).toString("hex")}`, title, icon: input.icon, ...recipient, ...(seasonId ? { seasonId } : {}), note, by: who.coach, at };
  const updated = write(lg, deps, (l) => { l.awards = [...(l.awards ?? []), award]; });
  // The recipient's account hears about it once (never the giver themself).
  const to = award.toCoachId?.trim();
  if (to && key(to) !== key(who.coach)) {
    const season = seasonId ? seasons.find((s) => s.id === seasonId)?.name : undefined;
    const what = award.toTeam ? `${award.toTeam}${season ? ` (${season})` : ""}` : `you${season ? ` (${season})` : ""}`;
    try {
      deps.notify?.(to, { type: "award", title: `${lg.name}: ${title}`.slice(0, 120), body: `${who.coach} gave ${what} the award "${title}".${note ? ` ${note}` : ""}`.slice(0, 400), link: awardLink(lg.id, award.id), from: who.coach });
    } catch { /* fire-and-forget */ }
  }
  const view = honoursView(updated, seasons, who);
  return ok(201, { award: view.awards.find((a) => a.id === award.id), honours: view });
}

function removeAward(lg: LeagueRecord, awardId: string, who: LeagueApiIdentity, deps: LeagueApiDeps): LeagueApiResult {
  const seasons = honoursCompetitions(deps, lg.id);
  if (!(lg.awards ?? []).some((a) => a.id === awardId)) {
    const season = awardList({ awards: [] }, seasons).find((a) => a.id === awardId);
    if (season) return fail(409, season.source === "podium" ? "Podium awards follow the season: reopen the season to change them." : "Imported awards cannot be removed here.");
    return fail(404, "Award not found.");
  }
  // Pins that pointed at the award go with it.
  const updated = write(lg, deps, (l) => {
    l.awards = (l.awards ?? []).filter((a) => a.id !== awardId);
    if (l.hallOfFame?.some((p) => p.awardId === awardId)) l.hallOfFame = l.hallOfFame.filter((p) => p.awardId !== awardId);
  });
  return ok(200, { honours: honoursView(updated, seasons, who) });
}

function addPin(lg: LeagueRecord, seasons: SeasonRecord[], who: LeagueApiIdentity, input: Record<string, unknown>, at: string, deps: LeagueApiDeps): LeagueApiResult {
  const list = lg.hallOfFame ?? [];
  if (list.length >= PINS_MAX) return fail(409, `The Hall of Fame holds at most ${PINS_MAX} pinned entries; remove one first.`);
  const note = text(input.note, "note", AWARD_NOTE_MAX, false, "Note");
  const id = `p-${randomBytes(6).toString("hex")}`;
  let pin: HallOfFamePin;
  if (input.kind === "champion") {
    const card = hallOfFame(seasons).find((h) => h.seasonId === input.seasonId);
    if (!card?.champion) throw new HonoursError(400, "Pick a finished season with a champion.", "seasonId");
    if (list.some((p) => p.kind === "champion" && p.seasonId === card.seasonId)) return fail(409, "That champion is already pinned.");
    pin = { id, kind: "champion", seasonId: card.seasonId, note, by: who.coach, at };
  } else if (input.kind === "award") {
    if (typeof input.awardId !== "string" || !awardList(lg, seasons).some((a) => a.id === input.awardId)) throw new HonoursError(400, "Pick an award of this league.", "awardId");
    if (list.some((p) => p.kind === "award" && p.awardId === input.awardId)) return fail(409, "That award is already pinned.");
    pin = { id, kind: "award", awardId: input.awardId, note, by: who.coach, at };
  } else if (input.kind === "record") {
    pin = { id, kind: "record", text: text(input.text, "text", RECORD_TEXT_MAX, true, "Record"), note, by: who.coach, at };
  } else throw new HonoursError(400, "kind must be champion, award or record.", "kind");
  const updated = write(lg, deps, (l) => { l.hallOfFame = [...(l.hallOfFame ?? []), pin]; });
  return ok(201, { pin, honours: honoursView(updated, seasons, who) });
}

function removePin(lg: LeagueRecord, pinId: string, who: LeagueApiIdentity, deps: LeagueApiDeps): LeagueApiResult {
  if (!(lg.hallOfFame ?? []).some((p) => p.id === pinId)) return fail(404, "Pinned entry not found.");
  const updated = write(lg, deps, (l) => {
    l.hallOfFame = (l.hallOfFame ?? []).filter((p) => p.id !== pinId);
    if (!l.hallOfFame.length) delete l.hallOfFame;
  });
  return ok(200, { honours: honoursView(updated, honoursCompetitions(deps, lg.id), who) });
}

function reorderPins(lg: LeagueRecord, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps): LeagueApiResult {
  const list = lg.hallOfFame ?? [];
  const order = input.order;
  if (!Array.isArray(order) || order.length !== list.length || new Set(order).size !== order.length || !order.every((id) => list.some((p) => p.id === id)))
    throw new HonoursError(400, "order must list every pinned entry once.", "order");
  const updated = write(lg, deps, (l) => { l.hallOfFame = (order as string[]).map((id) => (l.hallOfFame ?? []).find((p) => p.id === id)!); });
  return ok(200, { honours: honoursView(updated, honoursCompetitions(deps, lg.id), who) });
}

/** The competitions the honours read: seasons and started ladders (a ladder in setup is organisers-only and has no honours). */
function honoursCompetitions(deps: Pick<LeagueApiDeps, "store">, leagueId: string): SeasonRecord[] {
  return deps.store.competitions(leagueId).filter((s) => !isLadder(s) || (s.stage !== "setup" && s.stage !== "registration"));
}
