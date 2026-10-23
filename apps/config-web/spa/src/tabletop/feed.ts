// Pure helpers for the recorder screen: event glyphs (the client's art, served by the builder-art pipeline), the Other
// grid, and the feed rows. Everything shown about an event comes from the event the server returned.

import { turnLabel } from "./clock";
import type { RecordedEvent, Side, TeamView } from "./recorder";

export interface Glyph { src?: string; text?: string }

const ui = (file: string): Glyph => ({ src: `/icons/ui/${file}.png` });
export const uiIcon = (file: string): string => `/icons/ui/${file}.png`;

/**
 * Event -> glyph, copied from the client's graphical log (LogActionPlate.vue / logActionPlates.ts): its pitch art for
 * pass, foul, catch and stalling (served by the builder-art pipeline), its emoji for the rest. Events the client has no
 * row kind for borrow the nearest one (comments name the stand-in).
 */
export const EVENT_GLYPHS: Record<string, Glyph> = {
  touchdown: { text: "🏆" }, // client kind touchdown
  casualty: { text: "💀" }, // no client kind (its injury rows use outcome icons): skull emoji
  injury: ui("apothecary"), // stand-in: the client injury rows show the apothecary / injury icon
  completion: ui("action-pass"), // client kind pass
  catch: ui("status-catch"), // client kind catch
  throwTeamMate: { text: "🤾" }, // client kind throwTeamMate
  interception: ui("status-catch"), // client: interceptionRoll -> catch
  deflection: ui("status-catch"), // stand-in
  foul: ui("action-foul"), // client kind foul
  sentOff: { text: "⚖️" }, // client kind referee
  sendOff: { text: "⚖️" },
  stalling: ui("status-stalling"), // client kind stalling
  secretObjective: { text: "🃏" }, // stand-in: the client card glyph
  mvp: { text: "★" }, // the client roster star
  weather: { text: "🌦️" }, // client kind weather
  concede: { text: "🚪" }, // stand-in: defecting players
  endOfMatch: { text: "🏁" }, // the client game-over flag
  fans: { text: "👥" }, // client kind fans
  fanChange: { text: "👥" },
  winnings: { text: "💰" }, // client kind winnings
  journeymen: { text: "🤝" }, // stand-in: hired
  journeyman: { text: "🤝" },
  inducement: { text: "🛒" }, // client kind inducements
  prayer: { text: "🙏" }, // client kind prayer
  coinFlip: { text: "🪙" }, // client kind coin
  turnEnd: { text: "⏳" }, // client kind turnEnd
  turnSet: { text: "⏳" },
  timers: { text: "⏱️" }, // client kind timeout
  timerAgree: { text: "⏱️" },
  turnTimers: { text: "⏱️" },
};

export type Needs = "player" | "player+result" | "team" | "team+text" | "weather" | "none" | "casualty";
export interface OtherEvent { type: string; label: string; needs: Needs }

/** Pick sheets behind the TD and CAS buttons, and the MVP pick of the end-of-match step (not Other tiles). */
/** The event a player pick posts (the player id is what gets the credit). */
export const pickSpec = (kind: { type: string }, team: Side, player: string): { type: string; team: Side; player: string } => ({ type: kind.type, team, player });

export const TD_EVENT: OtherEvent = { type: "touchdown", label: "Touchdown", needs: "player" };
export const CAS_EVENT: OtherEvent = { type: "casualty", label: "Casualty", needs: "casualty" };

/** The 12 entries of the Other popup, in TourPlay's order (Touchdown and Casualty have their own buttons; MVP is an end-of-match pick). */
export const OTHER_EVENTS: readonly OtherEvent[] = [
  { type: "injury", label: "Injury", needs: "player+result" },
  { type: "completion", label: "Completion", needs: "player" },
  { type: "catch", label: "Catch", needs: "player" },
  { type: "throwTeamMate", label: "Throw Team-mate", needs: "player" },
  { type: "interception", label: "Interception", needs: "player" },
  { type: "foul", label: "Foul", needs: "player" },
  { type: "sentOff", label: "Sent-off", needs: "player" },
  { type: "stalling", label: "Stalling", needs: "player" },
  { type: "secretObjective", label: "Secret Objectives", needs: "team+text" },
  { type: "weather", label: "Weather", needs: "weather" },
  { type: "concede", label: "Concede match", needs: "team" },
  { type: "endOfMatch", label: "End of match", needs: "none" },
];

