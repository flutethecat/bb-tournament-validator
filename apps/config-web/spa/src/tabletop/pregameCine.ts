// Pre-game cines (no DOM, unit-tested): which short animation a newly arrived server event plays, and the queue the
// recorder view drains. The look follows the Super FUMBBL client's coin / weather / fan-factor cinematics, re-made in
// the recorder's own CSS (tabletop.css, "tt-cine"). Every cine is at most CINE_MAX_MS, a click skips it, and with
// prefers-reduced-motion the result shows without movement. Only what the server recorded is shown.

import type { RecordedEvent, Side } from "./recorder";

export const CINE_MAX_MS = 2500;

export interface CineSide { coach: string; team: string; dedicatedFans: number; roll: number; total: number }
export type CineItem =
  | { key: string; kind: "fans"; home: CineSide; away: CineSide; leader: Side | "tie"; diff: number }
  | { key: string; kind: "weather"; dice: [number, number]; total: number; name: string; icon: string; effect: string }
  | { key: string; kind: "coin"; callerCoach: string; call: string; result: "heads" | "tails"; winnerCoach: string; winnerTeam: string; hand: boolean }
  | { key: string; kind: "kickreceive"; winnerCoach: string; winnerTeam: string; choice: "kick" | "receive"; otherTeam: string };

/** How long each cine holds before it closes itself (all within CINE_MAX_MS). */
export const CINE_MS: Record<CineItem["kind"], number> = { fans: 2400, weather: 2400, coin: 2500, kickreceive: 1800 };

/** Our own one-line effect per weather result (the table: bloodbowlbase.ru BB2025 the_game_of_blood_bowl #weather-table). */
export const WEATHER_EFFECTS: Record<string, string> = {
  "Sweltering Heat": "Some players may collapse from the heat after each drive.",
  "Very Sunny": "Passing is harder in the glare.",
  "Perfect Conditions": "No effect: a perfect day for Blood Bowl.",
  "Pouring Rain": "The ball is slippery: catching and picking up are harder.",
  Blizzard: "Going for it is riskier and only short passes are possible.",
};
export const weatherIcon = (name: string): string => {
  const t = name.toLowerCase();
  return /swelter/.test(t) ? "\u{1F525}" : /sunny/.test(t) ? "☀️" : /rain/.test(t) ? "\u{1F327}️" : /blizzard|snow/.test(t) ? "❄️" : "\u{1F324}️";
};

interface Names { home: { coach: string; teamName: string }; away: { coach: string; teamName: string } }
const isSide = (v: unknown): v is Side => v === "home" || v === "away";
const other = (s: Side): Side => (s === "home" ? "away" : "home");

/** The cines for the events in `fresh` (ids not seen before), in the order they should play. */
export function cinesFor(fresh: ReadonlySet<string>, events: readonly RecordedEvent[], m: Names): CineItem[] {
  const out: CineItem[] = [];
  const byId = (id: string) => events.find((e) => e.id === id);
  const fansH = byId("pg-fans-home"), fansA = byId("pg-fans-away");
  if (fansH && fansA && (fresh.has(fansH.id) || fresh.has(fansA.id))) {
    const side = (e: RecordedEvent, s: Side): CineSide => ({ coach: m[s].coach, team: m[s].teamName, dedicatedFans: Number(e.payload.dedicatedFans ?? 0), roll: Number(e.payload.roll ?? 0), total: Number(e.payload.total ?? 0) });
    const home = side(fansH, "home"), away = side(fansA, "away");
    out.push({ key: "fans", kind: "fans", home, away, leader: home.total === away.total ? "tie" : home.total > away.total ? "home" : "away", diff: Math.abs(home.total - away.total) });
  }
  const w = byId("pg-weather-0");
  if (w && fresh.has(w.id)) {
    const dice = (Array.isArray(w.payload.dice) ? w.payload.dice : [0, 0]).map(Number) as [number, number];
    const name = String(w.payload.result ?? "");
    out.push({ key: "weather", kind: "weather", dice, total: Number(w.payload.roll ?? dice[0] + dice[1]), name, icon: weatherIcon(name), effect: WEATHER_EFFECTS[name] ?? "" });
  }
  const flip = byId("pg-coinflip");
  if (flip && fresh.has(flip.id)) {
    const p = flip.payload;
    const caller = isSide(p.caller) ? p.caller : "away";
    const winner = isSide(p.winner) ? p.winner : flip.team;
    out.push({
      key: "coin", kind: "coin", callerCoach: m[caller].coach, call: String(p.call ?? ""), result: p.result === "tails" ? "tails" : "heads",
      winnerCoach: m[winner].coach, winnerTeam: m[winner].teamName, hand: p.mode === "hand",
    });
  }
  const choiceEv = byId("pg-coinchoice");
  const choice = (choiceEv?.payload.choice ?? flip?.payload.choice) as string | undefined;
  if (flip && (choice === "kick" || choice === "receive") && ((choiceEv && fresh.has(choiceEv.id)) || (!choiceEv && fresh.has(flip.id)))) {
    const winner = isSide(flip.payload.winner) ? flip.payload.winner : flip.team;
    out.push({ key: "kickreceive", kind: "kickreceive", winnerCoach: m[winner].coach, winnerTeam: m[winner].teamName, choice, otherTeam: m[other(winner)].teamName });
  }
  return out;
}

/**
 * The view's queue: the first load only marks what is already there (nothing replays on opening a match); later loads
 * queue the cines for new pre-game events. `current` is the head; `next()` (timer or click) moves on.
 */
export function createCineQueue() {
  const seen = new Set<string>();
  let primed = false;
  const queue: CineItem[] = [];
  return {
    get current(): CineItem | undefined { return queue[0]; },
    get length(): number { return queue.length; },
    /** Feed every server answer here; returns true when the head changed. */
    see(events: readonly RecordedEvent[], m: Names | null | undefined): boolean {
      const fresh = new Set(events.filter((e) => !seen.has(e.id)).map((e) => e.id));
      for (const id of fresh) seen.add(id);
      if (!primed) { primed = true; return false; }
      if (!fresh.size || !m) return false;
      const before = queue[0];
      for (const c of cinesFor(fresh, events, m)) if (!queue.some((q) => q.key === c.key)) queue.push(c);
      return queue[0] !== before;
    },
    next(): void { queue.shift(); },
    clear(): void { queue.length = 0; },
  };
}
