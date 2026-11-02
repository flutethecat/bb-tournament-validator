/**
 * The Discord observer: a scheduler tick (every 30 s, the deadlines-job pattern) that notices competition events by
 * comparing each competition's state with what it already posted (the ledger in the Discord state store), so every path
 * that changes a tournament or a season is covered and nothing is posted twice, across restarts.
 *
 *   tournaments  published, registration opened, new registration, registration closing in 24 h, check-in open,
 *                pairings posted, match started, fixture start, match result (not an organiser's result edit: admin-
 *                entered results are never announced), end-of-round summary, final standings + champion, awards, news
 *   leagues      published, awards (league-wide)
 *   seasons      registration opened, new registration, registration closing in 24 h, round posted (a generated or
 *                imported round; fixtures made one by one in the editor post "fixture created" instead), fixture start,
 *                standings after each round, final standings + champion, awards
 *   Weekly Digest  per league: the organiser's day / time / every N weeks, or after each round (weekly.ts)
 *
 * First sight of a competition (and every tick while it is a draft or has no webhook) marks what exists WITHOUT posting:
 * turning Discord on, publishing a draft or deploying this never replays history. Markers are written before the post
 * (best effort: a failed post is not retried, like every other Discord post here).
 */
import type { DiscordPayload, WebhookPoster } from "../leagues/discord.js";
import { postWebhook as defaultPoster } from "../leagues/discord.js";
import { isDraftLeague } from "../leagues/lifecycle.js";
import { seasonRegistrationOf, seasonWindowStatus } from "../leagues/seasonRegistration.js";
import { deriveStandings } from "../leagues/standings.js";
import type { LeagueStore } from "../leagues/store.js";
import { fixturePlayed } from "../leagues/tourplay.js";
import { leagueTimeZone } from "../leagues/timeZone.js";
import type { DiscordEventKey, LeagueFixture, LeagueRecord, SeasonRecord } from "../leagues/types.js";
import { calculateStandings } from "../tournaments/pairing.js";
import type { TournamentStore } from "../tournaments/store.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord, TournamentRecord } from "../tournaments/types.js";
import { forkGame, type GameRecord } from "./games.js";
import {
  finalStandingsPost, pairingsPost, resultPost, roundSummaryPost, safe, simplePost, standingsPost, weeklyDigestPost, type StandingLine,
} from "./posts.js";
import type { DiscordStateStore } from "./store.js";
import { leagueTarget, postRaw, postTo, seasonTarget, tournamentTarget, type DiscordTarget } from "./targets.js";
import { completedRounds, slotDue, weeklyContent, weeklyOf } from "./weekly.js";

export const OBSERVER_TICK_MS = 30_000;
const HOUR = 3_600_000;
/** A tournament result waits this long, so the recorder's own digest (which marks it) always goes first. */
export const RESULT_SETTLE_MS = 45_000;

export interface ObserverDeps {
  leagues: Pick<LeagueStore, "list" | "league" | "seasons" | "season" | "secrets">;
  tournaments: Pick<TournamentStore, "tournaments" | "entrants" | "rounds" | "matches" | "tournament">;
  state: DiscordStateStore;
  poster?: WebhookPoster;
  /** The recorded games of these fixtures (Weekly Digest highlights). Default: the Super FUMBBL results banked on them. */
  gamesFor?: (league: LeagueRecord, season: SeasonRecord, fixtures: LeagueFixture[]) => Promise<GameRecord[]>;
  now?: () => Date;
  log?: (line: string) => void;
}

/** key null = marked, never posted (an organiser's result edit). */
interface Pending { marker: string; key: DiscordEventKey | null; payload: () => DiscordPayload }

export class DiscordObserver {
  private running = false;
  constructor(private readonly deps: ObserverDeps) {}

  private get poster(): WebhookPoster { return this.deps.poster ?? defaultPoster; }
  private now(): Date { return this.deps.now?.() ?? new Date(); }

