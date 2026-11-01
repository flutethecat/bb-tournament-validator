/**
 * Play on Super FUMBBL: a finished fork game's result, applied to the league fixture and the two league teams (pure).
 *
 * Server numbers only (SERVER-DERIVED law): the score, casualties, concession, winnings, the per-player counters and,
 * from a full result (the server's FumbblResult), the SPP each player earned, the serious injuries it recorded and the
 * dedicated-fans change. The league team record is changed the way result banking changes a fork team file
 * (src/site-backend/fumbblResultBanking.ts): last game's missed-next-game players recover, earned SPP is added to the
 * spendable balance (a conceding team's balance is cleared), counters are added, injuries land (MNG; niggling +1;
 * characteristic losses; a death or a defection retires the player to former players), treasury = treasury - the part
 * of it spent on inducements + winnings, dedicated fans + the server's modifier. Seasons played is never touched. The
 * team value is then RECOMPUTED by the league (teamValue.ts); the fork's teamValue is only compared, like for like: the
 * fork's figure is a kickoff value (current team value + dedicated fans x 10k), so it is compared with the league
 * team's PRE-result current team value + dedicated fans x 10k, and a difference is recorded as forkTeamValueDiff on the
 * fixture result side (owner 10-30: informational, never adopted).
 *
 * A "basic" result (the fork's finished-game listing without the FumbblResult body) carries no SPP, injuries, fan
 * change or inducement spend: SPP balances (also of a conceding team), injuries, fans and the TREASURY are left as
 * they are (winnings without the spend would overstate it), and the fixture records source "basic" with
 * financialPending for an organiser to settle.
 *
 * Extra result data that fills itself from the result (owner 10-30, no coach input): per side the legal-concession flag,
 * the casualties suffered and the attendance figures (spectators, fame, fan factor, dedicated-fans change) are recorded on
 * the fixture result; per player the blocks / rushing / passing / deflections / landings / turns-played counters are added
 * to the season stats, and a player the server recorded a casualty result for counts one injury SUFFERED
 * (PlayerSeasonStats.injuries; `cas` stays casualties inflicted). All of it lands once per fixture: applyForkResult
 * refuses a fixture that already holds a result, so banking the same game twice never double counts.
 *
 * Characteristic losses respect the fork's limits (ffb-common mechanics/mixed/StatsMechanic: MA 1-9, ST 1-8, AG and PA
 * 1-6, AV 3-11; a lasting injury never takes a value past them) while the injury still causes the missed game.
 */
import type { GamestateResult } from "@bb/fork-ops";
import type { ParsedGameResult } from "../site-backend/fumbblResult.js";
import { kickoffTeamValue, refreshTeamValues, storeFallbackValues } from "./teamValue.js";
import { fixturePlayed } from "./tourplay.js";
import { FORK_PLAYER_COUNTERS } from "./types.js";
import type {
  CasualtiesSuffered, FixtureForkResult, ForkPlayerCounter, FixtureForkTeam, ForkPlayerLine, ForkSide, ForkSideResult, FormerPlayer, LeagueFixture, LeaguePlayer, LeagueTeam, SeasonRecord,
} from "./types.js";

export interface ForkGamePlayerResult {
  forkPlayerId: string;
  name: string;
  td: number;
  cas: number;
  completions: number;
  interceptions: number;
  mvp: number;
  fouls: number;
  /** Full results only. */
  earnedSpps?: number;
  injuries?: string[];
  defecting?: boolean;
  gainedHatred?: string[];
  /** Server statistics (absent = 0): blocks, signed rushing / passing yardage, deflections, landings, turns played. */
  blocks?: number;
  rushing?: number;
  passing?: number;
  deflections?: number;
  landings?: number;
  turnsPlayed?: number;
}

