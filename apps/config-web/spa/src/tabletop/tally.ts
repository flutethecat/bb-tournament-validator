// Running score and SPP tally for the recorder, computed from the events the SERVER returned (never from taps
// that have not been accepted yet). Mirrors the server's undo rule (an undone event and the undo itself drop
// out) and its BB2025 SPP values; the server's own tally decides the saved result.

export type Side = "home" | "away";

export interface ServerEvent {
  id: string;
  type: string;
  team: Side;
  player?: string;
  payload: Record<string, unknown>;
}

export const SPP = { touchdown: 3, casualty: 2, completion: 1, interception: 1, deflection: 1, mvp: 4 } as const;

export interface TallyLine {
  touchdowns: number; casualties: number; completions: number; interceptions: number; deflections: number;
  mvp: number; sentOff: boolean; injury?: string; spp: number;
}

export interface Tally {
  score: Record<Side, number>;
  fanDelta: Partial<Record<Side, number>>;
  lines: Record<Side, Record<string, TallyLine>>;
  dead: Record<Side, string[]>;
  hasMvp: Record<Side, boolean>;
  /** Players with a casualty already recorded this match (the server allows one each). */
  injured: Record<Side, string[]>;
}

export function effective<T extends ServerEvent>(events: readonly T[]): T[] {
  const undone = new Set<string>();
  for (const e of events) if (e.type === "undo" && typeof e.payload?.target === "string") undone.add(e.payload.target);
  return events.filter((e) => e.type !== "undo" && !undone.has(e.id));
}

const blank = (): TallyLine => ({ touchdowns: 0, casualties: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0, sentOff: false, spp: 0 });

export function tally(events: readonly ServerEvent[]): Tally {
  const t: Tally = {
    score: { home: 0, away: 0 }, fanDelta: {}, lines: { home: {}, away: {} },
    dead: { home: [], away: [] }, hasMvp: { home: false, away: false }, injured: { home: [], away: [] },
  };
  const line = (s: Side, id: string): TallyLine => (t.lines[s][id] ??= blank());
  for (const e of effective(events)) {
    const s = e.team;
    const other: Side = s === "home" ? "away" : "home";
    switch (e.type) {
      case "touchdown": t.score[s] += 1; line(s, e.player!).touchdowns += 1; break;
      case "completion": line(s, e.player!).completions += 1; break;
      case "interception": line(s, e.player!).interceptions += 1; break;
      case "deflection": line(s, e.player!).deflections += 1; break;
      case "mvp": line(s, e.player!).mvp += 1; t.hasMvp[s] = true; break;
      case "sendOff": line(s, e.player!).sentOff = true; break;
      case "fanChange": t.fanDelta[s] = (t.fanDelta[s] ?? 0) + Number(e.payload.delta ?? 0); break;
      case "casualty": {
        const vs = (e.payload.victimTeam as Side | undefined) ?? other;
        const victim = String(e.payload.victim);
        const result = String(e.payload.result);
        if (e.player && e.payload.cause === "block") line(s, e.player).casualties += 1;
        line(vs, victim).injury = result === "stat loss" ? `stat loss ${String(e.payload.stat ?? "")}`.trim() : result;
        t.injured[vs].push(victim);
        if (result === "DEAD") t.dead[vs].push(victim);
        break;
      }
    }
  }
  for (const s of ["home", "away"] as const)
    for (const l of Object.values(t.lines[s]))
      l.spp = l.touchdowns * SPP.touchdown + l.casualties * SPP.casualty + l.completions * SPP.completion +
        l.interceptions * SPP.interception + l.deflections * SPP.deflection + l.mvp * SPP.mvp;
  return t;
}
