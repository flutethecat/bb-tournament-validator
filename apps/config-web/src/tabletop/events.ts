/**
 * Tabletop match recorder - the append-only match event model (spec Part 4 / lane T1).
 *
 * Events are NEVER edited or deleted. A mistake is corrected by a reversing `undo` event that names
 * the event it reverses; `effectiveEvents()` is the single place that resolves that, and everything
 * downstream (post-match function, results row, summaries) reads only the effective list.
 *
 * Identity law: `by` is the proven session coach, set by the server, never taken from a request.
 * De-dup law: `id` is a client-supplied uuid-like token; re-posting an id is a no-op (offline queue).
 *
 * Team side: "home" | "away" (the seat in the match record), not a team id. For `casualty` the event's
 * `team` is the side that INFLICTED it (and earns the SPP), `player` is the inflictor, and
 * `payload.victim` is a player id on `payload.victimTeam` (default: the other side).
 */

export const EVENT_TYPES = [
  "touchdown", "casualty", "completion", "interception", "deflection", "mvp", "sendOff", "fanChange", "undo",
] as const;
export type TabletopEventType = (typeof EVENT_TYPES)[number];
export type Side = "home" | "away";
export const otherSide = (s: Side): Side => (s === "home" ? "away" : "home");

export const CASUALTY_RESULTS = ["BH", "MNG", "NI", "stat loss", "DEAD"] as const;
export type CasualtyResult = (typeof CASUALTY_RESULTS)[number];
export const STATS = ["MA", "ST", "AG", "PA", "AV"] as const;
export type StatName = (typeof STATS)[number];
export const CASUALTY_CAUSES = ["block", "foul", "other"] as const;
export type CasualtyCause = (typeof CASUALTY_CAUSES)[number];

export interface TabletopEvent {
  id: string;
  matchId: string;
  type: TabletopEventType;
  team: Side;
  player?: string;
  turn?: number;
  half?: 1 | 2 | 3;
  /** casualty: {victim, victimTeam?, result, apothecaryUsed, stat?, cause?}; fanChange: {delta: -1|0|1};
   *  undo: {target: eventId}; others: {}. */
  payload: Record<string, unknown>;
  ts: string;
  by: string;
}

/** What validation needs to know about a roster (the team file satisfies this structurally). */
export interface RosterView {
  players: ReadonlyArray<{ id: string; mng?: boolean; dead?: boolean }>;
}
export type RosterPair = Record<Side, RosterView>;

export const MAX_EVENTS_PER_MATCH = 2000;
export const MAX_EVENTS_PER_BATCH = 100;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PLAYER_RE = /^[\w.:-]{1,64}$/;
const ACTING_TYPES: ReadonlySet<TabletopEventType> = new Set(["touchdown", "completion", "interception", "deflection", "mvp", "sendOff"]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Events that count: every non-undo event not reversed by an undo. */
export function effectiveEvents(events: readonly TabletopEvent[]): TabletopEvent[] {
  const undone = new Set<string>();
  for (const e of events) if (e.type === "undo" && typeof e.payload.target === "string") undone.add(e.payload.target);
  return events.filter((e) => e.type !== "undo" && !undone.has(e.id));
}

export type ParseResult = { ok: true; event: TabletopEvent } | { ok: false; error: string };

/** Shape-check one raw wire event and stamp the server-owned fields (matchId, by). No roster logic. */
export function parseEvent(raw: unknown, matchId: string, by: string, nowIso: string): ParseResult {
  if (!isObj(raw)) return { ok: false, error: "event must be an object." };
  const { id, type, team, player, turn, half, payload, ts } = raw;
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: "event.id must be 8-64 chars of [A-Za-z0-9_-] (a client uuid)." };
  if (typeof type !== "string" || !(EVENT_TYPES as readonly string[]).includes(type)) return { ok: false, error: `event ${id}: unknown type.` };
  if (type !== "undo" && team !== "home" && team !== "away") return { ok: false, error: `event ${id}: team must be "home" or "away".` };
  if (player !== undefined && (typeof player !== "string" || !PLAYER_RE.test(player))) return { ok: false, error: `event ${id}: player must be a player id.` };
  if (turn !== undefined && (!Number.isInteger(turn) || (turn as number) < 0 || (turn as number) > 99)) return { ok: false, error: `event ${id}: turn must be a small integer.` };
  if (half !== undefined && ![1, 2, 3].includes(half as number)) return { ok: false, error: `event ${id}: half must be 1, 2 or 3.` };
  if (payload !== undefined && !isObj(payload)) return { ok: false, error: `event ${id}: payload must be an object.` };
  if (ts !== undefined && (typeof ts !== "string" || Number.isNaN(Date.parse(ts)))) return { ok: false, error: `event ${id}: ts must be an ISO timestamp.` };
  const p: Record<string, unknown> = { ...(isObj(payload) ? payload : {}) };
  if (JSON.stringify(p).length > 2048) return { ok: false, error: `event ${id}: payload too large.` };
  return {
    ok: true,
    event: {
      id,
      matchId,
      type: type as TabletopEventType,
      team: (type === "undo" ? "home" : team) as Side, // an undo's team is rewritten to its target's
      ...(player !== undefined ? { player: player as string } : {}),
      ...(turn !== undefined ? { turn: turn as number } : {}),
      ...(half !== undefined ? { half: half as 1 | 2 | 3 } : {}),
      payload: p,
      ts: typeof ts === "string" ? new Date(ts).toISOString() : nowIso,
      by,
    },
  };
}

