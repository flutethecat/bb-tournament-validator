// Game page (/app/games/:source/:id, owner 10-30): GET /api/games/:source/:id (src/gameDetail.ts), the hero card's
// crests filled from the race crest manifest like the Past Games strip. Types mirror the server's GameDetail.

import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import { resolveCrest, type ArtManifests } from "../tabletop/art";
import type { RecentSide } from "../home/recent";
import type { MatchSummaryView } from "../tabletop/finished";

export type GameSource = "tournament" | "tabletop" | "online";
export const GAME_SOURCES: readonly GameSource[] = ["tournament", "tabletop", "online"];
export const isGameSource = (v: unknown): v is GameSource => typeof v === "string" && (GAME_SOURCES as readonly string[]).includes(v);

export interface GamePlayerLine {
  name: string; touchdowns: number; casualtiesCaused: number; completions: number; interceptions: number; deflections: number; mvp: number;
  sppEarned?: number; sentOff?: boolean; injury?: string;
  /** Roster position (league season roster), fouls the server counted, and MNG only when the server's injury text says so. */
  position?: string; fouls?: number; missNextGame?: true;
  /** The player's place in the team's squad (the result's order): tells same-named players apart. */
  index?: number;
}
export interface Tally { name: string; count: number }
export interface GameTeamSummary {
  mvps: string[]; scorers: Tally[]; casualtyMakers: Tally[]; players: GamePlayerLine[];
  casualtiesSuffered: { bh: number; si: number; rip: number } | null;
  /** Every player the result lists, in its own order. */
  squad?: GamePlayerLine[];
  /** Fork games: winnings (gold); a banked league result: the server's fan factor and dedicated-fans change. */
  winnings?: number; fanFactor?: number; dedicatedFansModifier?: number;
}
export interface GameSummary {
  playedAt: string | null; competition: string; round: number | null;
  tournament: { id: string; name: string; href: string } | null;
  casualties: { home: number | null; away: number | null };
  concede: "home" | "away" | null; perPlayer: boolean; note: string | null;
  /** The server's legal-concession verdict for the conceding side, when known. */
  concededLegally?: boolean;
  home: GameTeamSummary | null; away: GameTeamSummary | null;
  /** An organiser changed the result the tournament counts for this game (the page keeps the game as played). */
  edited?: GameResultEdit;
}
export interface GameResultEdit {
  by: string; at: string; cleared?: true;
  result?: { home: { coach: string; score: number; cas: number | null }; away: { coach: string; score: number; cas: number | null } };
}

/** "Edited by organiser" line on the game page: the result the tournament counts, or that it was cleared. */
export function editedLine(e: GameResultEdit | undefined): string {
  if (!e) return "";
  const day = Number.isFinite(Date.parse(e.at)) ? new Date(e.at).toISOString().slice(0, 10) : "";
  const who = `${e.by || "An organiser"}${day ? ` on ${day}` : ""}`;
  if (e.cleared || !e.result) return `The tournament result of this game was cleared by ${who}. The game below is shown as played.`;
  const { home, away } = e.result;
  const cas = home.cas !== null && away.cas !== null ? ` (CAS ${home.cas} - ${away.cas})` : "";
  return `The tournament counts ${home.coach} ${home.score} - ${away.score} ${away.coach}${cas}, set by ${who}. The game below is shown as played.`;
}
export type ReporterMomentKind =
  | "touchdown" | "casualty" | "sendOff"
  | "injury" | "completion" | "interception" | "deflection" | "kickoff" | "weather" | "halfStart" | "concession";
export interface ReporterMoment {
  /** side null: a moment of the whole game (kick-off, weather, half start; an online game's replay only). */
  half: string | number | null; turn: number | null; side: "home" | "away" | null; kind: ReporterMomentKind; text: string;
  player?: string; victim?: string; victimSide?: "home" | "away"; result?: string;
  /** The actor's / victim's place in their team's squad. */
  playerIndex?: number; victimIndex?: number;
  /** Replay moments: the apothecary outcome on a casualty, a touchdown awarded on a concession, the concession verdict. */
  apothecary?: string; awarded?: true; legal?: boolean;
}
export interface GameReporter {
  matchId: string; href: string; state: string;
  summaries: { home: MatchSummaryView; away: MatchSummaryView } | null;
  moments: ReporterMoment[];
  /** "replay": an online game's moments read from the fork's replay (no recorder behind it). */
  source?: "replay";
}
/** An online game's turn-ordered log: read ("ready"), still to be read ("pending"), or not readable. */
export type ReplayState = "pending" | "unavailable" | "ready";
export interface GameCard {
  context: string; home: RecentSide; away: RecentSide; playedAt: string | null; href: null;
  concede: "home" | "away" | null; suspended: boolean;
}
export interface GameDetail { source: GameSource; id: string; card: GameCard; summary: GameSummary; reporter?: GameReporter; replay?: ReplayState }

export const gameApiPath = (source: GameSource, id: string): string => `/api/games/${source}/${encodeURIComponent(id)}`;

export type GameLoad = { status: "ok"; game: GameDetail } | { status: "missing" } | { status: "error"; message: string };

const isSide = (s: unknown): s is RecentSide => !!s && typeof s === "object" && typeof (s as RecentSide).name === "string";

/** The game, "missing" on a 404 (or an answer that is not a game), "error" otherwise. */
export async function loadGameDetail(api: Fetcher, source: GameSource, id: string): Promise<GameLoad> {
  let game: GameDetail;
  try {
    game = await api<GameDetail>(gameApiPath(source, id));
  } catch (e) {
    // Duck-typed: an ApiError from another module instance (SSR) still carries its status.
    if (e instanceof ApiError ? e.status === 404 : (e as { status?: unknown } | null)?.status === 404) return { status: "missing" };
    return { status: "error", message: "The game could not be loaded. Try again in a moment." };
  }
  if (!game || typeof game !== "object" || !game.card || !isSide(game.card.home) || !isSide(game.card.away) || !game.summary) return { status: "missing" };
  let art: ArtManifests = {};
  try { art = { crests: await api<{ crests?: Record<string, string> }>("/crests/manifest.json") }; } catch { /* initials */ }
  const crest = (s: RecentSide): RecentSide => ({ ...s, crestUrl: s.crestUrl || resolveCrest(art, s.race) || null });
  return { status: "ok", game: { ...game, card: { ...game.card, home: crest(game.card.home), away: crest(game.card.away) } } };
}