const LABELS: Record<string, string> = {
  touchdown: "Touchdown", casualty: "Casualty", injury: "Injury", completion: "Completion", catch: "Catch", throwTeamMate: "Throw Team-mate",
  interception: "Interception", deflection: "Deflection", foul: "Foul", sentOff: "Sent-off", sendOff: "Sent-off", stalling: "Stalling",
  secretObjective: "Secret Objectives", mvp: "MVP", weather: "Weather", concede: "Concede match", endOfMatch: "End of match",
  fans: "Fans", fanChange: "Fan change", journeymen: "Journeymen", journeyman: "Journeyman", inducement: "Inducement", prayer: "Prayer to Nuffle", coinFlip: "Coin flip", turnEnd: "End of turn", turnSet: "Clock set", timers: "Turn timers", turnTimers: "Turn timers", timerAgree: "Turn timers",
};
export const eventLabel = (type: string): string => LABELS[type] ?? type;

/** Rows with no undo button (pre-game results and turn ends the server wrote). */
export const PREGAME_TYPES: ReadonlySet<string> = new Set(["fans", "weather", "journeymen", "journeyman", "inducement", "prayer", "coinFlip", "timers", "turnTimers", "timerAgree", "turnEnd", "turnSet"]);
/** Rows drawn across the whole feed rather than on a team side. */
const CENTRE_TYPES: ReadonlySet<string> = new Set(["weather", "endOfMatch", "coinFlip", "fans", "fanChange", "journeymen", "journeyman", "prayer", "winnings", "turnEnd", "turnSet", "timers", "turnTimers"]);

const word = (v: unknown): string => {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["name", "label", "result", "text", "summary"]) if (typeof o[k] === "string" || typeof o[k] === "number") return String(o[k]);
  }
  return "";
};

/** One text line for the part of an event that is not the player ("BH on #3 Grob", "2 x Bribes"). */
export function eventSub(e: RecordedEvent, teams: Record<Side, TeamView | undefined>): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case "casualty": {
      const vs: Side = (p.victimTeam as Side | undefined) ?? (e.team === "home" ? "away" : "home");
      const v = teams[vs]?.players.find((x) => x.id === p.victim);
      return `${word(p.result)}${p.stat ? ` ${word(p.stat)}` : ""} on ${v ? `${v.number !== undefined ? `#${v.number} ` : ""}${v.name}` : word(p.victim)}${p.apothecaryUsed === true ? " (apothecary)" : ""}`;
    }
    case "injury": return `${word(p.result)}${p.stat ? ` ${word(p.stat)}` : ""}`;
    case "inducement": {
      const picks = Array.isArray(p.picks) ? (p.picks as Array<Record<string, unknown>>) : null;
      if (picks) return picks.length ? picks.map((k) => `${Number(k.qty ?? 1)} x ${word(k.name) || word(k.id)}`).join(", ") : "no inducements";
      return `${Number(p.qty ?? 1)} x ${word(p.name) || word(p.id)}`;
    }
    case "fans": return `${Number(p.roll ?? 0)} + ${Number(p.dedicatedFans ?? 0)} dedicated = ${Number(p.total ?? 0)}`;
    case "weather": return word(p.result) || word(p.name);
    case "prayer": return word(p.name);
    case "journeyman": return word(p.player);
    case "fanChange": return Number(p.delta) > 0 ? `+${Number(p.delta)}` : String(Number(p.delta));
    case "secretObjective": return word(p.text);
    case "concede": return word(p.team) || (e.team === "home" ? "Home" : "Away");
    default: {
      const bits = Object.entries(p).map(([, v]) => word(v)).filter(Boolean);
      return bits.join(" · ");
    }
  }
}

/** The client log line for an event, split so the player name can wear the team colour. */
/** Coach and team names of the match, for the personalised pre-game lines. */
export interface NameCtx { coach: Record<Side, string>; team: Record<Side, string> }
const other = (s: Side): Side => (s === "home" ? "away" : "home");
const isSide = (v: unknown): v is Side => v === "home" || v === "away";
const fmtMmSs = (n: number): string => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;

/** "<Caller> (<Team>) calls heads. The coin lands heads. <Winner> wins the toss." plus the choice when it rides along. */
function coinSentences(p: Record<string, unknown>, c: NameCtx): string {
  const winner = isSide(p.winner) ? p.winner : undefined;
  const choiceOf = (): string => {
    if (!winner || (p.choice !== "kick" && p.choice !== "receive")) return "";
    return `${c.coach[winner]} chooses to ${p.choice}. ${c.team[other(winner)]} will ${p.choice === "kick" ? "receive" : "kick"}.`;
  };
  if (p.stage === "choice") return choiceOf();
  const caller = isSide(p.caller) ? p.caller : undefined;
  const call = typeof p.call === "string" ? p.call : "";
  const result = typeof p.result === "string" ? p.result : "";
  const head = caller ? `${c.coach[caller]} (${c.team[caller]}) calls ${call}.` : "";
  const flip = p.mode === "hand" ? `They flipped a real coin: ${result}.` : `The coin lands ${result}.`;
  const won = winner ? `${c.coach[winner]} wins the toss.` : "";
  return [head, result ? flip : "", won, choiceOf()].filter(Boolean).join(" ");
}