export interface ForkGameTeamResult {
  teamId: string;
  score: number;
  /** >= 0 only when a penalty shootout was played. */
  penaltyScore?: number;
  conceded: boolean;
  winnings: number;
  /** Full results only: treasury the team spent on inducements this game. */
  treasurySpent?: number;
  /** Full results only: the server's dedicated-fans change. */
  dedicatedFansModifier?: number;
  /** Full results, conceding side only: the server's legal-concession verdict. */
  concededLegally?: boolean;
  casualtiesSuffered?: CasualtiesSuffered;
  /** Full results only, when the server sent them. */
  spectators?: number;
  fame?: number;
  fanFactor?: number;
  /** Full results only: the fork's own team value (gold). Compared with the league's, never adopted (owner 10-30). */
  teamValue?: number;
  players: ForkGamePlayerResult[];
}

export interface ForkGameResult {
  gameId: string;
  source: "full" | "basic";
  playedAt?: string;
  teams: ForkGameTeamResult[];
}

/** The server's FumbblResult (gamestate/result body) as a league result. */
export function fromParsedResult(parsed: ParsedGameResult, playedAt?: string): ForkGameResult {
  return {
    gameId: parsed.gameId,
    source: "full",
    ...(playedAt ? { playedAt } : {}),
    teams: parsed.teams.map((t) => ({
      teamId: t.teamId,
      score: t.score,
      ...(t.penaltyScore !== undefined ? { penaltyScore: t.penaltyScore } : {}),
      conceded: t.conceded,
      winnings: t.winnings ?? 0,
      treasurySpent: t.treasurySpentOnInducements ?? 0,
      dedicatedFansModifier: t.dedicatedFansModifier ?? 0,
      ...(t.conceded && t.concededLegally !== undefined ? { concededLegally: t.concededLegally } : {}),
      ...suffered(t.casualtiesSuffered),
      ...(t.spectators ? { spectators: t.spectators } : {}),
      ...(t.fame ? { fame: t.fame } : {}),
      ...(t.fanFactor ? { fanFactor: t.fanFactor } : {}),
      ...(t.teamValue ? { teamValue: t.teamValue } : {}),
      players: t.players.filter((p) => p.playerId).map((p) => ({
        forkPlayerId: p.playerId,
        name: p.name ?? "",
        td: p.touchdowns,
        cas: p.casualties,
        completions: p.completions,
        interceptions: p.interceptions,
        mvp: p.playerAwards,
        fouls: p.fouls,
        earnedSpps: p.earnedSpps ?? 0,
        injuries: [...p.injuries],
        defecting: p.defecting,
        gainedHatred: [...p.gainedHatred],
        ...counters(p),
      })),
    })),
  };
}

/** The fork's compact finished-game result (no SPP, injuries or fans) as a league result. */
export function fromBasicResult(gameId: string, result: GamestateResult, playedAt?: string): ForkGameResult {
  return {
    gameId,
    source: "basic",
    ...(playedAt ? { playedAt } : {}),
    teams: result.teams.map((t) => ({
      teamId: t.teamId,
      score: t.score,
      ...(t.penaltyScore >= 0 ? { penaltyScore: t.penaltyScore } : {}),
      conceded: t.conceded,
      winnings: t.winnings,
      ...suffered(t.casualtiesSuffered ? { badlyHurt: t.casualtiesSuffered.bh, seriousInjury: t.casualtiesSuffered.si, rip: t.casualtiesSuffered.rip } : undefined),
      players: t.players.filter((p) => p.playerId).map((p) => ({
        forkPlayerId: p.playerId, name: p.name, td: p.touchdowns, cas: p.casualtiesCaused, completions: p.completions,
        interceptions: p.interceptions, mvp: p.mvp, fouls: p.fouls,
        ...counters({ blocks: p.blocks, deflections: p.deflections }),
      })),
    })),
  };
}

/** casualtiesSuffered when the server counted any (all zero / absent = omitted). */
function suffered(c: CasualtiesSuffered | undefined): { casualtiesSuffered?: CasualtiesSuffered } {
  if (!c) return {};
  const v = { badlyHurt: num(c.badlyHurt), seriousInjury: num(c.seriousInjury), rip: num(c.rip) };
  return v.badlyHurt || v.seriousInjury || v.rip ? { casualtiesSuffered: v } : {};
}

