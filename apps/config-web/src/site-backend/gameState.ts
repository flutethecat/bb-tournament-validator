/**
 * In-memory game registry backing `xml:gamestate?op=check|options|create|resume|update|remove`
 * (spec §3, TP-4). config-web plays fumbbl.com's role: the fork asks whether a matchup can play and
 * which options apply, registers the game on create, streams half/turn/score on update, and removes it
 * after the result upload is banked.
 *
 * TP-4 — FAIL LOUD. Every handler returns an explicit `<result>error</result><reason>…</reason>` for a
 * malformed/unknown-team/unexpected-state condition. A silently-wrong `<options>` block is quiet DATA
 * LOSS (the fork would run the game and then the upload could be rejected/mis-ruled), so "when unsure,
 * error" is the rule, never "when unsure, ok with empty options".
 *
 * OPTIONS PARITY (cited): `ServerCommandHandlerScheduleGame` (the standalone scheduler) sets exactly ONE
 * game option — `OVERTIME`, and only when the schedule asked for it (`:41-43`); everything else falls to
 * `GameOptionFactory` defaults, which are identical whether the fork runs standalone or connected. So the
 * faithful options block = `OVERTIME` iff the game was scheduled overtime, nothing more. `TEST_MODE` is
 * added for `test:`-prefixed games only (rig discipline), injected by the caller.
 *
 * This is process-local (like the Matchmaker's poll state and the fork's own single-process game cache).
 * The result-banking ledger (banking.ts) is the DURABLE record; the registry is live-session routing.
 */

export interface GameOption {
  name: string;
  value: string;
}

export type GameStatus = "checked" | "active" | "resumed" | "removed";

export interface RegisteredGame {
  gameId: string;
  team1: string;
  team2: string;
  options: GameOption[];
  status: GameStatus;
  half: number;
  turn: number;
  score1: number;
  score2: number;
  spectators: number;
}

/** A handler outcome: either an ok gamestate (optionally with options) or a loud error (TP-4). */
export type GameStateOutcome =
  | { ok: true; gameId?: string; options?: GameOption[] }
  | { ok: false; reason: string };

export interface GameStateRegistryOptions {
  /** Resolve the default options for a matchup — OVERTIME/TEST_MODE parity. Pure; caller injects policy. */
  optionsFor?: (team1: string, team2: string) => GameOption[];
  /** Ownership/existence guard: does this team resolve to a real team in the store? (TP-4 unknown-team.) */
  teamExists?: (teamId: string) => boolean;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Serialize an outcome to the fork's expected `<gamestate>` document (`FumbblGameState` schema). */
export function renderGameState(outcome: GameStateOutcome): string {
  if (!outcome.ok) {
    return `<gamestate><result>error</result><reason>${esc(outcome.reason)}</reason></gamestate>`;
  }
  const opts = outcome.options ?? [];
  const optionsXml = opts.map((o) => `<option name="${esc(o.name)}" value="${esc(o.value)}"/>`).join("");
  const gameIdXml = outcome.gameId ? `<gameid>${esc(outcome.gameId)}</gameid>` : "";
  return `<gamestate><result>ok</result>${gameIdXml}<options>${optionsXml}</options></gamestate>`;
}

export class GameStateRegistry {
  private readonly games = new Map<string, RegisteredGame>();
  private readonly optionsFor: (t1: string, t2: string) => GameOption[];
  private readonly teamExists: (teamId: string) => boolean;

  constructor(opts: GameStateRegistryOptions = {}) {
    this.optionsFor = opts.optionsFor ?? (() => []);
    this.teamExists = opts.teamExists ?? (() => true);
  }

  get(gameId: string): RegisteredGame | undefined {
    return this.games.get(gameId);
  }

  /** op=check / op=options — the fork asks "can these two play, and with which options?". */
  check(team1: string | undefined, team2: string | undefined): GameStateOutcome {
    if (!team1 || !team2) return { ok: false, reason: "check requires team1 and team2" };
    if (!this.teamExists(team1)) return { ok: false, reason: `unknown team1 ${team1}` };
    if (!this.teamExists(team2)) return { ok: false, reason: `unknown team2 ${team2}` };
    return { ok: true, options: this.optionsFor(team1, team2) };
  }

  /** op=create — register a new game under the fork-supplied gameId. */
  create(gameId: string | undefined, team1: string | undefined, team2: string | undefined): GameStateOutcome {
    if (!gameId || !team1 || !team2) return { ok: false, reason: "create requires game, team1 and team2" };
    if (!this.teamExists(team1) || !this.teamExists(team2)) return { ok: false, reason: "create references an unknown team" };
    const options = this.optionsFor(team1, team2);
    this.games.set(gameId, { gameId, team1, team2, options, status: "checked", half: 0, turn: 0, score1: 0, score2: 0, spectators: 0 });
    return { ok: true, gameId, options };
  }

  /** op=resume — a game returning after interruption; must already exist. */
  resume(gameId: string | undefined, state: Partial<RegisteredGame>): GameStateOutcome {
    if (!gameId) return { ok: false, reason: "resume requires game" };
    const g = this.games.get(gameId);
    if (!g) return { ok: false, reason: `resume of unknown game ${gameId}` };
    Object.assign(g, state, { status: "resumed" as GameStatus });
    return { ok: true, gameId, options: g.options };
  }

  /** op=update — live half/turn/score/spectators tick; must already exist (unknown ⇒ loud error). */
  update(gameId: string | undefined, state: Partial<RegisteredGame>): GameStateOutcome {
    if (!gameId) return { ok: false, reason: "update requires gameid" };
    const g = this.games.get(gameId);
    if (!g) return { ok: false, reason: `update of unknown game ${gameId}` };
    Object.assign(g, state, { status: "active" as GameStatus });
    return { ok: true, gameId };
  }

  /** op=remove — retire a finished game (the fork calls this after a successful result upload). */
  remove(gameId: string | undefined): GameStateOutcome {
    if (!gameId) return { ok: false, reason: "remove requires gameid" };
    const g = this.games.get(gameId);
    if (!g) return { ok: false, reason: `remove of unknown game ${gameId}` };
    g.status = "removed";
    this.games.delete(gameId);
    return { ok: true, gameId };
  }
}
