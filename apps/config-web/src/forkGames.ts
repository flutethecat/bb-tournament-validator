import {
  adminList,
  parseAdminGameList,
  type ForkAdminConfig,
} from "@bb/fork-ops";

export interface ForkGame {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  homeCoach: string;
  awayCoach: string;
  half: number;
  turn: number;
  started: string;
}

export type ForkGamesEndpointResult =
  | { status: 200; body: ForkGame[] }
  | { status: 401; body: { error: string } }
  | { status: 502; body: { error: string } };

const decodeXml = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const finiteNumber = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * `AdminServlet.handleList` serves `/admin/list?status=active`; its XML game/team shape
 * comes from `AdminListEntry.addToXml` in the fork's ffb-server admin module.
 */
export async function fetchActiveForkGames(cfg: ForkAdminConfig): Promise<ForkGame[]> {
  const xml = await adminList(cfg, "active");
  if (!/<status>\s*ok\s*<\/status>/i.test(xml)) throw new Error("fork admin list failed");

  return parseAdminGameList(xml).map((game) => ({
    gameId: decodeXml(game.gameId),
    homeTeam: decodeXml(game.homeTeamName),
    awayTeam: decodeXml(game.awayTeamName),
    homeCoach: decodeXml(game.homeCoach),
    awayCoach: decodeXml(game.awayCoach),
    half: finiteNumber(game.half),
    turn: finiteNumber(game.turn),
    started: decodeXml(game.started ?? ""),
  }));
}

export async function forkGamesEndpoint(
  authenticated: boolean,
  cfg: ForkAdminConfig | undefined,
): Promise<ForkGamesEndpointResult> {
  if (!authenticated) return { status: 401, body: { error: "Authentication required." } };
  if (!cfg) return { status: 502, body: { error: "fork server unreachable" } };

  try {
    return { status: 200, body: await fetchActiveForkGames(cfg) };
  } catch {
    return { status: 502, body: { error: "fork server unreachable" } };
  }
}
