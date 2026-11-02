/**
 * Weekly Digest (renamed from the "Sunday report", owner round 3; period rules round 4): the organiser picks a day of the
 * week + a time (in the league's time zone) + every 1 / 2 / 4 weeks, OR "after each round". On by default for a league
 * with a webhook. A period with no games is skipped. Content: standings (top 10 + movers), the period's results, and
 * highlights from RECORDED games only (most fouls, deaths, top scorer, most casualties, biggest win); bounties claimed
 * have no data source yet, so that highlight is omitted.
 *
 * Pure (time and data passed in): the scheduler (observer.ts) decides when, stores the last run, and posts.
 */
import { deriveStandings } from "../leagues/standings.js";
import { fixturePlayed } from "../leagues/tourplay.js";
import type { LeagueFixture, SeasonRecord, StandingRow } from "../leagues/types.js";
import type { GameRecord } from "./games.js";
import { safe, type PostField, type StandingLine, type WeeklyContent } from "./posts.js";

export interface WeeklyDigestSettings {
  enabled: boolean;
  trigger: "schedule" | "afterRound";
  /** 0 = Sunday ... 6 = Saturday. */
  day: number;
  /** "HH:MM", 24 h, league time zone. */
  time: string;
  everyWeeks: 1 | 2 | 4;
}

export const DEFAULT_WEEKLY: WeeklyDigestSettings = { enabled: true, trigger: "schedule", day: 0, time: "10:00", everyWeeks: 1 };
export const weeklyOf = (s: Partial<WeeklyDigestSettings> | undefined): WeeklyDigestSettings => ({ ...DEFAULT_WEEKLY, ...(s ?? {}) });
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

// ---- time zones (Intl only, no dependency) ---------------------------------------------------------------------------

export { isTimeZone } from "../leagues/timeZone.js";

interface LocalParts { y: number; m: number; d: number; hh: number; mm: number; wd: number }
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(at: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "0";
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), hh: Number(get("hour")) % 24, mm: Number(get("minute")), wd: WD[get("weekday")] ?? 0 };
}

/** The instant of a local wall-clock time in `tz` (DST: the first matching instant). */
export function zonedInstant(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    t = t - (asUtc - guess);
  }
  return new Date(t);
}

const DAY_MS = 86_400_000;
/** Whole local days since 1970-01-04 (a Sunday) for a local calendar date. */
const localDayIndex = (y: number, m: number, d: number): number => Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(1970, 0, 4)) / DAY_MS);

/** The most recent scheduled slot at or before `now` (every N weeks, anchored on a fixed epoch week). */
export function lastSlot(s: WeeklyDigestSettings, now: Date, tz: string): Date {
  const [hh, mm] = s.time.split(":").map(Number) as [number, number];
  const p = localParts(now, tz);
  let idx = localDayIndex(p.y, p.m, p.d) - ((p.wd - s.day + 7) % 7);
  const instantOf = (dayIndex: number): Date => {
    const base = new Date(Date.UTC(1970, 0, 4) + dayIndex * DAY_MS);
    return zonedInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh, mm, tz);
  };
  if (instantOf(idx).getTime() > now.getTime()) idx -= 7;
  while (Math.floor(idx / 7) % s.everyWeeks !== 0) idx -= 7;
  return instantOf(idx);
}

/** A slot is due when it is newer than the last run and not older than a day (a long outage skips, never floods). */
export function slotDue(s: WeeklyDigestSettings, now: Date, tz: string, lastRun: string | undefined): Date | undefined {
  if (!s.enabled || s.trigger !== "schedule") return undefined;
  const slot = lastSlot(s, now, tz);
  if (now.getTime() - slot.getTime() > DAY_MS) return undefined;
  if (lastRun && Date.parse(lastRun) >= slot.getTime()) return undefined;
  return slot;
}

// ---- content ---------------------------------------------------------------------------------------------------------

const finished = (f: LeagueFixture): number => Date.parse(f.finishedAt ?? f.tabletop?.reportedAt ?? f.fork?.result?.appliedAt ?? "");

/** The season's played fixtures finished in (from, to]. */
export function periodFixtures(season: Pick<SeasonRecord, "fixtures">, from: number, to: number): LeagueFixture[] {
  return season.fixtures.filter((f) => fixturePlayed(f) && !f.test && Number.isFinite(finished(f)) && finished(f) > from && finished(f) <= to);
}

function firstTable(season: SeasonRecord): StandingRow[] {
  const phase = deriveStandings(season).find((p) => p.standings.length);
  if (!phase) return [];
  const group = phase.standings[0]!.group;
  return phase.standings.filter((r) => r.group === group);
}

const rowKey = (r: Pick<StandingRow, "teamId" | "team">): string => r.teamId ?? r.team;

/** Standings now (top 10) and the movers since `from` (rank change of two places or more). */
export function standingsWithMovers(season: SeasonRecord, from: number): { standings: StandingLine[]; movers: WeeklyContent["movers"] } {
  const now = firstTable(season);
  const before = structuredClone(season);
  for (const f of before.fixtures) {
    const t = finished(f);
    if (Number.isFinite(t) && t > from) { f.home.score = f.away.score = null; f.home.cas = f.away.cas = null; f.home.conceded = f.away.conceded = false; delete f.fork; }
  }
  before.resultsChangedAt = new Date().toISOString();
  const was = new Map(firstTable(before).map((r) => [rowKey(r), r.rank]));
  const movers = now.map((r) => ({ name: r.team, from: was.get(rowKey(r)) ?? r.rank, to: r.rank })).filter((m) => Math.abs(m.from - m.to) >= 2)
    .sort((a, b) => Math.abs(b.from - b.to) - Math.abs(a.from - a.to));
  return { standings: now.slice(0, 10).map((r) => ({ rank: r.rank, name: r.team, points: r.points })), movers };
}