  /** One pass over every competition. Never throws. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let posted = 0;
    try {
      for (const t of this.deps.tournaments.tournaments(["draft", "active", "completed"])) {
        try { posted += await this.flush(tournamentTarget(this.deps.state, t), this.tournamentEvents(t)); } catch (e) { this.deps.log?.(`[discord] tournament pass failed: ${(e as Error).message}`); }
      }
      for (const league of this.deps.leagues.list()) {
        try {
          posted += await this.flush(leagueTarget(this.deps.leagues, league), this.leagueEvents(league));
          for (const season of this.deps.leagues.seasons(league.id)) posted += await this.flush(seasonTarget(this.deps.leagues, league, season.id), this.seasonEvents(league, season));
          posted += await this.weekly(league);
        } catch (e) { this.deps.log?.(`[discord] league pass failed: ${(e as Error).message}`); }
      }
    } finally {
      this.running = false;
    }
    return posted;
  }

  /** Marks every pending marker; posts the new ones (only once the competition was seen before, is published and has a webhook). */
  private async flush(target: DiscordTarget, events: Pending[]): Promise<number> {
    const at = this.now().toISOString();
    const known = this.deps.state.entry(target.key);
    const quiet = !known?.baselineAt || target.draft || !target.url;
    const fresh = new Set(this.deps.state.mark(target.key, events.map((e) => e.marker), at, true));
    if (quiet) return 0;
    let n = 0;
    for (const e of events) {
      if (!e.key || !fresh.has(e.marker) || !target.config.events[e.key]) continue;
      if (await postTo(target, e.key, e.payload(), this.poster)) n += 1;
    }
    return n;
  }

  // ---- tournaments ----

  private tournamentEvents(t: TournamentRecord): Pending[] {
    const now = this.now().getTime();
    const out: Pending[] = [];
    const name = t.name;
    const test = t.test === true;
    const entrants = this.deps.tournaments.entrants(t.id);
    const byId = new Map(entrants.map((e) => [e.id, e]));
    const label = (id: string | undefined): string => {
      const e = id ? byId.get(id) : undefined;
      if (!e) return "TBD";
      return e.submission?.teamName ? `${e.submission.teamName} (${e.coach.ffbCoachId})` : e.coach.ffbCoachId;
    };
    const matches = this.deps.tournaments.matches(t.id);
    const rounds = this.deps.tournaments.rounds(t.id);
    if (t.unpublished !== true) out.push({ marker: "published", key: "published", payload: () => simplePost(name, "published", "Now open on the site.", { test }) });
    const opens = t.registration?.opensAt;
    if (opens && Date.parse(opens) <= now) out.push({ marker: `regopen:${opens}`, key: "registrationOpened", payload: () => simplePost(name, "registrationOpened", "Registration is open.", { test }) });
    for (const e of entrants) if (e.droppedAt === undefined) out.push({ marker: `entrant:${e.id}`, key: "newRegistration", payload: () => simplePost(name, "newRegistration", `${safe(label(e.id))} registered.`, { test }) });
    const close = t.deadlines?.registration ? Date.parse(t.deadlines.registration) : NaN;
    if (Number.isFinite(close) && close > now && close - now <= 24 * HOUR)
      out.push({ marker: `regclose:${t.deadlines!.registration}`, key: "registrationClosing", payload: () => simplePost(name, "registrationClosing", "Registration closes in less than 24 hours.", { test }) });
    const start = t.startsAt ? Date.parse(t.startsAt) : NaN;
    const checkInAt = t.registration?.checkIn.opensAt ? Date.parse(t.registration.checkIn.opensAt) : Number.isFinite(start) ? start - 24 * HOUR : NaN;
    if (t.registration?.checkIn.self && Number.isFinite(checkInAt) && checkInAt <= now && t.status !== "completed" && (!Number.isFinite(start) || now < start + 12 * HOUR))
      out.push({ marker: `checkin:${checkInAt}`, key: "checkInOpen", payload: () => simplePost(name, "checkInOpen", "Check-in is open: check in on the tournament page.", { test }) });
    for (const r of rounds) {
      const ms = r.scheduledMatchIds.map((id) => matches.find((m) => m.id === id)).filter((m): m is ScheduledMatchRecord => Boolean(m));
      out.push({ marker: `round:${r.id}`, key: "roundPosted", payload: () => pairingsPost(name, `Round ${r.number}`, ms.map((m, i) => ({ home: label(m.home.entrantId), ...(m.away ? { away: label(m.away.entrantId) } : {}), table: i + 1 })), test) });
    }
    for (const m of matches) {
      if (!m.away) continue;
      const vs = `${label(m.home.entrantId)} v ${label(m.away.entrantId)}`;
      if (m.launch.launchedAt) out.push({ marker: `started:${m.id}`, key: "matchStarted", payload: () => simplePost(name, "matchStarted", `${safe(vs)} has started (Round ${m.roundNumber}).`, { test }) });
      const st = m.scheduledTime ? Date.parse(m.scheduledTime.start) : NaN;
      if (Number.isFinite(st) && st <= now && now - st < 2 * HOUR && !m.result)
        out.push({ marker: `start:${m.id}:${m.scheduledTime!.start}`, key: "fixtureStart", payload: () => simplePost(name, "fixtureStart", `${safe(vs)} starts now (Round ${m.roundNumber}).`, { test }) });
      const res = m.result;
      if (res && now - Date.parse(res.reportedAt) >= RESULT_SETTLE_MS) {
        // An organiser's result edit is an admin-entered result: marked, never announced.
        const edited = m.edited?.kind === "result";
        out.push({
          marker: `result:${m.id}`, key: edited ? null : "matchResult",
          payload: () => resultPost(name, { home: { team: label(m.home.entrantId), score: res.homeScore, cas: res.homeCasualties ?? null }, away: { team: label(m.away!.entrantId), score: res.awayScore, cas: res.awayCasualties ?? null }, round: `Round ${m.roundNumber}`, test }),
        });
      }
    }
    for (const r of rounds) {
      if (r.status !== "completed") continue;
      out.push({ marker: `roundsum:${r.id}`, key: "roundStandings", payload: () => this.roundSummary(t, r.number, entrants, matches, label) });
    }
    if (t.status === "completed") out.push({ marker: "final", key: "finalStandings", payload: () => {
      const rows = this.tournamentTable(t, entrants, matches, label);
      return finalStandingsPost(name, rows[0]?.name, rows, test);
    } });
    for (const a of t.awards ?? []) out.push({ marker: `award:${a.id}`, key: "awards", payload: () => simplePost(name, "awards", `${safe(a.title, 80)}: ${safe(a.toTeam ? `${a.toTeam} (${a.toCoach})` : a.toCoach, 100)}${a.note ? `\n${safe(a.note, 300)}` : ""}`, { test }) });
    for (const n of t.news ?? []) out.push({ marker: `news:${n.id}`, key: "news", payload: () => simplePost(name, "news", safe(n.body, 1500), { test, title: safe(n.title, 120) }) });
    return out;
  }

