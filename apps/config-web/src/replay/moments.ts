// Ordered match moments from a fork game's replay command stream (owner 10-30: "Commission the turn ordered online
// match logs").
//
// SERVER-DERIVED: every moment is one thing the server's own command log says happened, read from the replay the fork
// sends any client (ServerCommandReplay batches of the game's ServerCommandModelSync commands). Half, turn and the side
// in play come from the model changes themselves (gameSetHalf, turnDataSetTurnNr, gameSetHomePlaying); names come from
// the game state's player model. Nothing is inferred from a rule: no turnover (the log has no turnover marker), no half
// end (only a half start is reported), no casualty the injury reports did not state.
//
//   report / model change                                   moment
//   report startHalf {half}                                 halfStart
//   report weather {weather, weatherRoll}                   weather
//   report kickoffResult {kickoffResult, kickoffRoll}       kickoff
//   playerResultSetTouchdowns (value rises)                 touchdown (awarded: a playerEvent "is awarded a touchdown"
//                                                           for the player in the same command, i.e. a concession award)
//   playerResultSetCompletions / Interceptions /            completion / interception / deflection
//     Deflections (value rises)
//   report injury, injury state BH / SI / RIP               casualty (attacker on the other team) or injury (no attacker,
//                                                           or a team-mate); the report is sent twice per injury (armour
//                                                           and injury part, then the casualty part), possibly in two
//                                                           commands (a regeneration / Igor pause): read once per
//                                                           attacker, defender, injury type, half and turn
//   report apothecaryRoll (apothecaryChoice)                context only: the injury that stands is the player model's
//   + fieldModelSetPlayerState / playerResultSetSeriousInjury  (state and serious injury after the casualty, read when
//                                                           the turn ends), since a coach who keeps the first result
//                                                           gets no apothecaryChoice report
//   playerResultSetSendToBoxReason foulBan /                sendOff, with the argueTheCall / bribesRoll outcome the
//     secretWeaponBan / officiousRef / threwToBombs         server reported for that player in the same turn
//   teamResultSetConceded true (+ gameSetConcededLegally)   concession

export type ReplaySide = "home" | "away";
export type ReplayMomentKind =
  | "halfStart" | "weather" | "kickoff" | "touchdown" | "casualty" | "injury" | "sendOff"
  | "completion" | "interception" | "deflection" | "concession";

export interface ReplayMoment {
  /** Order of the moment in the game (0-based). */
  seq: number;
  /** The fork's command number the moment was read from. */
  commandNr: number;
  /** 1, 2, 3+ (overtime); null before the first half started. */
  half: number | null;
  /** The turn number of the side in play; null between turns (kick-off, weather, half start) or before the first turn. */
  turn: number | null;
  /** The acting side (scorer, casualty-maker, sent-off player, conceding team); null for kick-off, weather, half start. */
  side: ReplaySide | null;
  kind: ReplayMomentKind;
  /** The row's text, built from the report fields only. */
  text: string;
  playerId?: string;
  player?: string;
  victimId?: string;
  victim?: string;
  victimSide?: ReplaySide;
  /**
   * The injury that stands ("Badly Hurt", "Seriously Hurt (MNG)", "Dead (RIP)"): as rolled, or after an apothecary as the
   * player model shows it; the weather or kick-off result.
   */
  result?: string;
  /** The injury as first rolled, when an apothecary was used. */
  rolled?: string;
  /** The apothecary's part, as context: "Badly Hurt" (its result kept) or "rolled Dead (RIP), kept Seriously Hurt (MNG)". */
  apothecary?: string;
  /** A touchdown the server awarded after a concession. */
  awarded?: true;
  /** The server's legal-concession verdict, when it sent one. */
  legal?: boolean;
}

export interface ReplayTeam { teamId: string; name: string; coach: string }

/** What the reader keeps of a replay: the teams and the ordered moments. */
export interface ReplayDerivation {
  teams: Record<ReplaySide, ReplayTeam>;
  moments: ReplayMoment[];
  /** Commands read from the replay stream. */
  commands: number;
  /** True when the moment cap was reached (moments past it are dropped). */
  truncated: boolean;
}

interface Json { [k: string]: unknown }
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** FFB PlayerState base values (com.fumbbl.ffb.PlayerState, low byte). */
const STATE_NAME: Record<number, string> = {
  1: "Standing", 2: "Standing", 3: "Prone", 4: "Stunned", 5: "Knocked Out", 6: "Badly Hurt", 7: "Serious Injury", 8: "Dead (RIP)",
  9: "Reserves", 10: "Missing", 13: "Banned",
};
const CASUALTY_STATES = new Set([6, 7, 8]);
const stateOf = (v: unknown): number | undefined => { const n = num(v); return n === undefined ? undefined : n & 0xff; };