export function eventSentence(e: RecordedEvent, who: string, teamName: string, sub: string, names?: NameCtx, extra?: { journeymen?: number }): { lead: string; rest: string } {
  const p = who;
  const pl = e.payload ?? {};
  if (names) {
    switch (e.type) {
      case "coinFlip": return { lead: "", rest: coinSentences(pl, names) };
      case "fans": return { lead: names.team[e.team], rest: ` brings ${Number(pl.total ?? 0)} fans (rolled ${Number(pl.roll ?? 0)}).` };
      case "journeyman": { const n = extra?.journeymen ?? 1; return { lead: names.team[e.team], rest: ` takes on ${n} journeym${n === 1 ? "an" : "en"}.` }; }
      case "prayer": return { lead: names.team[e.team], rest: ` prays to Nuffle: ${sub}.` };
      case "turnSet": {
        // The server records {from, to: {half, turn, activeTeam}, by}; a flat payload is read the same way.
        const to = (pl.to && typeof pl.to === "object" ? pl.to : pl) as { half?: number | string; turn?: number; activeTeam?: unknown };
        const side = isSide(to.activeTeam) ? to.activeTeam : e.team;
        return { lead: "", rest: `${(e as { by?: string }).by ?? "A coach"} set the clock to ${turnLabel(to.half, to.turn)} · ${names.team[side]}` };
      }
      case "timerAgree": return { lead: names.team[e.team], rest: pl.agree === true ? " agrees to turn timers." : " declines turn timers." };
      case "timers": case "turnTimers": {
        const agreed = pl.agreed as Record<string, unknown> | undefined;
        const on = pl.mode === "on" || (agreed ? agreed.home === true && agreed.away === true : pl.agree === true);
        return { lead: "", rest: on ? `Both coaches agree to turn timers (${fmtMmSs(Number(pl.seconds ?? 0))}).` : "Turn timers off." };
      }
    }
  }
  switch (e.type) {
    case "touchdown": return { lead: p, rest: " scores a touchdown." };
    case "casualty": return { lead: p, rest: ` causes a casualty: ${sub}.` };
    case "injury": return { lead: p, rest: ` suffers an injury: ${sub}.` };
    case "completion": return { lead: p, rest: " completes a pass." };
    case "catch": return { lead: p, rest: " catches the ball." };
    case "throwTeamMate": return { lead: p, rest: " throws a team-mate." };
    case "interception": return { lead: p, rest: " intercepts the ball." };
    case "deflection": return { lead: p, rest: " deflects the ball." };
    case "foul": return { lead: p, rest: " commits a foul." };
    case "sentOff": case "sendOff": return { lead: p, rest: " is sent off." };
    case "mvp": return { lead: p, rest: " is the MVP." };
    case "stalling": return { lead: teamName, rest: " is stalling." };
    case "secretObjective": return { lead: teamName, rest: ` secret objective: ${sub}` };
    case "concede": return { lead: teamName, rest: " concedes the match." };
    case "weather": return { lead: "Weather", rest: sub ? `: ${sub}` : "." };
    case "endOfMatch": return { lead: "End of match", rest: "." };
    case "inducement": return { lead: teamName, rest: ` buys ${sub}.` };
    case "fans": return { lead: teamName, rest: ` fans: ${sub}.` };
    case "prayer": return { lead: teamName, rest: ` prays to Nuffle: ${sub}.` };
    case "journeyman": return { lead: teamName, rest: ` hires a journeyman: ${sub}.` };
    case "fanChange": return { lead: teamName, rest: ` fan change ${sub}.` };
    case "coinFlip": return { lead: "Coin flip", rest: sub ? `: ${sub}` : "." };
    case "turnEnd": return { lead: `End of turn ${turnLabel((e as { half?: number | string }).half, (e as { turn?: number }).turn)}`, rest: ` · ${teamName}` };
    default: return { lead: eventLabel(e.type), rest: sub ? `: ${sub}` : "." };
  }
}

export interface FeedRow {
  id: string;
  type: string;
  label: string;
  stars: number;
  sub: string;
  side: Side | "centre";
  team: Side;
  chip: string;
  lead: string;
  rest: string;
  position: string;
  when: string;
  undoable: boolean;
  glyph: Glyph | undefined;
  half: number | "OT";
  turn: number;
  clock: string;
}