const num = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) ? v : 0);

/** The non-zero player statistics counters of a server result row. */
function counters(p: Partial<Record<ForkPlayerCounter, number>>): Partial<Record<ForkPlayerCounter, number>> {
  const out: Partial<Record<ForkPlayerCounter, number>> = {};
  for (const k of FORK_PLAYER_COUNTERS) { const v = num(p[k]); if (v) out[k] = v; }
  return out;
}

const injuryKey = (name: string): string => name.replace(/[^a-z]/gi, "").toLowerCase();
const isDead = (name: string): boolean => ["dead", "deadrip", "rip", "death"].includes(injuryKey(name));

/** The fork's characteristic limits (StatsMechanic.limit, BB2020/BB2025). */
export const STAT_LIMIT = { ma: [1, 9], st: [1, 8], ag: [1, 6], pa: [1, 6], av: [3, 11] } as const;

/** What one server injury does to a league player (BB2025 SeriousInjury names). Every serious injury misses the next game. */
function applyInjury(p: LeaguePlayer, name: string): void {
  const key = injuryKey(name);
  p.missNextGame = true;
  const lower = (stat: "ma" | "st" | "av"): void => { const v = p[stat]; if (v !== null) p[stat] = Math.max(v - 1, STAT_LIMIT[stat][0]); };
  const worse = (stat: "ag" | "pa"): void => { const v = p[stat]; if (v !== null) p[stat] = Math.min(v + 1, STAT_LIMIT[stat][1]); };
  if (key.startsWith("seriousinjury") || key.endsWith("ni")) p.niggling = (p.niggling || 0) + 1;
  else if (key.startsWith("headinjury")) lower("av");
  else if (key.startsWith("smashedknee")) lower("ma");
  else if (key.startsWith("brokenarm")) worse("pa");
  else if (key.startsWith("dislocatedhip")) worse("ag");
  else if (key.startsWith("dislocatedshoulder")) lower("st");
}

function addHatred(p: LeaguePlayer, keywords: string[]): void {
  for (const raw of keywords) {
    const kw = raw.trim();
    if (!kw) continue;
    const label = `Hatred (${kw.charAt(0).toUpperCase()}${kw.slice(1).toLowerCase()})`;
    if (!p.skills.some((s) => s.toLowerCase() === label.toLowerCase())) p.skills.push(label);
  }
}

const retire = (p: LeaguePlayer): FormerPlayer => ({
  playerId: p.playerId,
  ...(p.careerKey ? { careerKey: p.careerKey } : {}),
  ...(p.previousIds ? { previousIds: [...p.previousIds] } : {}),
  name: p.name, position: p.position, level: p.level, stats: { ...p.stats },
});

export interface TeamMutation {
  team: LeagueTeam;
  lines: ForkPlayerLine[];
  /** Players that died or defected (their league playerIds). */
  retired: string[];
}

/**
 * The league team after this game (a new record; the input is not changed). `players` maps the fork player ids that
 * were written for this fixture back to league playerIds; result rows for anyone else (Star Players, mercenaries,
 * journeymen the server added) are recorded as lines without a playerId and change nothing.
 */
