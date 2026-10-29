/**
 * Play on Super FUMBBL: a finished fork game's result, applied to the league fixture and the two league teams (pure).
 *
 * Server numbers only (SERVER-DERIVED law): the score, casualties, concession, winnings, the per-player counters and,
 * from a full result (the server's FumbblResult), the SPP each player earned, the serious injuries it recorded and the
 * dedicated-fans change. The league team record is changed the way result banking changes a fork team file
 * (src/site-backend/fumbblResultBanking.ts): last game's missed-next-game players recover, earned SPP is added to the
 * spendable balance (a conceding team's balance is cleared), counters are added, injuries land (MNG; niggling +1;
 * characteristic losses; a death or a defection retires the player to former players), treasury = treasury - the part
 * of it spent on inducements + winnings, dedicated fans + the server's modifier. Seasons played is never touched.
 *
 * A "basic" result (the fork's finished-game listing without the FumbblResult body) carries no SPP, injuries or fan
 * change: those parts are left as they are and the fixture records source "basic".
 */
import type { GamestateResult } from "@bb/fork-ops";
import type { ParsedGameResult } from "../site-backend/fumbblResult.js";
import { fixturePlayed } from "./tourplay.js";
import type {
  FixtureForkResult, FixtureForkTeam, ForkPlayerLine, ForkSide, ForkSideResult, FormerPlayer, LeagueFixture, LeaguePlayer, LeagueTeam, SeasonRecord,
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
      players: t.players.filter((p) => p.playerId).map((p) => ({
        forkPlayerId: p.playerId, name: p.name, td: p.touchdowns, cas: p.casualtiesCaused, completions: p.completions,
        interceptions: p.interceptions, mvp: p.mvp, fouls: p.fouls,
      })),
    })),
  };
}

const injuryKey = (name: string): string => name.replace(/[^a-z]/gi, "").toLowerCase();
const isDead = (name: string): boolean => ["dead", "deadrip", "rip", "death"].includes(injuryKey(name));

/** What one server injury does to a league player (BB2025 SeriousInjury names). Every serious injury misses the next game. */
function applyInjury(p: LeaguePlayer, name: string): void {
  const key = injuryKey(name);
  p.missNextGame = true;
  if (key.startsWith("seriousinjury") || key.endsWith("ni")) p.niggling = (p.niggling || 0) + 1;
  else if (key.includes("av") && key.startsWith("headinjury")) { if (p.av !== null) p.av -= 1; }
  else if (key.startsWith("smashedknee")) { if (p.ma !== null) p.ma -= 1; }
  else if (key.startsWith("brokenarm")) { if (p.pa !== null) p.pa += 1; }
  else if (key.startsWith("dislocatedhip")) { if (p.ag !== null) p.ag += 1; }
  else if (key.startsWith("dislocatedshoulder")) { if (p.st !== null) p.st -= 1; }
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
    if (full) {
      const earned = side.conceded ? 0 : Math.max(0, r.earnedSpps ?? 0);
      p.availableSpp = (p.availableSpp || 0) + earned;
      p.stats.spp += earned;
      addHatred(p, r.gainedHatred ?? []);
      const injuries = r.injuries ?? [];
      if (r.defecting || injuries.some(isDead)) { gone.add(p.playerId); continue; }
      for (const injury of injuries) applyInjury(p, injury);
    }
  }
  // A conceding team's spendable SPP is cleared (banking: currentSpps 0 for the conceding side).
  if (side.conceded) for (const p of team.players) p.availableSpp = 0;
  let lost = 0;
  for (const id of gone) {
    const i = team.players.findIndex((p) => p.playerId === id);
    if (i < 0) continue;
    const [p] = team.players.splice(i, 1);
    lost += p!.value ?? 0;
    team.formerPlayers.push(retire(p!));
  }
  if (team.teamValue !== null && lost) team.teamValue = Math.max(0, team.teamValue - lost);
  if (full || side.winnings) team.treasury = Math.max(0, (team.treasury ?? 0) - (side.treasurySpent ?? 0) + side.winnings);
  if (full && side.dedicatedFansModifier) team.fans = (team.fans ?? 1) + side.dedicatedFansModifier;
  return { team, lines, retired: [...gone] };
}

export type ApplyOutcome =
  | { applied: true; result: FixtureForkResult; retired: Record<ForkSide, string[]> }
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
  if (fixturePlayed(fixture)) return { applied: false, reason: "The fixture already has a result." };
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
  for (const s of sides) {
    const ft = fork.teams[s]!;
    const r = picked[s];
    const i = season.teams.findIndex((t) => t.id === ft.teamId);
    let lines: ForkPlayerLine[];
    if (i >= 0) {
      const m = mutateLeagueTeam(season.teams[i]!, r, ft.players, result.source);
      season.teams[i] = m.team;
      lines = m.lines;
      retired[s] = m.retired;
    } else {
      lines = mutateLeagueTeam({ id: ft.teamId, name: "", race: "", coach: "", teamValue: null, treasury: null, rerolls: null, fans: null, assistantCoaches: null,
        cheerleaders: null, apothecary: false, tier: "", raceLeague: "", players: [], formerPlayers: [] }, r, [], result.source).lines;
      retired[s] = [];
    }
    const cas = r.players.reduce((n, p) => n + p.cas, 0);
    out[s] = { score: r.score, cas, conceded: r.conceded, winnings: r.winnings, lines };
    const side = fixture[s];
    side.score = r.score;
    side.cas = cas;
    side.conceded = r.conceded;
  }
  fixture.suspended = false;
  fixture.finishedAt = result.playedAt ?? now.toISOString();
  const h = picked.home.penaltyScore;
  const a = picked.away.penaltyScore;
  const applied: FixtureForkResult = {
    gameId: result.gameId, source: result.source, appliedAt: now.toISOString(),
    ...(h !== undefined && a !== undefined && h >= 0 && a >= 0 ? { penalty: { home: h, away: a } } : {}),
    home: out.home, away: out.away,
  };
  fork.result = applied;
  fork.status = "finished";
  return { applied: true, result: applied, retired };
}
