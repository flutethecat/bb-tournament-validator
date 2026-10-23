// Same-origin JSON calls. Identity rides the Discord session cookie (cw_session); every write carries the
// X-CW-Auth CSRF header the server requires for cookie-authenticated writes.

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["x-cw-auth"] = "1";
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.");
  }
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty / non-JSON body */ }
  if (!res.ok) {
    const msg = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : `Request failed (${res.status}).`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export interface SessionInfo {
  authenticated: boolean;
  coach?: string;
  discordSsoEnabled?: boolean;
}

export interface LibraryTeam {
  teamId: string;
  teamName: string;
  race: string;
  teamValue: number;
  forkLoadable?: boolean;
}

export interface LobbyTeam { teamId: string; teamName: string; race: string; teamValue?: number }

export interface SeatView {
  coach: string;
  role: "creator" | "opponent";
  team: LobbyTeam | null;
  state: "here" | "left" | "client" | "not-here-yet";
  side: "home" | "away" | null;
}

export interface ChatMessage { id: number; coach: string; text: string; ts: number }

export interface LobbyView {
  id: string;
  me: "creator" | "opponent";
  createdAt: number;
  expiresAt: number;
  startedAt: number | null;
  status: "waiting" | "ready" | "lapsed";
  creator: SeatView;
  opponent: SeatView;
  game: { gameName: string; gameId: string | null } | null;
  bothPresent: boolean;
  canLaunch: boolean;
  chat?: ChatMessage[];
}

export interface PendingChallenge { coach: string; teamId: string; opponent: string; createdAt: number; lobbyId?: string }

export interface RosterPlayer {
  number: number; name: string; position: string | null; skills: string[]; injuries: string[]; spp: number;
  value: number; ma: number | null; st: number | null; ag: number | null; pa: number | null; av: number | null; mng: boolean;
}

export interface Roster {
  teamId: string; name: string; race: string; teamValue: number; treasury: number; rerolls: number;
  apothecary: boolean; fanFactor: number; assistantCoaches: number; cheerleaders: number; players: RosterPlayer[];
}