export function mutateLeagueTeam(input: LeagueTeam, side: ForkGameTeamResult, map: FixtureForkTeam["players"], source: "full" | "basic"): TeamMutation {
  const team = structuredClone(input);
  const byFork = new Map(map.map((m) => [m.forkPlayerId, m.playerId]));
  const full = source === "full";
  // The players who sat this game out with a missed-next-game have served it (banking recovers prior MNG first).
  if (full) for (const p of team.players) p.missNextGame = false;
  const lines: ForkPlayerLine[] = [];
  const gone = new Set<string>();
  for (const r of side.players) {
    const playerId = byFork.get(r.forkPlayerId);
    const p = playerId ? team.players.find((x) => x.playerId === playerId) : undefined;
    lines.push({
      ...(p ? { playerId: p.playerId } : {}), forkPlayerId: r.forkPlayerId, name: p?.name || r.name, td: r.td, cas: r.cas,
      completions: r.completions, interceptions: r.interceptions, mvp: r.mvp, fouls: r.fouls,
      ...(full ? { spp: side.conceded ? 0 : (r.earnedSpps ?? 0) } : {}), injuries: full ? [...(r.injuries ?? [])] : [],
    });
    if (!p) continue;
    p.stats.td += r.td;
    p.stats.cas += r.cas;
    p.stats.completions += r.completions;
    p.stats.int += r.interceptions;
    p.stats.mvp += r.mvp;
    p.stats.fouls += r.fouls;
    for (const k of FORK_PLAYER_COUNTERS) { const v = num(r[k]); if (v) p.stats[k] = (p.stats[k] ?? 0) + v; }
    if (full) {
      const earned = side.conceded ? 0 : Math.max(0, r.earnedSpps ?? 0);
      p.availableSpp = (p.availableSpp || 0) + earned;
      p.stats.spp += earned;
      addHatred(p, r.gainedHatred ?? []);
      const injuries = r.injuries ?? [];
      // Injuries suffered (the victim's counter): one per game the server recorded a casualty result for the player. A
      // Decay player's two results are one casualty. Counted before a death retires the player, so it follows them.
      if (injuries.length) p.stats.injuries = (p.stats.injuries || 0) + 1;
      if (r.defecting || injuries.some(isDead)) { gone.add(p.playerId); continue; }
      for (const injury of injuries) applyInjury(p, injury);
    }
  }
  // A conceding team's spendable SPP is cleared (banking: currentSpps 0 for the conceding side), from a full result only:
  // a basic result cannot tell what the server did.
  if (full && side.conceded) for (const p of team.players) p.availableSpp = 0;
  for (const id of gone) {
    const i = team.players.findIndex((p) => p.playerId === id);
    if (i < 0) continue;
    const [p] = team.players.splice(i, 1);
    team.formerPlayers.push(retire(p!));
  }
  // The team value is not adjusted here: applyForkResult recomputes it from the mutated roster (teamValue.ts).
  if (full) team.treasury = Math.max(0, (team.treasury ?? 0) - (side.treasurySpent ?? 0) + side.winnings);
  if (full && side.dedicatedFansModifier) team.fans = (team.fans ?? 1) + side.dedicatedFansModifier;
  return { team, lines, retired: [...gone] };
}

/** One side whose fork kickoff team value differed from the league's kickoff figure (informational). */
export interface TeamValueDiff { side: ForkSide; teamId: string; team: string; diff: number; fork: number; leagueKickoff: number }

export type ApplyOutcome =
  | { applied: true; result: FixtureForkResult; retired: Record<ForkSide, string[]>; teamValueDiffs: TeamValueDiff[] }
  | { applied: false; reason: string; already?: boolean };

/**
 * Applies the result to the fixture and both league teams of `season` (in place), once: a fixture that already holds
 * this game's result answers already; one that has a result from elsewhere (entered by hand) is never overwritten.
 */
