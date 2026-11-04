/**
 * Badge evaluators (badges lane, 11-04): pure functions of the ledger (src/badges/ledger.ts) and the clock. The catalog
 * (src/badges/catalog.ts) names one per entry with its parameters, so the rules are data and the code is a small fixed set.
 *
 * Rules every evaluator keeps:
 *  - only COUNTED games earn: never a forfeit, a concession, a deadline decision or an organiser-typed / overridden result
 *    (`counted`). "Unbeaten season" is the one rule that also LOOKS at forfeits: a forfeit loss breaks it.
 *  - deterministic: the same ledger and clock give the same awards, each with the time it was first earned (the game or
 *    milestone that earned it), so a corrected or deleted result simply stops producing the award and the engine revokes it.
 *  - a detail achievement (hat-trick, completions, fouls, half-time, weather) needs the recorder's detail for that game;
 *    a game without it never earns one.
 *  - "needs-recorder-data" entries are never evaluated (evaluateCatalog skips them).
 */
import { appliesToCoach, appliesToTeam, BADGE_CATALOG, type BadgeDefinition } from "./catalog.js";
import type { BadgeLedger, LedgerGame, LedgerSide } from "./ledger.js";

export interface AwardContext {
  leagueId?: string;
  seasonId?: string;
  tournamentId?: string;
  gameId?: string;
  /** SPA path of the game / competition that earned it. */
  link?: string;
  /** Short human context ("Test League", "Cup 1"). */
  label?: string;
}

export interface Hit { at: string; variant?: string; context: AwardContext }

export interface Earned {
  /** `<badgeId>|<variant>|<coach|team>|<subject key>`: one award per subject per badge (per tier, per race). */
  key: string;
  badgeId: string;
  variant?: string;
  subject: { kind: "coach" | "team"; key: string; name: string };
  at: string;
  context: AwardContext;
}

export interface SideGame { game: LedgerGame; me: LedgerSide; them: LedgerSide }

export const counted = (g: LedgerGame): boolean => !g.forfeit && !g.admin;
const DAY_MS = 86_400_000;
const gameContext = (g: LedgerGame): AwardContext => ({
  ...(g.leagueId ? { leagueId: g.leagueId } : {}), ...(g.seasonId ? { seasonId: g.seasonId } : {}), ...(g.tournamentId ? { tournamentId: g.tournamentId } : {}),
  gameId: g.id, link: g.link, label: g.competitionName,
});
const hitAt = (g: SideGame): Hit => ({ at: g.game.at, context: gameContext(g.game) });

