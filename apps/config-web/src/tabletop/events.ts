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

/** Events a coach may post (the TourPlay grid). `sentOff` is accepted as an alias of `sendOff`. */
export const EVENT_TYPES = [
  "touchdown", "casualty", "injury", "completion", "catch", "throwTeamMate", "interception", "deflection", "foul",
  "sendOff", "stalling", "secretObjective", "mvp", "weather", "concede", "endOfMatch", "fanChange", "undo",
] as const;
/** Server-written events (pre-game steps, the timer agreement, turn ends), written ONLY by the server's routes (rolls are server-side). Pre-game `weather` is
 *  the same type as the mid-game one, marked `payload.pregame: true`. */
export const PREGAME_EVENT_TYPES = ["seats", "fans", "journeyman", "inducement", "prayer", "coinFlip", "timerAgree", "turnEnd", "turnSet", "pregameSkip"] as const;
export type TabletopEventType = (typeof EVENT_TYPES)[number] | (typeof PREGAME_EVENT_TYPES)[number];

export const WEATHER_RESULTS = ["Sweltering Heat", "Very Sunny", "Perfect Conditions", "Pouring Rain", "Blizzard"] as const;
export const INJURY_RESULTS = ["stunned", "KO"] as const;
/** An `injury` event may also carry a lasting result (the casualty table's), for a player hurt with no one to credit. */
export const LASTING_INJURY_RESULTS = ["BH", "MNG", "NI", "stat loss", "DEAD"] as const;
export type Half = 1 | 2 | "OT";
export type Side = "home" | "away";
export const otherSide = (s: Side): Side => (s === "home" ? "away" : "home");
/** Did this event kill player `id` of `side`? A casualty DEAD on the victim, or an injury DEAD (team = the victim's side). */
export function killsPlayer(e: Pick<TabletopEvent, "type" | "team" | "player" | "payload">, id: string, side: Side): boolean {
  if (e.payload.result !== "DEAD") return false;
  if (e.type === "casualty") return e.payload.victim === id && (e.payload.victimTeam ?? otherSide(e.team)) === side;
  return e.type === "injury" && e.player === id && e.team === side;
}

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
  half?: Half;
  /** casualty: {victim, victimTeam?, result, apothecaryUsed, stat?, cause?}; injury (team = the hurt player's side, player = the victim, no SPP): {result: stunned|KO|BH|MNG|NI|stat loss|DEAD, stat? (stat loss), apothecaryUsed?};
   *  throwTeamMate: {superb, landed, thrower? (required iff superb), thrown? (required iff landed)}; secretObjective: {text}; weather (mid-game): {result}; fanChange: {delta: -1|0|1};
   *  undo: {target: eventId}; others: {}. */
  payload: Record<string, unknown>;
  ts: string;
  by: string;
  /** Stamped by the server when an organiser records (or undoes) an event for a team they do not coach; persisted and replayed. */
  admin?: boolean;
}

/** What validation needs to know about a roster (the team file satisfies this structurally). */
export interface RosterView {
  players: ReadonlyArray<{ id: string; mng?: boolean; dead?: boolean; skills?: readonly string[]; kind?: string }>;
}
export type RosterPair = Record<Side, RosterView>;