  private tournamentTable(t: TournamentRecord, entrants: TournamentEntrantRecord[], matches: ScheduledMatchRecord[], label: (id: string) => string): StandingLine[] {
    try {
      return calculateStandings(entrants, matches, t.points, t.tiebreakers).map((r) => ({ rank: r.rank, name: label(r.entrantId), points: r.points, detail: `${r.wins}-${r.draws}-${r.losses}` }));
    } catch { return []; }
  }

  private roundSummary(t: TournamentRecord, round: number, entrants: TournamentEntrantRecord[], matches: ScheduledMatchRecord[], label: (id: string) => string): DiscordPayload {
    const before = calculateStandings(entrants, matches.filter((m) => m.roundNumber < round), t.points, t.tiebreakers);
    const rankBefore = new Map(before.map((r) => [r.entrantId, r.rank]));
    const upTo = matches.filter((m) => m.roundNumber <= round);
    const results = matches.filter((m) => m.roundNumber === round && m.away && m.result).map((m) => ({
      home: label(m.home.entrantId), away: label(m.away!.entrantId), homeScore: m.result!.homeScore, awayScore: m.result!.awayScore,
      ...(round > 1 && rankBefore.has(m.home.entrantId) ? { homeRank: rankBefore.get(m.home.entrantId)! } : {}),
      ...(round > 1 && rankBefore.has(m.away!.entrantId) ? { awayRank: rankBefore.get(m.away!.entrantId)! } : {}),
    }));
    return roundSummaryPost(t.name, `Round ${round}`, results, this.tournamentTable(t, entrants, upTo, label), t.test === true);
  }

  // ---- leagues / seasons ----