/**
 * Validate `event` as the next event after `stored` (already-accepted, in order) for rosters `rosters`.
 * Returns `{error}` or the normalised event to store (an undo takes its target's team; a casualty gets
 * its defaults filled in).
 */
export function validateEvent(event: TabletopEvent, stored: readonly TabletopEvent[], rosters: RosterPair): { error: string } | { event: TabletopEvent } {
  const fail = (error: string) => ({ error: `event ${event.id}: ${error}` });
  if (event.type === "undo") {
    const target = event.payload.target;
    if (typeof target !== "string") return fail("undo needs payload.target (an event id).");
    const t = stored.find((e) => e.id === target);
    if (!t) return fail("undo target not found in this match.");
    if (t.type === "undo") return fail("an undo cannot be undone; record the event again instead.");
    if (stored.some((e) => e.type === "undo" && e.payload.target === target)) return fail("target already undone.");
    return { event: { ...event, team: t.team } };
  }

  const live = effectiveEvents(stored);
  const find = (side: Side, id: string) => rosters[side].players.find((p) => p.id === id);
  const unavailable = (side: Side, id: string): string | undefined => {
    const p = find(side, id);
    if (!p) return `player ${id} is not on the ${side} team.`;
    if (p.dead) return `player ${id} is dead.`;
    if (p.mng) return `player ${id} is missing the next game and cannot take part.`;
    for (const e of live) {
      if (e.type === "casualty" && e.payload.victim === id && (e.payload.victimTeam ?? otherSide(e.team)) === side && e.payload.result === "DEAD")
        return `player ${id} was killed earlier in this match.`;
      if (e.type === "sendOff" && e.player === id && e.team === side) return `player ${id} was sent off earlier in this match.`;
    }
    return undefined;
  };

  if (ACTING_TYPES.has(event.type)) {
    if (!event.player) return fail(`${event.type} needs a player.`);
    const bad = unavailable(event.team, event.player);
    if (bad) return fail(bad);
    if (event.type === "mvp" && live.some((e) => e.type === "mvp" && e.team === event.team)) return fail("this team already has an MVP.");
    return { event };
  }

  if (event.type === "fanChange") {
    const d = event.payload.delta;
    if (d !== -1 && d !== 0 && d !== 1) return fail("fanChange payload.delta must be -1, 0 or 1.");
    if (live.some((e) => e.type === "fanChange" && e.team === event.team)) return fail("this team already has a fan change.");
    return { event };
  }

  // casualty
  const p = event.payload;
  if (typeof p.victim !== "string") return fail("casualty needs payload.victim (a player id).");
  const victimTeam = p.victimTeam === undefined ? otherSide(event.team) : p.victimTeam;
  if (victimTeam !== "home" && victimTeam !== "away") return fail('payload.victimTeam must be "home" or "away".');
  if (typeof p.result !== "string" || !(CASUALTY_RESULTS as readonly string[]).includes(p.result))
    return fail(`payload.result must be one of ${CASUALTY_RESULTS.join(", ")}.`);
  if (p.apothecaryUsed !== undefined && typeof p.apothecaryUsed !== "boolean") return fail("payload.apothecaryUsed must be a boolean.");
  if (p.result === "stat loss" && !(STATS as readonly string[]).includes(p.stat as string)) return fail(`stat loss needs payload.stat (${STATS.join(", ")}).`);
  if (p.cause !== undefined && !(CASUALTY_CAUSES as readonly string[]).includes(p.cause as string)) return fail("payload.cause must be block, foul or other.");
  if (event.player) {
    const bad = unavailable(event.team, event.player);
    if (bad) return fail(bad);
  }
  const vbad = unavailable(victimTeam, p.victim);
  if (vbad) return fail(vbad);
  if (live.some((e) => e.type === "casualty" && e.payload.victim === p.victim && (e.payload.victimTeam ?? otherSide(e.team)) === victimTeam))
    return fail(`player ${p.victim} already suffered a casualty in this match.`);
  return {
    event: {
      ...event,
      payload: { ...p, victimTeam, apothecaryUsed: p.apothecaryUsed === true, cause: p.cause ?? "block" },
    },
  };
}