export function applyForkResult(season: SeasonRecord, fixture: LeagueFixture, result: ForkGameResult, now: Date): ApplyOutcome {
  const fork = fixture.fork;
  if (!fork) return { applied: false, reason: "This fixture was not generated on Super FUMBBL." };
  if (fork.result?.gameId === result.gameId) return { applied: false, already: true, reason: "This result is already applied." };
  if (fork.result) return { applied: false, reason: `The fixture already holds the result of game ${fork.result.gameId}.` };
  if (fork.gameId !== result.gameId) return { applied: false, reason: `Game ${result.gameId} is not this fixture's Super FUMBBL game.` };
  // An auto-forfeit outcome (deadlines.ts) is never a played result: the real game replaces it, rosters included.
  if (fixturePlayed(fixture) && !fixture.deadlineOutcome?.auto) return { applied: false, reason: "The fixture already has a result." };
  const sides: ForkSide[] = ["home", "away"];
  const picked = {} as Record<ForkSide, ForkGameTeamResult>;
  for (const s of sides) {
    const t = fork.teams[s];
    const r = t ? result.teams.find((x) => x.teamId === t.forkTeamId) : undefined;
    if (!t || !r) return { applied: false, reason: `The result does not carry the ${s} team.` };
    picked[s] = r;
  }
  const out = {} as Record<ForkSide, ForkSideResult>;
  const retired = {} as Record<ForkSide, string[]>;
  const teamValueDiffs: TeamValueDiff[] = [];
  for (const s of sides) {
    const ft = fork.teams[s]!;
    const r = picked[s];
    const i = season.teams.findIndex((t) => t.id === ft.teamId);
    let lines: ForkPlayerLine[];
    let diff: number | undefined;
    if (i >= 0) {
      // Like for like (teamValue.ts kickoffTeamValue): the fork's teamValue is its kickoff figure = current team value
      // (missed-game players excluded) + dedicated fans x 10k, so it is compared with the league team BEFORE this
      // result: pre-result current team value + dedicated fans x 10k.
      // A player without a stored value gets his fallback price stored FIRST, so an injury that lowers a characteristic
      // never reprices him below it (the inferred advancement stays in his value).
      storeFallbackValues(season.teams[i]!, season.ruleset);
      const kickoff = kickoffTeamValue(season.teams[i]!, season.ruleset);
      const m = mutateLeagueTeam(season.teams[i]!, r, ft.players, result.source);
      season.teams[i] = m.team;
      // The league is the record: the value is recomputed from the mutated roster; the fork's figure is only compared.
      refreshTeamValues(season, [m.team.id], { now });
      lines = m.lines;
      retired[s] = m.retired;
      if (result.source === "full" && typeof r.teamValue === "number" && r.teamValue > 0 && kickoff !== undefined && r.teamValue !== kickoff) {
        diff = r.teamValue - kickoff;
        teamValueDiffs.push({ side: s, teamId: m.team.id, team: m.team.name, diff, fork: r.teamValue, leagueKickoff: kickoff });
      }
    } else {
      lines = mutateLeagueTeam({ id: ft.teamId, name: "", race: "", coach: "", teamValue: null, treasury: null, rerolls: null, fans: null, assistantCoaches: null,
        cheerleaders: null, apothecary: false, tier: "", raceLeague: "", players: [], formerPlayers: [] }, r, [], result.source).lines;
      retired[s] = [];
    }
    const cas = r.players.reduce((n, p) => n + p.cas, 0);
    out[s] = {
      score: r.score, cas, conceded: r.conceded,
      ...(r.conceded && r.concededLegally !== undefined ? { concededLegally: r.concededLegally } : {}),
      ...suffered(r.casualtiesSuffered),
      ...(r.spectators ? { spectators: r.spectators } : {}),
      ...(r.fame ? { fame: r.fame } : {}),
      ...(r.fanFactor ? { fanFactor: r.fanFactor } : {}),
      ...(result.source === "full" && r.dedicatedFansModifier ? { dedicatedFansModifier: r.dedicatedFansModifier } : {}),
      winnings: r.winnings, lines,
      ...(diff !== undefined ? { forkTeamValueDiff: diff } : {}),
    };
    const side = fixture[s];
    side.score = r.score;
    side.cas = cas;
    side.conceded = r.conceded;
  }
  fixture.suspended = false;
  if (fixture.deadlineOutcome?.auto) delete fixture.deadlineOutcome;
  fixture.finishedAt = result.playedAt ?? now.toISOString();
  const h = picked.home.penaltyScore;
  const a = picked.away.penaltyScore;
  const applied: FixtureForkResult = {
    gameId: result.gameId, source: result.source, appliedAt: now.toISOString(),
    ...(h !== undefined && a !== undefined && h >= 0 && a >= 0 ? { penalty: { home: h, away: a } } : {}),
    ...(result.source === "basic" ? { financialPending: true } : {}),
    home: out.home, away: out.away,
  };
  fork.result = applied;
  fork.status = "finished";
  season.resultsChangedAt = now.toISOString();
  return { applied: true, result: applied, retired, teamValueDiffs };
}