  private leagueEvents(league: LeagueRecord): Pending[] {
    const out: Pending[] = [];
    const test = league.test === true;
    if (!isDraftLeague(league)) out.push({ marker: "published", key: "published", payload: () => simplePost(league.name, "published", "The league is now open on the site.", { test }) });
    for (const a of league.awards ?? []) if (!a.seasonId) out.push({ marker: `award:${a.id}`, key: "awards", payload: () => simplePost(league.name, "awards", `${safe(a.title, 80)}: ${safe(a.toTeam ?? a.toCoach ?? "", 100)}${a.note ? `\n${safe(a.note, 300)}` : ""}`, { test }) });
    return out;
  }

  private seasonEvents(league: LeagueRecord, season: SeasonRecord): Pending[] {
    const now = this.now();
    const out: Pending[] = [];
    const name = league.name;
    const test = league.test === true;
    const sname = season.name;
    try {
      if (season.status === "active" && seasonWindowStatus(league, season, now).open)
        out.push({ marker: "regopen", key: "registrationOpened", payload: () => simplePost(name, "registrationOpened", `Registration for ${safe(sname)} is open.`, { test }) });
    } catch { /* window unreadable: nothing to announce */ }
    for (const team of season.teams) out.push({ marker: `team:${team.id}`, key: "newRegistration", payload: () => simplePost(name, "newRegistration", `${safe(team.name)} (${safe(team.coach)}, ${safe(team.race)}) joined ${safe(sname)}.`, { test }) });
    const closesAt = seasonRegistrationOf(league, season).closesAt;
    const close = closesAt ? Date.parse(closesAt) : NaN;
    if (season.status === "active" && Number.isFinite(close) && close > now.getTime() && close - now.getTime() <= 24 * HOUR)
      out.push({ marker: `regclose:${closesAt}`, key: "registrationClosing", payload: () => simplePost(name, "registrationClosing", `Registration for ${safe(sname)} closes in less than 24 hours.`, { test }) });
    // Rounds: generated or imported ones (fixtures made one by one in the editor were each announced as created).
    const editorMade = new Set((season.log ?? []).filter((e) => e.kind === "fixture-created").map((e) => e.fixtureId));
    const rounds = new Map<string, LeagueFixture[]>();
    for (const f of season.fixtures) if (!f.test) rounds.set(`${f.phaseId}:${f.round}`, [...(rounds.get(`${f.phaseId}:${f.round}`) ?? []), f]);
    for (const [k, fs] of rounds) {
      if (fs.some((f) => editorMade.has(f.id))) continue;
      const label = [fs[0]!.phase && fs[0]!.phase !== "Regular" ? fs[0]!.phase : "", `Round ${fs[0]!.round}`].filter(Boolean).join(", ");
      out.push({ marker: `round:${k}`, key: "roundPosted", payload: () => pairingsPost(name, `${sname} ${label}`, fs.map((f) => ({ home: f.home.team, away: f.away.team, table: f.table })), test) });
    }
    for (const f of season.fixtures) {
      const st = f.scheduledTime ? Date.parse(f.scheduledTime.start) : NaN;
      if (Number.isFinite(st) && st <= now.getTime() && now.getTime() - st < 2 * HOUR && !fixturePlayed(f))
        out.push({ marker: `start:${f.id}:${f.scheduledTime!.start}`, key: "fixtureStart", payload: () => simplePost(name, "fixtureStart", `${safe(f.home.team)} v ${safe(f.away.team)} starts now (Round ${f.round}).`, { test: test || f.test }) });
    }
    const table = (): StandingLine[] => {
      const phase = deriveStandings(season).find((p) => p.standings.length);
      const group = phase?.standings[0]?.group;
      return (phase?.standings ?? []).filter((r) => r.group === group).map((r) => ({ rank: r.rank, name: r.team, points: r.points, detail: `${r.wins}-${r.draws}-${r.losses}` }));
    };
    for (const k of completedRounds(season)) {
      const round = k.split(":").at(-1);
      out.push({ marker: `roundsum:${k}`, key: "roundStandings", payload: () => standingsPost(name, `${sname} standings after round ${round}`, table(), test) });
    }
    if (season.status === "completed") out.push({ marker: "final", key: "finalStandings", payload: () => {
      const rows = table();
      const champ = season.awards.find((a) => a.podium && /champ/i.test(`${a.type} ${a.name} ${a.category}`))?.team ?? rows[0]?.name;
      return finalStandingsPost(`${name} ${sname}`, champ, rows, test);
    } });
    for (const a of league.awards ?? []) if (a.seasonId === season.id) out.push({ marker: `award:${a.id}`, key: "awards", payload: () => simplePost(name, "awards", `${safe(a.title, 80)}: ${safe(a.toTeam ?? a.toCoach ?? "", 100)}${a.note ? `\n${safe(a.note, 300)}` : ""}`, { test }) });
    return out;
  }