/** SendToBoxReason values that are a send-off, with the server's own wording (SendToBoxReason.java). */
const SEND_OFF_REASONS: Record<string, string> = {
  foulBan: "banned for fouling",
  secretWeaponBan: "banned for using a Secret Weapon",
  officiousRef: "banned by the officious ref",
  threwToBombs: "spotted throwing a second bomb",
};

type CounterKind = "touchdown" | "completion" | "interception" | "deflection";
const COUNTERS: Record<string, CounterKind> = {
  playerResultSetTouchdowns: "touchdown",
  playerResultSetCompletions: "completion",
  playerResultSetInterceptions: "interception",
  playerResultSetDeflections: "deflection",
};
const COUNTER_WORD: Record<CounterKind, string> = { touchdown: "Touchdown", completion: "Completion", interception: "Interception", deflection: "Deflection" };

const dice = (v: unknown): string => arr(v).filter((d) => typeof d === "number").join(" + ");

export interface DeriverOptions { maxMoments?: number }

/**
 * A streaming deriver: build it from the replay's serverGameState `game`, feed it every replayed command in order, then
 * read `result()`. Holds only the player model, a few counters and the moments (never the command stream).
 */
export function createMomentDeriver(game: unknown, opts: DeriverOptions = {}) {
  const maxMoments = opts.maxMoments ?? 2000;
  const g = obj(game);
  const players = new Map<string, { side: ReplaySide; name: string }>();
  const teamSide = new Map<string, ReplaySide>();
  const addPlayer = (side: ReplaySide, p: unknown): void => {
    const o = obj(p);
    const id = str(o.playerId);
    if (id) players.set(id, { side, name: str(o.playerName) ?? id });
  };
  const teamOf = (side: ReplaySide): ReplayTeam => {
    const t = obj(g[side === "home" ? "teamHome" : "teamAway"]);
    const team = { teamId: str(t.teamId) ?? "", name: str(t.teamName) ?? (side === "home" ? "Home" : "Away"), coach: str(t.coach) ?? "" };
    if (team.teamId) teamSide.set(team.teamId, side);
    for (const p of arr(t.playerArray)) addPlayer(side, p);
    return team;
  };
  const teams: Record<ReplaySide, ReplayTeam> = { home: teamOf("home"), away: teamOf("away") };

  let half = 0;
  const turnNr: Record<ReplaySide, number> = { home: 0, away: 0 };
  let homePlaying: boolean | null = null;
  const counters = new Map<string, number>();
  const moments: ReplayMoment[] = [];
  let truncated = false;
  let commands = 0;
  /** argue / bribe outcomes waiting for the send-off of that player in this half and turn. */
  const pending = new Map<string, { half: number; turn: number | null; text: string[] }>();
  let legalVerdict: boolean | undefined;
  /** Injuries already read this turn (attacker|defender|type), and the turn they belong to. */
  const seenInjuries = new Set<string>();
  let injuryTurn = "";
  /** The player model after a casualty: base state and serious injury per hurt player (cleared at each casualty). */
  const modelState = new Map<string, number>();
  const modelSI = new Map<string, string>();
  /** Casualties with an apothecary roll, settled from the player model when the turn ends. */
  const apoPending = new Map<string, { moment: ReplayMoment; roll: string }>();

  const halfNow = (): number | null => (half > 0 ? half : null);
  const turnNow = (): number | null => {
    const side = homePlaying === true ? "home" : homePlaying === false ? "away" : null;
    return side && turnNr[side] > 0 ? turnNr[side] : null;
  };
  const nameOf = (id: string): string => players.get(id)?.name ?? id;
  const sideOf = (id: string | undefined): ReplaySide | undefined => (id ? players.get(id)?.side : undefined);

  function push(m: Omit<ReplayMoment, "seq">): void {
    if (moments.length >= maxMoments) { truncated = true; return; }
    moments.push({ seq: moments.length, ...m });
  }

  function injuryMoment(r: Json, commandNr: number, at: { half: number | null; turn: number | null }): void {
    const state = stateOf(r.injury);
    const victimId = str(r.defenderId);
    if (state === undefined || !CASUALTY_STATES.has(state) || !victimId) return;
    const victimSide = sideOf(victimId);
    if (!victimSide) return;
    modelState.delete(victimId);
    modelSI.delete(victimId);
    apoPending.delete(victimId);
    const result = str(r.seriousInjury) ?? STATE_NAME[state]!;
    const attackerId = str(r.attackerId);
    const attackerSide = sideOf(attackerId);
    if (attackerId && attackerSide && attackerSide !== victimSide) {
      push({
        commandNr, ...at, side: attackerSide, kind: "casualty",
        text: `Casualty: ${nameOf(attackerId)} on ${nameOf(victimId)} (${result})`,
        playerId: attackerId, player: nameOf(attackerId), victimId, victim: nameOf(victimId), victimSide, result,
      });
    } else {
      push({ commandNr, ...at, side: victimSide, kind: "injury", text: `Injury: ${nameOf(victimId)} (${result})`, playerId: victimId, player: nameOf(victimId), result });
    }
  }

  const hurtOf = (m: ReplayMoment): string | undefined => (m.kind === "casualty" ? m.victimId : m.kind === "injury" ? m.playerId : undefined);
  const headOf = (m: ReplayMoment): string => (m.kind === "casualty" ? `Casualty: ${m.player} on ${m.victim}` : `Injury: ${m.player}`);

  /** An apothecary report: what it rolled is context; the injury that stands is settled from the player model. */
  function apothecary(r: Json, isRoll: boolean): void {
    const id = str(r.playerId);
    if (!id) return;
    const state = stateOf(r.playerState);
    const outcome = str(r.seriousInjury) ?? (state !== undefined ? STATE_NAME[state] : undefined);
    if (!outcome) return;
    const open = apoPending.get(id);
    if (open) { if (isRoll) open.roll = outcome; return; }
    for (let i = moments.length - 1; i >= 0; i--) {
      const m = moments[i]!;
      if (hurtOf(m) !== id) continue;
      apoPending.set(id, { moment: m, roll: outcome });
      return;
    }
  }

  /** The injury the player model shows now for a hurt player, or undefined when the model said nothing since. */
  function modelInjury(id: string): string | undefined {
    const state = modelState.get(id);
    const si = modelSI.get(id);
    if (state !== undefined && state !== 7 && state !== 8) return STATE_NAME[state];
    return si ?? (state !== undefined ? STATE_NAME[state] : undefined);
  }

  /** Settles every pending apothecary from the player model (at a turn or half change, and at the end). */
  function settleApothecaries(): void {
    for (const [id, { moment: m, roll }] of apoPending) {
      const rolled = m.result!;
      const final = modelInjury(id);
      m.rolled = rolled;
      if (final === undefined) {
        m.apothecary = `rolled ${roll}`;
        m.text = `${headOf(m)} (${rolled}; apothecary rolled ${roll})`;
      } else if (final === roll || final !== rolled) {
        m.result = final;
        m.apothecary = final;
        m.text = `${headOf(m)} (${rolled}; apothecary: ${final})`;
      } else {
        m.apothecary = `rolled ${roll}, kept ${final}`;
        m.text = `${headOf(m)} (${rolled}; apothecary rolled ${roll}, kept ${final})`;
      }
    }
    apoPending.clear();
  }

  function refereeOutcome(r: Json, kind: "argue" | "bribe"): void {
    const id = str(r.playerId);
    if (!id) return;
    const ok = r.successful === true;
    const bits = kind === "bribe"
      ? [ok ? "bribe successful" : "bribe failed"]
      : [ok ? "argued the call successfully" : "argued the call unsuccessfully", ...(r.staysOnPitch === true ? ["stays on the pitch"] : []), ...(r.coachBanned === true ? ["coach banned"] : [])];
    const last = [...moments].reverse().find((m) => m.kind === "sendOff" && m.playerId === id && m.half === halfNow() && m.turn === turnNow());
    if (last) { last.text = last.text.replace(/\)$/, `; ${bits.join("; ")})`); return; }
    const p = pending.get(id);
    if (p && p.half === half && p.turn === turnNow()) p.text.push(...bits);
    else pending.set(id, { half, turn: turnNow(), text: bits });
  }

  function feed(command: unknown): void {
    const c = obj(command);
    commands += 1;
    if (c.netCommandId === "serverAddPlayer") {
      const side = teamSide.get(str(c.teamId) ?? "");
      if (side) addPlayer(side, c.player);
      return;
    }
    if (c.netCommandId !== "serverModelSync") return;
    const commandNr = num(c.commandNr) ?? 0;
    const at = { half: halfNow(), turn: turnNow() };
    const reports = arr(obj(c.reportList).reports).map(obj);
    const changes = arr(obj(c.modelChangeList).modelChangeArray).map(obj);

    // reports first: they describe what led to this command's model changes
    const awarded = new Set<string>();
    for (const r of reports) {
      switch (r.reportId) {
        case "startHalf": {
          const h = num(r.half);
          if (h) push({ commandNr, half: h, turn: null, side: null, kind: "halfStart", text: h >= 3 ? "Start of overtime" : `Start of half ${h}` });
          break;
        }
        case "weather": {
          const w = str(r.weather);
          const d = dice(r.weatherRoll);
          if (w) push({ commandNr, half: at.half, turn: null, side: null, kind: "weather", text: `Weather: ${w}${d ? ` (${d})` : ""}`, result: w });
          break;
        }
        case "kickoffResult": {
          const k = str(r.kickoffResult);
          const d = dice(r.kickoffRoll);
          if (k) push({ commandNr, half: at.half, turn: null, side: null, kind: "kickoff", text: `Kick-off: ${k}${d ? ` (${d})` : ""}`, result: k });
          break;
        }
        case "injury": {
          // the same injury's second half (skipInjuryParts), in this command or a later one of the same turn
          const turnKey = `${at.half}|${at.turn}`;
          if (turnKey !== injuryTurn) { injuryTurn = turnKey; seenInjuries.clear(); }
          const key = JSON.stringify([r.attackerId ?? null, r.defenderId ?? null, r.injuryType ?? null]);
          if (seenInjuries.has(key)) break;
          seenInjuries.add(key);
          injuryMoment(r, commandNr, at);
          break;
        }
        case "apothecaryRoll": apothecary(r, true); break;
        case "apothecaryChoice": apothecary(r, false); break;
        case "argueTheCall": refereeOutcome(r, "argue"); break;
        case "bribesRoll": refereeOutcome(r, "bribe"); break;
        case "playerEvent": {
          const id = str(r.playerId);
          if (id && /awarded a touchdown/i.test(String(r.message ?? ""))) awarded.add(id);
          break;
        }
        default: break;
      }
    }

    for (const m of changes) {
      const id = m.modelChangeId;
      const key = str(m.modelChangeKey);
      const value = m.modelChangeValue;
      if (id === "gameSetHalf") { const h = num(value); if (h !== undefined) { if (h !== half) settleApothecaries(); half = h; } continue; }
      if (id === "fieldModelSetPlayerState") { const st = stateOf(value); if (key && st !== undefined) modelState.set(key, st); continue; }
      if (id === "playerResultSetSeriousInjury") { if (key) { const si = str(value); if (si) modelSI.set(key, si); else modelSI.delete(key); } continue; }
      if (id === "gameSetHomePlaying") { if (typeof value === "boolean") homePlaying = value; continue; }
      if (id === "turnDataSetTurnNr") {
        const n = num(value);
        if (n !== undefined && (key === "home" || key === "away")) { if (n !== turnNr[key]) settleApothecaries(); turnNr[key] = n; }
        continue;
      }
      if (id === "gameSetConcededLegally") {
        if (typeof value === "boolean") {
          legalVerdict = value;
          for (const x of moments) if (x.kind === "concession") x.legal = value;
        }
        continue;
      }
      if (id === "teamResultSetConceded") {
        if (value === true && (key === "home" || key === "away")) {
          push({ commandNr, half: halfNow(), turn: turnNow(), side: key, kind: "concession", text: `Concession: ${teams[key].name}`, ...(legalVerdict !== undefined ? { legal: legalVerdict } : {}) });
        }
        continue;
      }
      if (typeof id === "string" && Object.hasOwn(COUNTERS, id)) {
        const kind = COUNTERS[id]!;
        const n = num(value);
        const side = sideOf(key);
        if (!key || n === undefined || !side) continue;
        const ck = `${kind}:${key}`;
        const before = counters.get(ck) ?? 0;
        counters.set(ck, n);
        for (let i = before; i < n; i++) {
          const isAward = kind === "touchdown" && awarded.has(key);
          push({
            commandNr, half: halfNow(), turn: turnNow(), side, kind,
            text: `${COUNTER_WORD[kind]}${isAward ? " awarded" : ""}: ${nameOf(key)}`, playerId: key, player: nameOf(key),
            ...(isAward ? { awarded: true as const } : {}),
          });
        }
        continue;
      }
      if (id === "playerResultSetSendToBoxReason") {
        const reason = typeof value === "string" ? SEND_OFF_REASONS[value] : undefined;
        const side = sideOf(key);
        if (!key || !reason || !side) continue;
        const p = pending.get(key);
        const extra = p && p.half === half && p.turn === turnNow() ? p.text : [];
        pending.delete(key);
        push({ commandNr, half: halfNow(), turn: turnNow(), side, kind: "sendOff", text: `Sent off: ${nameOf(key)} (${[reason, ...extra].join("; ")})`, playerId: key, player: nameOf(key) });
      }
    }
  }

  return {
    feed,
    result(): ReplayDerivation {
      settleApothecaries();
      // the game state's own verdict, when no model change carried one
      const verdict = g.concededLegally;
      if (typeof verdict === "boolean") for (const m of moments) if (m.kind === "concession" && m.legal === undefined) m.legal = verdict;
      return { teams, moments: moments.map((m) => ({ ...m })), commands, truncated };
    },
  };
}

/** The whole derivation over a recorded stream (tests, fixtures). */
export function deriveReplayMoments(game: unknown, commands: readonly unknown[], opts: DeriverOptions = {}): ReplayDerivation {
  const d = createMomentDeriver(game, opts);
  for (const c of commands) d.feed(c);
  return d.result();
}