/** The first counted game matching `test`. */
const firstCounted = (games: readonly SideGame[], test: (g: SideGame) => boolean): Hit[] => {
  const g = games.find((x) => counted(x.game) && test(x));
  return g ? [hitAt(g)] : [];
};
/** The n-th counted game matching `test` (1-based). */
const nthCounted = (games: readonly SideGame[], n: number, test: (g: SideGame) => boolean = () => true): Hit[] => {
  let k = 0;
  for (const g of games) if (counted(g.game) && test(g) && ++k === n) return [hitAt(g)];
  return [];
};
/** The game where a run of consecutive counted games matching `test` first reaches `len` (a non-matching counted game resets). */
const runOf = (games: readonly SideGame[], len: number, test: (g: SideGame) => boolean): Hit[] => {
  let run = 0;
  for (const g of games) {
    if (!counted(g.game)) continue;
    run = test(g) ? run + 1 : 0;
    if (run >= len) return [hitAt(g)];
  }
  return [];
};
/** The game that brings the number of distinct `key`s among counted games to `n`. */
const distinctReach = (games: readonly SideGame[], n: number, key: (g: SideGame) => string | undefined): Hit[] => {
  const seen = new Set<string>();
  for (const g of games) {
    if (!counted(g.game)) continue;
    const k = key(g);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (seen.size >= n) return [hitAt(g)];
  }
  return [];
};
const num = (v: number | undefined, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const win = (g: SideGame): boolean => g.me.outcome === "win";

export interface EvalContext { ledger: BadgeLedger; now: Date }

/** Evaluators over one subject's games (oldest first). `subject` = which stream it is. */
export type StreamEvaluator = (games: readonly SideGame[], params: Record<string, number>, ctx: EvalContext, subject: "coach" | "team") => Hit[];

export const STREAM_EVALUATORS: Readonly<Record<string, StreamEvaluator>> = {
  wins: (games, p) => nthCounted(games, num(p.min, 1), win),
  games: (games, p) => nthCounted(games, num(p.min, 1)),
  winStreak: (games, p) => runOf(games, num(p.length, 5), win),
  racePlayed: (games) => {
    const out = new Map<string, Hit>();
    for (const g of games) if (counted(g.game) && g.me.race && !out.has(g.me.race)) out.set(g.me.race, { ...hitAt(g), variant: g.me.race });
    return [...out.values()];
  },
  playerTouchdowns: (games, p) => firstCounted(games, (g) => (g.me.detail?.maxPlayerTd ?? -1) >= num(p.min, 3)),
  casualtiesInflicted: (games, p) => firstCounted(games, (g) => typeof g.me.cas === "number" && g.me.cas >= num(p.min, 3)),
  cleanSheetWin: (games) => firstCounted(games, (g) => win(g) && g.them.score === 0),
  comeback: (games) => firstCounted(games, (g) => win(g) && Boolean(g.me.detail?.halfTime) && g.me.detail!.halfTime!.for < g.me.detail!.halfTime!.against),
  shutoutRun: (games, p) => runOf(games, num(p.games, 3), (g) => g.them.score === 0),
  noCasualtiesSuffered: (games) => firstCounted(games, (g) => g.me.detail?.casSuffered === 0),
  weatherOneWin: (games) => firstCounted(games, (g) => win(g) && (g.me.detail?.weatherDice ?? []).includes(1)),
  playerCompletions: (games, p) => firstCounted(games, (g) => (g.me.detail?.maxPlayerCompletions ?? -1) >= num(p.min, 3)),
  successfulFouls: (games, p) => firstCounted(games, (g) => (g.me.detail?.successfulFouls ?? -1) >= num(p.min, 2)),
  tournaments: (games, p) => distinctReach(games, num(p.min, 5), (g) => g.game.tournamentId),
  races: (games, p) => distinctReach(games, num(p.min, 5), (g) => g.me.race?.trim().toLowerCase()),
  foundingCoach: (games, _p, ctx) => firstCounted(games, (g) => g.game.kind === "league" && Boolean(g.game.leagueId) && ctx.ledger.firstSeason.get(g.game.leagueId!) === g.game.seasonId),
  seasonsInLeague: (games, p) => {
    const by = new Map<string, Set<string>>();
    for (const g of games) {
      if (!counted(g.game) || g.game.kind !== "league" || !g.game.leagueId || !g.game.seasonId) continue;
      const set = by.get(g.game.leagueId) ?? new Set<string>();
      by.set(g.game.leagueId, set);
      set.add(g.game.seasonId);
      if (set.size >= num(p.min, 3)) return [hitAt(g)];
    }
    return [];
  },
  teamSeasons: (games, p) => {
    const by = new Map<string, Set<string>>();
    for (const g of games) {
      if (!counted(g.game) || g.game.kind !== "league" || !g.me.teamKey?.startsWith("u:") || !g.game.seasonId) continue;
      const set = by.get(g.me.teamKey) ?? new Set<string>();
      by.set(g.me.teamKey, set);
      set.add(`${g.game.leagueId}/${g.game.seasonId}`);
      if (set.size >= num(p.min, 3)) return [hitAt(g)];
    }
    return [];
  },
  unbeatenSeason: (games, p, ctx) => {
    const hits: Hit[] = [];
    for (const s of ctx.ledger.seasons) {
      if (!s.completed) continue;
      const mine = games.filter((g) => g.game.kind === "league" && g.game.leagueId === s.leagueId && g.game.seasonId === s.seasonId);
      if (mine.some((g) => g.me.outcome === "loss")) continue; // a forfeit or edited loss breaks it too
      const played = mine.filter((g) => counted(g.game));
      if (played.length < num(p.minGames, 3)) continue;
      hits.push({ at: s.endedAt ?? played[played.length - 1]!.game.at, context: { leagueId: s.leagueId, seasonId: s.seasonId, link: s.link, label: s.name } });
    }
    return hits.slice(0, 1);
  },
  everPresent: (games, _p, ctx) => {
    for (const s of ctx.ledger.seasons) {
      if (!s.completed) continue;
      for (const t of s.teams) {
        if (t.fixtures < 1) continue;
        const played = games.filter((g) => counted(g.game) && g.game.leagueId === s.leagueId && g.game.seasonId === s.seasonId && g.me.teamKey === t.teamKey);
        if (played.length === t.fixtures) return [{ at: s.endedAt ?? played[played.length - 1]!.game.at, context: { leagueId: s.leagueId, seasonId: s.seasonId, link: s.link, label: s.name } }];
      }
    }
    return [];
  },
};

/** Evaluators over milestones (ladder events, tournament wins, club spans): subject hits straight from the ledger. */
export interface SubjectHit extends Hit { subject: { kind: "coach" | "team"; key: string; name: string } }
export type LedgerEvaluator = (params: Record<string, number>, ctx: EvalContext) => SubjectHit[];

function ladderHits(ctx: EvalContext, test: (e: BadgeLedger["ladder"][number]) => { at: string } | undefined): SubjectHit[] {
  const out: SubjectHit[] = [];
  for (const e of ctx.ledger.ladder) {
    const hit = test(e);
    if (!hit) continue;
    const context: AwardContext = { leagueId: e.leagueId, seasonId: e.ladderId, link: e.link };
    out.push({ subject: { kind: "team", key: e.teamKey, name: e.team }, at: hit.at, context });
    if (e.coachKey && e.coach) out.push({ subject: { kind: "coach", key: e.coachKey, name: e.coach }, at: hit.at, context });
  }
  return out;
}

export const LEDGER_EVALUATORS: Readonly<Record<string, LedgerEvaluator>> = {
  beltHolder: (_p, ctx) => ladderHits(ctx, (e) => (e.kind === "reign" ? { at: e.at } : undefined)),
  beltReign: (p, ctx) => ladderHits(ctx, (e) => {
    if (e.kind !== "reign" || e.interim) return undefined;
    const need = num(p.days, 28) * DAY_MS;
    const since = Date.parse(e.at);
    const until = e.until ? Date.parse(e.until) : ctx.now.getTime();
    return Number.isFinite(since) && until - since >= need ? { at: new Date(since + need).toISOString() } : undefined;
  }),
  rumbleWinner: (_p, ctx) => ladderHits(ctx, (e) => (e.kind === "rumble" ? { at: e.at } : undefined)),
  ladderTop: (_p, ctx) => ladderHits(ctx, (e) => (e.kind === "top" ? { at: e.at } : undefined)),
  tournamentWinner: (_p, ctx) => ctx.ledger.tournamentWins.map((w) => ({
    subject: { kind: "coach", key: w.coachKey, name: w.coach }, at: w.at, context: { tournamentId: w.tournamentId, link: w.link, label: w.name },
  })),
  clubMember: (p, ctx) => ctx.ledger.clubSpans.flatMap((s) => {
    const need = num(p.days, 365) * DAY_MS;
    const from = Date.parse(s.joinedAt);
    const to = s.leftAt ? Date.parse(s.leftAt) : ctx.now.getTime();
    if (!Number.isFinite(from) || !(to - from >= need) || from + need > ctx.now.getTime()) return [];
    return [{ subject: { kind: "coach" as const, key: s.coachKey, name: s.coach }, at: new Date(from + need).toISOString(), context: { link: `/clubs/${encodeURIComponent(s.clubId)}`, label: s.club } }];
  }),
};

/** Each subject's games, oldest first (the ledger is already sorted). */
export function subjectStreams(ledger: BadgeLedger): { coach: Map<string, { name: string; games: SideGame[] }>; team: Map<string, { name: string; games: SideGame[] }> } {
  const coach = new Map<string, { name: string; games: SideGame[] }>();
  const team = new Map<string, { name: string; games: SideGame[] }>();
  const push = (map: typeof coach, key: string, name: string, g: SideGame) => {
    const row = map.get(key) ?? { name, games: [] };
    row.name = name; // the latest name shown
    row.games.push(g);
    map.set(key, row);
  };
  for (const game of ledger.games) {
    const [a, b] = game.sides;
    for (const [me, them] of [[a, b], [b, a]] as const) {
      const g = { game, me, them };
      if (me.coachKey && me.coach) push(coach, me.coachKey, me.coach, g);
      if (me.teamKey) push(team, me.teamKey, me.team, g);
    }
  }
  return { coach, team };
}

export const earnedKey = (badgeId: string, variant: string | undefined, kind: "coach" | "team", key: string): string => `${badgeId}|${variant ?? ""}|${kind}|${key}`;

/** Every award the catalog's live entries earn from this ledger, deduplicated (the earliest hit per key wins). */
export function evaluateCatalog(ledger: BadgeLedger, now: Date, catalog: readonly BadgeDefinition[] = BADGE_CATALOG): Earned[] {
  const ctx: EvalContext = { ledger, now };
  const streams = subjectStreams(ledger);
  const out = new Map<string, Earned>();
  const add = (def: BadgeDefinition, kind: "coach" | "team", key: string, name: string, hit: Hit) => {
    if (kind === "coach" ? !appliesToCoach(def) : !appliesToTeam(def)) return;
    const variant = def.variant === "race" ? hit.variant : undefined;
    if (def.variant === "race" && !variant) return;
    const k = earnedKey(def.id, variant, kind, key);
    const prior = out.get(k);
    if (prior && prior.at <= hit.at) return;
    out.set(k, { key: k, badgeId: def.id, ...(variant ? { variant } : {}), subject: { kind, key, name }, at: hit.at, context: hit.context });
  };
  for (const def of catalog) {
    if (def.status !== "live") continue;
    const stream = STREAM_EVALUATORS[def.evaluator];
    if (stream) {
      for (const kind of ["coach", "team"] as const) {
        if (kind === "coach" ? !appliesToCoach(def) : !appliesToTeam(def)) continue;
        for (const [key, row] of streams[kind]) for (const hit of stream(row.games, def.params, ctx, kind)) add(def, kind, key, row.name, hit);
      }
      continue;
    }
    const fn = LEDGER_EVALUATORS[def.evaluator];
    if (!fn) continue; // an unknown evaluator earns nothing (fail closed)
    for (const hit of fn(def.params, ctx)) add(def, hit.subject.kind, hit.subject.key, hit.subject.name, hit);
  }
  return [...out.values()].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}