export const MAX_EVENTS_PER_MATCH = 2000;
export const MAX_EVENTS_PER_BATCH = 100;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PLAYER_RE = /^[\w.:-]{1,64}$/;
const ACTING_TYPES: ReadonlySet<TabletopEventType> = new Set([
  "touchdown", "completion", "catch", "interception", "deflection", "foul", "stalling", "mvp", "sendOff", "injury",
]);

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
  const { id, team, player, turn, half, payload, ts } = raw;
  const type = raw.type === "sentOff" ? "sendOff" : raw.type;
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: "event.id must be 8-64 chars of [A-Za-z0-9_-] (a client uuid)." };
  if (typeof type !== "string" || !(EVENT_TYPES as readonly string[]).includes(type)) return { ok: false, error: `event ${id}: unknown type.` };
  const teamless = type === "undo" || type === "weather" || type === "endOfMatch";
  if (team !== undefined && team !== "home" && team !== "away") return { ok: false, error: `event ${id}: team must be "home" or "away".` };
  if (!teamless && team === undefined) return { ok: false, error: `event ${id}: team must be "home" or "away".` };
  if (player !== undefined && (typeof player !== "string" || !PLAYER_RE.test(player))) return { ok: false, error: `event ${id}: player must be a player id.` };
  if (turn !== undefined && (!Number.isInteger(turn) || (turn as number) < 1 || (turn as number) > 8)) return { ok: false, error: `event ${id}: turn must be 1-8.` };
  if (half !== undefined && half !== 1 && half !== 2 && half !== 3 && half !== "OT") return { ok: false, error: `event ${id}: half must be 1, 2 or OT.` };
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
      team: (team ?? "home") as Side, // an undo's team is rewritten to its target's; weather / endOfMatch are match-wide
      ...(player !== undefined ? { player: player as string } : {}),
      ...(turn !== undefined ? { turn: turn as number } : {}),
      ...(half !== undefined ? { half: (half === 3 ? "OT" : half) as Half } : {}), // legacy 3 = overtime
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
/** `status` 422 marks an eligibility refusal (not on the roster, unavailable, missing the skill); a malformed event is a plain 400. */
export function validateEvent(event: TabletopEvent, stored: readonly TabletopEvent[], rosters: RosterPair): { error: string; status?: number } | { event: TabletopEvent } {
  const fail = (error: string) => ({ error: `event ${event.id}: ${error}` });
  const ineligible = (error: string) => ({ error: `event ${event.id}: ${error}`, status: 422 });
  const conflict = (error: string) => ({ error: `event ${event.id}: ${error}`, status: 409 });
  if (event.type === "undo") {
    const target = event.payload.target;
    if (typeof target !== "string") return fail("undo needs payload.target (an event id).");
    const t = stored.find((e) => e.id === target);
    if (!t) return fail("undo target not found in this match.");
    if (t.type === "undo") return fail("an undo cannot be undone; record the event again instead.");
    if ((PREGAME_EVENT_TYPES as readonly string[]).includes(t.type) || t.payload.pregame === true) return fail("pre-game events cannot be undone.");
    if (stored.some((e) => e.type === "undo" && e.payload.target === target)) return fail("target already undone.");
    return { event: { ...event, team: t.team } };
  }

  if ((PREGAME_EVENT_TYPES as readonly string[]).includes(event.type)) return fail("pre-game events are recorded by the pre-game routes.");
  const live = effectiveEvents(stored);
  if (live.some((e) => e.type === "concede") && event.type !== "endOfMatch") return fail("the match was conceded; only endOfMatch can follow.");
  const find = (side: Side, id: string) => rosters[side].players.find((p) => p.id === id);
  const unavailable = (side: Side, id: string): string | undefined => {
    const p = find(side, id);
    if (!p) return `player ${id} is not on the ${side} team.`;
    if (p.dead) return `player ${id} is dead.`;
    if (p.mng) return `player ${id} is missing the next game and cannot take part.`;
    for (const e of live) {
      if (killsPlayer(e, id, side)) return `player ${id} was killed earlier in this match.`;
      if (e.type === "sendOff" && e.player === id && e.team === side) return `player ${id} was sent off earlier in this match.`;
    }
    return undefined;
  };

  if (event.type === "weather") {
    const r = event.payload.result;
    if (event.payload.roll !== undefined || event.payload.pregame !== undefined) return fail("rolls and pre-game markers are server-only.");
    if (typeof r !== "string" || !(WEATHER_RESULTS as readonly string[]).includes(r)) return fail(`weather payload.result must be one of ${WEATHER_RESULTS.join(", ")}.`);
    return { event };
  }
  if (event.type === "endOfMatch") return { event };
  if (event.type === "concede") {
    if (live.some((e) => e.type === "concede")) return fail("the match was already conceded.");
    return { event };
  }
  if (event.type === "secretObjective") {
    const text = event.payload.text;
    if (typeof text !== "string" || !text.trim() || text.length > 200) return fail("secretObjective needs payload.text (1-200 characters).");
    if (event.player) {
      const bad = unavailable(event.team, event.player);
      if (bad) return ineligible(bad);
    }
    return { event: { ...event, payload: { ...event.payload, text: text.trim() } } };
  }

  if (event.type === "throwTeamMate") {
    const p = event.payload;
    if (typeof p.superb !== "boolean" || typeof p.landed !== "boolean") return fail("throwTeamMate needs payload.superb and payload.landed (booleans).");
    if (p.superb && typeof p.thrower !== "string") return fail("a superb throw needs payload.thrower.");
    if (!p.superb && p.thrower !== undefined) return fail("payload.thrower is only for a superb throw.");
    if (p.landed && typeof p.thrown !== "string") return fail("a throw that landed needs payload.thrown.");
    if (!p.landed && p.thrown !== undefined) return fail("payload.thrown is only for a throw that landed.");
    if (event.player !== undefined && event.player !== p.thrower && event.player !== p.thrown) return fail("player must be the thrower or the thrown player.");
    const hasSkill = (id: string, want: string) =>
      (find(event.team, id)?.skills ?? []).some((sk) => sk.toLowerCase().replace(/[^a-z]/g, "") === want);
    if (typeof p.thrower === "string") {
      const bad = unavailable(event.team, p.thrower);
      if (bad) return ineligible(bad);
      if (!hasSkill(p.thrower, "throwteammate")) return ineligible(`player ${p.thrower} does not have Throw Team-mate.`);
    }
    if (typeof p.thrown === "string") {
      const bad = unavailable(event.team, p.thrown);
      if (bad) return ineligible(bad);
      if (!hasSkill(p.thrown, "rightstuff")) return ineligible(`player ${p.thrown} does not have Right Stuff.`);
      if (p.thrown === p.thrower) return fail("a player cannot throw themselves.");
    }
    const credited = (p.thrower ?? p.thrown) as string | undefined;
    return { event: { ...event, ...(credited ? { player: credited } : {}) } };
  }

  if (ACTING_TYPES.has(event.type)) {
    if (!event.player) return fail(`${event.type} needs a player.`);
    const bad = unavailable(event.team, event.player);
    if (bad) return ineligible(bad);
    if (event.type === "injury") {
      const p = event.payload;
      const lasting = (LASTING_INJURY_RESULTS as readonly string[]).includes(p.result as string);
      if (!lasting && !(INJURY_RESULTS as readonly string[]).includes(p.result as string))
        return fail(`injury payload.result must be one of ${[...INJURY_RESULTS, ...LASTING_INJURY_RESULTS].join(", ")}.`);
      if (!lasting) return { event };
      if (p.apothecaryUsed !== undefined && typeof p.apothecaryUsed !== "boolean") return fail("payload.apothecaryUsed must be a boolean.");
      if (p.result === "stat loss" && !(STATS as readonly string[]).includes(p.stat as string)) return fail(`stat loss needs payload.stat (${STATS.join(", ")}).`);
      if (live.some((e) => e.type === "casualty" && e.payload.victim === event.player && (e.payload.victimTeam ?? otherSide(e.team)) === event.team))
        return conflict("already struck by a casualty this match: undo the casualty first.");
      if (live.some((e) => (e.type === "casualty" ? e.payload.victim === event.player && (e.payload.victimTeam ?? otherSide(e.team)) === event.team
        : e.type === "injury" && e.player === event.player && e.team === event.team && (LASTING_INJURY_RESULTS as readonly string[]).includes(e.payload.result as string))))
        return fail(`player ${event.player} already suffered a casualty in this match.`);
      return { event: { ...event, payload: { ...p, apothecaryUsed: p.apothecaryUsed === true, cause: "other" } } };
    }
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
    if (bad) return ineligible(bad);
  }
  const vbad = unavailable(victimTeam, p.victim);
  if (vbad) return ineligible(vbad);
  if (live.some((e) => e.type === "injury" && e.player === p.victim && e.team === victimTeam && (LASTING_INJURY_RESULTS as readonly string[]).includes(e.payload.result as string)))
    return conflict("already injured this match: undo the injury first.");
  if (live.some((e) => (e.type === "casualty" && e.payload.victim === p.victim && (e.payload.victimTeam ?? otherSide(e.team)) === victimTeam)
    || (e.type === "injury" && e.player === p.victim && e.team === victimTeam && (LASTING_INJURY_RESULTS as readonly string[]).includes(e.payload.result as string))))
    return fail(`player ${p.victim} already suffered a casualty in this match.`);
  return {
    event: {
      ...event,
      payload: { ...p, victimTeam, apothecaryUsed: p.apothecaryUsed === true, cause: p.cause ?? "block" },
    },
  };
}