/** Highlights from the period's fixtures (scores) and its RECORDED games (in-game events); a highlight without data is left out. */
export function highlights(fixtures: LeagueFixture[], games: GameRecord[]): PostField[] {
  const out: PostField[] = [];
  const top = <T>(m: Map<string, number>, label: (k: string, n: number) => T): T | undefined => {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] > 0 ? label(best[0], best[1]) : undefined;
  };
  const tally = (key: "touchdown" | "foul" | "casualty", by: "player" | "team"): Map<string, number> => {
    const m = new Map<string, number>();
    for (const g of games) for (const l of g.lines[key]) {
      const k = by === "player" ? `${l.player} (${g[l.side].team})` : g[l.side].team;
      m.set(k, (m.get(k) ?? 0) + l.count);
    }
    return m;
  };
  const scorer = top(tally("touchdown", "player"), (k, n) => `${safe(k, 80)}: ${n} TD${n === 1 ? "" : "s"}`);
  if (scorer) out.push({ name: "Top scorer", value: scorer, inline: true });
  const fouls = top(tally("foul", "team"), (k, n) => `${safe(k, 60)}: ${n}`);
  if (fouls) out.push({ name: "Most fouls", value: fouls, inline: true });
  // Most casualties: the fixtures' casualty counts (every result carries them), recorded games or not.
  const cas = new Map<string, number>();
  for (const f of fixtures) for (const s of [f.home, f.away]) if (s.cas) cas.set(s.team, (cas.get(s.team) ?? 0) + s.cas);
  const mostCas = top(cas, (k, n) => `${safe(k, 60)}: ${n}`);
  if (mostCas) out.push({ name: "Most casualties", value: mostCas, inline: true });
  const deaths = games.flatMap((g) => g.lines.death.map((l) => `${safe(l.player, 60)} (${safe(g[l.side].team, 60)})`));
  if (deaths.length) out.push({ name: "Deaths", value: deaths.slice(0, 10).join("\n") });
  const big = [...fixtures].map((f) => ({ f, margin: Math.abs((f.home.score ?? 0) - (f.away.score ?? 0)) })).filter((x) => x.margin > 0).sort((a, b) => b.margin - a.margin)[0];
  if (big) out.push({ name: "Biggest win", value: `${safe(big.f.home.team, 60)} ${big.f.home.score} - ${big.f.away.score} ${safe(big.f.away.team, 60)}`, inline: true });
  return out;
}

const fmtDate = (t: number, tz: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(new Date(t));

/** The digest content for (from, to], or undefined when no game was played in it (the week is skipped). */
export function weeklyContent(season: SeasonRecord, from: number, to: number, tz: string, games: GameRecord[]): WeeklyContent | undefined {
  const fixtures = periodFixtures(season, from, to);
  if (!fixtures.length) return undefined;
  const { standings, movers } = standingsWithMovers(season, from);
  return {
    periodLabel: `${season.name}: ${fmtDate(from, tz)} to ${fmtDate(to, tz)}`,
    standings, movers,
    results: fixtures.map((f) => `${safe(f.home.team, 60)} ${f.home.score ?? 0} - ${f.away.score ?? 0} ${safe(f.away.team, 60)}`),
    highlights: highlights(fixtures, games),
  };
}

/** Rounds of the season whose every fixture is played (phase id + round), in play order. */
export function completedRounds(season: Pick<SeasonRecord, "fixtures">): string[] {
  const rounds = new Map<string, { done: boolean; last: number }>();
  for (const f of season.fixtures) {
    if (f.test) continue;
    const k = `${f.phaseId}:${f.round}`;
    const r = rounds.get(k) ?? { done: true, last: 0 };
    r.done &&= fixturePlayed(f);
    r.last = Math.max(r.last, Number.isFinite(finished(f)) ? finished(f) : 0);
    rounds.set(k, r);
  }
  return [...rounds.entries()].filter(([, r]) => r.done).sort((a, b) => a[1].last - b[1].last).map(([k]) => k);
}

/** Validation of a PATCH { weekly } (throws a message). */
export function parseWeekly(raw: unknown, prior: WeeklyDigestSettings): WeeklyDigestSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("weekly must be an object.");
  const r = raw as Record<string, unknown>;
  const out = { ...prior };
  if (r.enabled !== undefined) { if (typeof r.enabled !== "boolean") throw new Error("weekly.enabled must be true or false."); out.enabled = r.enabled; }
  if (r.trigger !== undefined) { if (r.trigger !== "schedule" && r.trigger !== "afterRound") throw new Error("weekly.trigger must be schedule or afterRound."); out.trigger = r.trigger; }
  if (r.day !== undefined) { if (!Number.isInteger(r.day) || (r.day as number) < 0 || (r.day as number) > 6) throw new Error("weekly.day must be 0 (Sunday) to 6 (Saturday)."); out.day = r.day as number; }
  if (r.time !== undefined) { if (typeof r.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) throw new Error("weekly.time must look like 18:30."); out.time = r.time; }
  if (r.everyWeeks !== undefined) { if (r.everyWeeks !== 1 && r.everyWeeks !== 2 && r.everyWeeks !== 4) throw new Error("weekly.everyWeeks must be 1, 2 or 4."); out.everyWeeks = r.everyWeeks; }
  return out;
}
