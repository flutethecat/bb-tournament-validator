// Game page (/app/games/:source/:id, owner 10-30): GET /api/games/:source/:id (src/gameDetail.ts), the hero card's
// crests filled from the race crest manifest like the Past Games strip. Types mirror the server's GameDetail.

import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import { resolveCrest, type ArtManifests } from "../tabletop/art";
import type { RecentSide } from "../home/recent";
import type { MatchSummaryView } from "../components/TabletopMatchSummary.vue";

export type GameSource = "tournament" | "tabletop" | "online";
export const GAME_SOURCES: readonly GameSource[] = ["tournament", "tabletop", "online"];
export const isGameSource = (v: unknown): v is GameSource => typeof v === "string" && (GAME_SOURCES as readonly string[]).includes(v);

export interface GamePlayerLine {
  name: string; touchdowns: number; casualtiesCaused: number; completions: number; interceptions: number; deflections: number; mvp: number;
  sppEarned?: number; sentOff?: boolean; injury?: string;
}
export interface Tally { name: string; count: number }
export interface GameTeamSummary {
  mvps: string[]; scorers: Tally[]; casualtyMakers: Tally[]; players: GamePlayerLine[];
  casualtiesSuffered: { bh: number; si: number; rip: number } | null;
}
export interface GameSummary {
  playedAt: string | null; competition: string; round: number | null;
  tournament: { id: string; name: string; href: string } | null;
  casualties: { home: number | null; away: number | null };
  concede: "home" | "away" | null; perPlayer: boolean; note: string | null;
  home: GameTeamSummary | null; away: GameTeamSummary | null;
}
export interface ReporterMoment { half: string | number | null; turn: number | null; side: "home" | "away"; kind: "touchdown" | "casualty" | "sendOff"; text: string }
export interface GameReporter {
  matchId: string; href: string; state: string;
  summaries: { home: MatchSummaryView; away: MatchSummaryView } | null;
  moments: ReporterMoment[];
}
export interface GameCard {
  context: string; home: RecentSide; away: RecentSide; playedAt: string | null; href: null;
  concede: "home" | "away" | null; suspended: boolean;
}
export interface GameDetail { source: GameSource; id: string; card: GameCard; summary: GameSummary; reporter?: GameReporter }

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
