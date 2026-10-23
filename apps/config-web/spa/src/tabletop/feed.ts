// Pure helpers for the recorder screen: event glyphs (the client's art, served by the builder-art pipeline), the Other
// grid, and the feed rows. Everything shown about an event comes from the event the server returned.

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
};

export type Needs = "player" | "player+result" | "team" | "team+text" | "weather" | "none" | "casualty";
export interface OtherEvent { type: string; label: string; needs: Needs }

/** The 15 entries of the Other popup, in TourPlay's order. */
export const OTHER_EVENTS: readonly OtherEvent[] = [
  { type: "touchdown", label: "Touchdown", needs: "player" },
  { type: "casualty", label: "Casualty", needs: "casualty" },
  { type: "injury", label: "Injury", needs: "player+result" },
  { type: "completion", label: "Completion", needs: "player" },
  { type: "catch", label: "Catch", needs: "player" },
  { type: "throwTeamMate", label: "Throw Team-mate", needs: "player" },
  { type: "interception", label: "Interception", needs: "player" },
  { type: "foul", label: "Foul", needs: "player" },
  { type: "sentOff", label: "Sent-off", needs: "player" },
  { type: "stalling", label: "Stalling", needs: "player" },
  { type: "secretObjective", label: "Secret Objectives", needs: "team+text" },
  { type: "mvp", label: "MVP", needs: "player" },
  { type: "weather", label: "Weather", needs: "weather" },
  { type: "concede", label: "Concede match", needs: "team" },
  { type: "endOfMatch", label: "End of match", needs: "none" },
];

const LABELS: Record<string, string> = {
  touchdown: "Touchdown", casualty: "Casualty", injury: "Injury", completion: "Completion", catch: "Catch", throwTeamMate: "Throw Team-mate",
  interception: "Interception", deflection: "Deflection", foul: "Foul", sentOff: "Sent-off", sendOff: "Sent-off", stalling: "Stalling",
  secretObjective: "Secret Objectives", mvp: "MVP", weather: "Weather", concede: "Concede match", endOfMatch: "End of match",
  fans: "Fans", fanChange: "Fan change", journeymen: "Journeymen", journeyman: "Journeyman", inducement: "Inducement", prayer: "Prayer to Nuffle", coinFlip: "Coin flip",
};
export const eventLabel = (type: string): string => LABELS[type] ?? type;

/** Rows with no undo button (pre-game results the server rolled). */
export const PREGAME_TYPES: ReadonlySet<string> = new Set(["fans", "weather", "journeymen", "journeyman", "inducement", "prayer", "coinFlip"]);
/** Rows drawn across the whole feed rather than on a team side. */
const CENTRE_TYPES: ReadonlySet<string> = new Set(["weather", "endOfMatch", "coinFlip", "fans", "fanChange", "journeymen", "journeyman", "prayer", "winnings"]);

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
export function eventSentence(e: RecordedEvent, who: string, teamName: string, sub: string): { lead: string; rest: string } {
  const p = who;
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
    case "prayer": return { lead: teamName, rest: ` prayer to Nuffle: ${sub}.` };
    case "journeyman": return { lead: teamName, rest: ` hires a journeyman: ${sub}.` };
    case "fanChange": return { lead: teamName, rest: ` fan change ${sub}.` };
    case "coinFlip": return { lead: "Coin flip", rest: sub ? `: ${sub}` : "." };
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
export function feedRows(events: readonly RecordedEvent[], effectiveIds: readonly string[], teams: Record<Side, TeamView | undefined>, spp: Readonly<Record<string, number>> = {}): FeedRow[] {
  const live = new Set(effectiveIds);
  const rows: FeedRow[] = [];
  for (const e of events) {
    if (!live.has(e.id) || e.type === "undo") continue;
    const pl = e.player ? teams[e.team]?.players.find((x) => x.id === e.player) : undefined;
    const sub = eventSub(e, teams);
    const who = e.player ? (pl ? `${pl.name}${pl.number !== undefined ? ` #${pl.number}` : ""}` : e.player) : "";
    const { lead, rest } = eventSentence(e, who, teams[e.team]?.name ?? (e.team === "home" ? "Home" : "Away"), sub);
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

export const PREGAME_STEPS = ["fans", "weather", "journeymen", "inducements", "prayers", "coin"] as const;
export type PregameStep = (typeof PREGAME_STEPS)[number];
export const PREGAME_LABELS: Record<PregameStep, string> = {
  fans: "Fans", weather: "Weather", journeymen: "Journeymen", inducements: "Inducements", prayers: "Prayers to Nuffle", coin: "Coin flip",
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

export function coinLine(pregame: Record<string, unknown>): string {
  return word(pregame.coin) || word(pregame.coinFlip);
}

export const CASUALTY_RESULTS_UI = ["BH", "MNG", "NI", "stat loss", "DEAD"] as const;
/** Injury results the server accepts (a casualty is its own event). */
export const INJURY_RESULTS_UI = ["stunned", "KO"] as const;
/** Mid-game weather results the server accepts. */
export const WEATHER_RESULTS_UI = ["Sweltering Heat", "Very Sunny", "Perfect Conditions", "Pouring Rain", "Blizzard"] as const;