/** Newest first; only events still in force (the server names them in effectiveEventIds). */
export function feedRows(
  events: readonly RecordedEvent[], effectiveIds: readonly string[], teams: Record<Side, TeamView | undefined>,
  spp: Readonly<Record<string, number>> = {}, match?: { home: { coach: string; teamName: string }; away: { coach: string; teamName: string } },
): FeedRow[] {
  const live = new Set(effectiveIds);
  const rows: FeedRow[] = [];
  const names: NameCtx | undefined = match ? { coach: { home: match.home.coach, away: match.away.coach }, team: { home: match.home.teamName, away: match.away.teamName } } : undefined;
  // One row per team for journeymen ("<Team> takes on 2 journeymen"): the first event carries the count.
  const journeymen: Record<string, number> = {};
  for (const e of events) if (live.has(e.id) && e.type === "journeyman") journeymen[e.team] = (journeymen[e.team] ?? 0) + 1;
  const jmShown = new Set<string>();
  for (const e of events) {
    if (!live.has(e.id) || e.type === "undo") continue;
    if (e.type === "journeyman") { if (jmShown.has(e.team)) continue; jmShown.add(e.team); }
    const pl = e.player ? teams[e.team]?.players.find((x) => x.id === e.player) : undefined;
    const sub = eventSub(e, teams);
    const who = e.player ? (pl ? `${pl.name}${pl.number !== undefined ? ` #${pl.number}` : ""}` : e.player) : "";
    const { lead, rest } = eventSentence(e, who, names?.team[e.team] ?? teams[e.team]?.name ?? (e.team === "home" ? "Home" : "Away"), sub, names, { journeymen: journeymen[e.team] });
    const half = (e as { half?: number | "OT" }).half;
    const turn = (e as { turn?: number }).turn;
    rows.push({
      id: e.id,
      type: e.type,
      label: eventLabel(e.type),
      stars: spp[e.id] ?? e.sppEarned ?? 0, // the server's SPP for this event (0 = no stars)
      sub,
      side: CENTRE_TYPES.has(e.type) ? "centre" : e.team,
      team: e.team,
      lead,
      rest,
      chip: e.player ? (pl ? `${pl.number !== undefined ? `#${pl.number} ` : ""}${pl.name}` : e.player) : "",
      position: pl?.positionName ?? pl?.position ?? pl?.positionId ?? "",
      when: half || turn ? `${half ? (half === "OT" || half >= 3 ? "OT" : `H${half}`) : ""}${half && turn ? " " : ""}${turn ? `T${turn}` : ""}` : "",
      undoable: !PREGAME_TYPES.has(e.type),
      glyph: EVENT_GLYPHS[e.type],
      half: half ?? 0,
      turn: turn ?? 0,
      clock: e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
    });
  }
  return rows.reverse();
}

export const PREGAME_STEPS = ["fans", "weather", "journeymen", "inducements", "prayers", "coin", "timers"] as const;
export type PregameStep = (typeof PREGAME_STEPS)[number];
export const PREGAME_LABELS: Record<PregameStep, string> = {
  fans: "Fans", weather: "Weather", journeymen: "Journeymen", inducements: "Inducements", prayers: "Prayers to Nuffle", coin: "Coin flip", timers: "Turn timers",
};
export const pregameStep = (phase: string | undefined): PregameStep | "" => {
  const m = /^pregame:(\w+)$/.exec(phase ?? "");
  return m && (PREGAME_STEPS as readonly string[]).includes(m[1]!) ? (m[1] as PregameStep) : "";
};

/** Weather glyph + name for the scoreboard, from whatever the server recorded (string or {name}). */
export function weatherLine(pregame: Record<string, unknown>, events: readonly RecordedEvent[]): string {
  const fromEvent = [...events].reverse().find((e) => e.type === "weather");
  const raw = pregame.weather ?? fromEvent?.payload?.name ?? fromEvent?.payload?.result;
  const text = word(raw);
  if (!text) return "";
  const t = text.toLowerCase();
  const icon = /swelter/.test(t) ? "\u{1F525}" : /sunny/.test(t) ? "☀️" : /rain/.test(t) ? "\u{1F327}️" : /blizzard|snow/.test(t) ? "❄️" : "\u{1F324}️";
  return `${icon} ${text}`;
}

/** The weather glyph and its condition name (shown as a tooltip, never as text). */
export function weatherParts(pregame: Record<string, unknown>, events: readonly RecordedEvent[]): { icon: string; name: string } {
  const line = weatherLine(pregame, events);
  const i = line.indexOf(" ");
  return i < 0 ? { icon: "", name: "" } : { icon: line.slice(0, i), name: line.slice(i + 1) };
}

export function coinLine(pregame: Record<string, unknown>): string {
  return word(pregame.coin) || word(pregame.coinFlip);
}

export const CASUALTY_RESULTS_UI = ["BH", "MNG", "NI", "stat loss", "DEAD"] as const;
/** Injury results the server accepts (a casualty is its own event). */
export const INJURY_RESULTS_UI = ["stunned", "KO"] as const;
/** Mid-game weather results the server accepts. */
export const WEATHER_RESULTS_UI = ["Sweltering Heat", "Very Sunny", "Perfect Conditions", "Pouring Rain", "Blizzard"] as const;