  // ---- Weekly Digest ----

  /** The season a league's Weekly Digest covers: the newest season in progress, else the newest. */
  static digestSeason(seasons: SeasonRecord[]): SeasonRecord | undefined {
    return [...seasons].sort((a, b) => b.number - a.number).find((s) => s.status === "active") ?? [...seasons].sort((a, b) => b.number - a.number)[0];
  }

  private async games(league: LeagueRecord, season: SeasonRecord, fixtures: LeagueFixture[]): Promise<GameRecord[]> {
    if (this.deps.gamesFor) { try { return await this.deps.gamesFor(league, season, fixtures); } catch { return []; } }
    return fixtures.map((f) => forkGame(f)).filter((g): g is GameRecord => Boolean(g));
  }

  /** The digest for (from, to], or why there is none. */
  async digestFor(league: LeagueRecord, from: number, to: number): Promise<{ payload?: DiscordPayload; reason?: string; from: number; to: number }> {
    const season = DiscordObserver.digestSeason(this.deps.leagues.seasons(league.id));
    if (!season) return { reason: "The league has no season yet.", from, to };
    const tz = leagueTimeZone(league);
    const fixtures = season.fixtures.filter((f) => fixturePlayed(f) && !f.test);
    const content = weeklyContent(season, from, to, tz, await this.games(league, season, fixtures));
    if (!content) return { reason: "No games were played in this period, so the digest is skipped.", from, to };
    return { payload: weeklyDigestPost(league.name, content, league.test === true), from, to };
  }

  private async weekly(league: LeagueRecord): Promise<number> {
    const target = leagueTarget(this.deps.leagues, league);
    const settings = weeklyOf(league.weeklyDigest);
    if (target.draft || !target.url || !settings.enabled) return 0;
    const now = this.now();
    const tz = leagueTimeZone(league);
    const last = this.deps.state.weekly(league.id);
    if (settings.trigger === "schedule") {
      const slot = slotDue(settings, now, tz, last.lastRun);
      if (!slot) return 0;
      const span = settings.everyWeeks * 7 * 24 * HOUR;
      const from = Math.max(slot.getTime() - span, last.lastRun ? Date.parse(last.lastRun) : 0);
      // The run is stamped first (a crash mid-post never posts the same week twice).
      this.deps.state.setWeekly(league.id, { lastRun: slot.toISOString() });
      const d = await this.digestFor(league, from, slot.getTime());
      return d.payload && (await postRaw(target, d.payload, this.poster)) ? 1 : 0;
    }
    const season = DiscordObserver.digestSeason(this.deps.leagues.seasons(league.id));
    if (!season) return 0;
    const key = `weekly:${league.id}`;
    const seen = this.deps.state.entry(key);
    const done = completedRounds(season).map((k) => `wround:${season.id}:${k}`);
    const fresh = this.deps.state.mark(key, done, now.toISOString(), true);
    if (!seen?.baselineAt || !fresh.length) return 0;
    const from = last.lastRun ? Date.parse(last.lastRun) : now.getTime() - 7 * 24 * HOUR;
    this.deps.state.setWeekly(league.id, { lastRun: now.toISOString(), lastRound: fresh.at(-1)! });
    const d = await this.digestFor(league, from, now.getTime());
    return d.payload && (await postRaw(target, d.payload, this.poster)) ? 1 : 0;
  }

  /** The period a preview / "Post now" covers: since the last digest (at most the configured span back), up to now. */
  previewPeriod(league: LeagueRecord): { from: number; to: number } {
    const now = this.now().getTime();
    const settings = weeklyOf(league.weeklyDigest);
    const span = (settings.trigger === "schedule" ? settings.everyWeeks : 1) * 7 * 24 * HOUR;
    const last = this.deps.state.weekly(league.id).lastRun;
    return { from: Math.max(now - span, last ? Date.parse(last) : 0), to: now };
  }
}
