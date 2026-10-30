// Pure helpers for the recorder screen: event glyphs (the client's art, served by the builder-art pipeline), the Other
// grid, and the feed rows. Everything shown about an event comes from the event the server returned.

import { turnLabel } from "./clock";
import type { RecordedEvent, RosterPlayerView, Side, TeamView } from "./recorder";

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
  casualtiesSuffered: ui("apothecary"), // stand-in: the injury icon (a game page's team-level casualties line)
  journeymen: { text: "🤝" }, // stand-in: hired
  journeyman: { text: "🤝" },
  inducement: { text: "🛒" }, // client kind inducements
  prayer: { text: "🙏" }, // client kind prayer
  coinFlip: { text: "🪙" }, // client kind coin
  seats: { text: "🏟️" }, // the home/away draw and swaps
  pregameSkip: { text: "⏭️" },
  turnEnd: { text: "⏳" }, // client kind turnEnd
  turnSet: { text: "⏳" },
  timers: { text: "⏱️" }, // client kind timeout
  timerAgree: { text: "⏱️" },
  turnTimers: { text: "⏱️" },
};

/** Event type -> the server's `eligible` flag for it. */
export const ELIGIBILITY_KEY: Record<string, string> = {
  touchdown: "touchdown", completion: "pass", catch: "catch", interception: "intercept", deflection: "deflect", foul: "foul",
  casualty: "casualty", injury: "injury", sentOff: "sentOff", sendOff: "sentOff", stalling: "stalling", mvp: "mvp", throwTeamMate: "throwTeamMate",
};
/** Skill-gated actions: the server must say true. Every other action is open to an available player unless the flag is false. */
const STRICT: ReadonlySet<string> = new Set(["throwTeamMate", "rightStuff"]);

/** Players of one roster that may take this action: available this game and flagged eligible by the server. */
export function eligiblePlayers(teams: Record<Side, TeamView | undefined>, side: Side, action: string): RosterPlayerView[] {
  return (teams[side]?.players ?? []).filter((p) => {
    if (p.available !== true) return false; // unavailable players are omitted, not greyed
    const flag = p.eligible?.[action];
    return STRICT.has(action) ? flag === true : flag !== false;
  });
}

/** The rosters a viewer may act for: their own side; both only for an organiser in edit mode. */
export const visibleSidesFor = (local: Side, organiser: boolean, editMode: boolean): Side[] => (organiser && editMode ? ["home", "away"] : [local]);

export type Needs = "player" | "player+result" | "team" | "team+text" | "weather" | "none" | "casualty";
export interface OtherEvent { type: string; label: string; needs: Needs }

/** Pick sheets behind the TD and CAS buttons, and the MVP pick of the end-of-match step (not Other tiles). */
/** The event a player pick posts (the player id is what gets the credit). */
export const pickSpec = (kind: { type: string }, team: Side, player: string): { type: string; team: Side; player: string } => ({ type: kind.type, team, player });

/** The injury flow the rail Injury button and the Other grid share. */
export const INJURY_EVENT: OtherEvent = { type: "injury", label: "Injury", needs: "player+result" };
export const TD_EVENT: OtherEvent = { type: "touchdown", label: "Touchdown", needs: "player" };
export const CAS_EVENT: OtherEvent = { type: "casualty", label: "Casualty", needs: "casualty" };

/** The 12 entries of the Other popup, in TourPlay's order (Touchdown and Casualty have their own buttons; MVP is an end-of-match pick). */
export const OTHER_EVENTS: readonly OtherEvent[] = [
  INJURY_EVENT,
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
  fans: "Fans", fanChange: "Fan change", winnings: "Winnings", casualtiesSuffered: "Casualties suffered", journeymen: "Journeymen", journeyman: "Journeyman", inducement: "Inducement", prayer: "Prayer to Nuffle", coinFlip: "Coin flip", seats: "Home and away", pregameSkip: "Pre-game skipped", turnEnd: "End of turn", turnSet: "Clock set", timers: "Turn timers", turnTimers: "Turn timers", timerAgree: "Turn timers",
};
export const eventLabel = (type: string): string => LABELS[type] ?? type;

/** Rows with no undo button (pre-game results and turn ends the server wrote). */
export const PREGAME_TYPES: ReadonlySet<string> = new Set(["seats", "fans", "weather", "journeymen", "journeyman", "inducement", "prayer", "coinFlip", "pregameSkip", "timers", "turnTimers", "timerAgree", "turnEnd", "turnSet"]);
/** Rows drawn across the whole feed rather than on a team side. */
const CENTRE_TYPES: ReadonlySet<string> = new Set(["weather", "endOfMatch", "coinFlip", "seats", "pregameSkip", "fans", "fanChange", "journeymen", "journeyman", "prayer", "winnings", "turnEnd", "turnSet", "timers", "turnTimers"]);

const word = (v: unknown): string => {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["name", "label", "result", "text", "summary"]) if (typeof o[k] === "string" || typeof o[k] === "number") return String(o[k]);
  }
  return "";
};

/** One text line for the part of an event that is not the player ("BH on #3 Grob", "2 x Bribes"). */
/** A player as the log names them: "Grob #1", or "#1 Blitzer" (number and position, never the name) for a side the viewer may not see by name. */
export function playerLabel(pl: RosterPlayerView, hideName: boolean): string {
  const pos = pl.positionName ?? pl.position ?? pl.positionId ?? "player";
  if (hideName) return pl.number !== undefined ? `#${pl.number} ${pos}` : pos;
  return `${pl.name}${pl.number !== undefined ? ` #${pl.number}` : ""}`;
}

export function eventSub(e: RecordedEvent, teams: Record<Side, TeamView | undefined>, obscureSide: Side | null = null): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case "casualty": {
      const vs: Side = (p.victimTeam as Side | undefined) ?? (e.team === "home" ? "away" : "home");
      const v = teams[vs]?.players.find((x) => x.id === p.victim);
      const vname = v ? (vs === obscureSide ? playerLabel(v, true) : `${v.number !== undefined ? `#${v.number} ` : ""}${v.name}`) : word(p.victim);
      return `${word(p.result)}${p.stat ? ` ${word(p.stat)}` : ""} on ${vname}${p.apothecaryUsed === true ? " (apothecary)" : ""}`;
    }
    case "injury": return `${word(p.result)}${p.stat ? ` ${word(p.stat)}` : ""}`;
    case "inducement": {
      const picks = Array.isArray(p.picks) ? (p.picks as Array<Record<string, unknown>>) : null;
      if (picks) return picks.length ? picks.map((k) => `${Number(k.qty ?? 1)} x ${word(k.name) || word(k.id)}`).join(", ") : "no inducements";
      return `${Number(p.qty ?? 1)} x ${word(p.name) || word(p.id)}`;
    }
    case "fans": return `${Number(p.roll ?? 0)} + ${Number(p.dedicatedFans ?? 0)} dedicated = ${Number(p.total ?? 0)}`;
    case "weather": {
      // pre-game: the 2D6 and who rolled them ("Blizzard (6 + 6, rolled at the table)"); mid-game entries are a name only
      const name = word(p.result) || word(p.name);
      const dice = Array.isArray(p.dice) ? (p.dice as unknown[]).map(Number).join(" + ") : "";
      const how = rollWord(p);
      return dice && how ? `${name} (${dice}, ${how})` : name;
    }
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

/** Who rolled a pre-game die: the site ("Roll for me") or the coaches at the table ("Enter result"); "" for older events. */
export function rollWord(p: Record<string, unknown>): string {
  return p.rolledBy === "coach" ? `rolled at the table${typeof p.enteredBy === "string" ? `, entered by ${p.enteredBy}` : ""}` : p.rolledBy === "site" ? "site roll" : "";
}

/** "Away team <Team> (<Coach>) calls the toss": the away coach calls (owner ruling 10-30); an old match's drawn home caller reads "Home team". */
export const callerPhrase = (caller: Side, c: NameCtx): string => `${caller === "away" ? "Away" : "Home"} team ${c.team[caller]} (${c.coach[caller]}) calls the toss`;

/** The seat draw at creation and an organiser's swap: the names travel in the payload, so the row reads right after a later swap. */
function seatsSentence(p: Record<string, unknown>, by: string | undefined): string {
  const seat = (v: unknown): string => {
    const o = v && typeof v === "object" ? (v as { coach?: unknown; teamName?: unknown }) : {};
    return `${String(o.teamName ?? "")} (${String(o.coach ?? "")})`;
  };
  const where = `${seat(p.home)} at home, ${seat(p.away)} away.`;
  return p.stage === "swap" ? `${by ?? "An organiser"} swaps home and away: ${where}` : `The site draws home and away: ${where}`;
}

/** "Away team <Team> (<Coach>) calls the toss: heads. The coin lands heads. <Winner> wins the toss." plus the choice when it rides along. */
function coinSentences(p: Record<string, unknown>, c: NameCtx): string {
  const winner = isSide(p.winner) ? p.winner : undefined;
  const choiceOf = (): string => {
    if (!winner || (p.choice !== "kick" && p.choice !== "receive")) return "";
    return `${c.coach[winner]} chooses to ${p.choice}. ${c.team[other(winner)]} will ${p.choice === "kick" ? "receive" : "kick"}.`;
  };
  if (p.stage === "choice") return choiceOf();
  if (p.stage === "call") return isSide(p.caller) ? `${callerPhrase(p.caller, c)}: ${String(p.call ?? "")}, for a real coin.` : "";
  // an old match's caller draw (no longer recorded): the same sentence as today's derived caller
  if (p.stage === "caller") return isSide(p.caller) ? `${callerPhrase(p.caller, c)}.` : "";
  const caller = isSide(p.caller) ? p.caller : undefined;
  const call = typeof p.call === "string" ? p.call : "";
  const result = typeof p.result === "string" ? p.result : "";
  const head = caller ? `${callerPhrase(caller, c)}: ${call}.` : "";
  const flip = p.mode === "hand" ? `They flipped a real coin: ${result}.` : `The coin lands ${result}.`;
  const won = winner ? `${c.coach[winner]} wins the toss.` : "";
  return [head, result ? flip : "", won, choiceOf()].filter(Boolean).join(" ");
}

/** What happened to the victim, as the second line of a casualty (and the only line of an injury): "is Badly Hurt", "loses AV", "is Dead". */
export function victimPhrase(result: string, stat: unknown, apothecary: boolean): string {
  const r = result.trim();
  const note = apothecary ? " (apothecary used)" : "";
  if (/^(bh|badly hurt)/i.test(r)) return `is Badly Hurt${note}`;
  if (/^(mng|miss)/i.test(r)) return `is Miss Next Game${note}`;
  if (/^(ni|niggl)/i.test(r)) return `is Niggled${note}`;
  if (/stat/i.test(r)) return `loses ${word(stat) || "a stat"}${note}`;
  if (/^(dead|rip|death)/i.test(r)) return `is Dead${note}`;
  if (/^stun/i.test(r)) return "is Stunned";
  if (/^ko|knock/i.test(r)) return "is Knocked Out";
  return `is injured${r ? `: ${r}` : ""}${note}`;
}

/** "1 Badly Hurt, 2 Seriously Injured, 1 dead" from a {bh, si, rip} count (zero parts left out). */
export function sufferedText(c: Record<string, unknown>): string {
  const n = (k: string) => (typeof c[k] === "number" ? (c[k] as number) : 0);
  return [n("bh") ? `${n("bh")} Badly Hurt` : "", n("si") ? `${n("si")} Seriously Injured` : "", n("rip") ? `${n("rip")} dead` : ""].filter(Boolean).join(", ");
}

export function eventSentence(e: RecordedEvent, who: string, teamName: string, sub: string, names?: NameCtx, extra?: { journeymen?: number }): { lead: string; rest: string } {
  // an event that names no player (a game page's team-level line) reads with the team as its subject
  const p = who || teamName;
  const pl = e.payload ?? {};
  if (names) {
    switch (e.type) {
      case "coinFlip": return { lead: "", rest: coinSentences(pl, names) };
      case "seats": return { lead: "", rest: seatsSentence(pl, (e as { by?: string }).by) };
      case "fans": {
        const how = rollWord(pl);
        return { lead: names.team[e.team], rest: ` brings ${Number(pl.total ?? 0)} fans (rolled ${Number(pl.roll ?? 0)}${how ? `, ${how}` : ""}).` };
      }
      case "pregameSkip": return { lead: "", rest: `${(e as { by?: string }).by ?? "An organiser"} skipped the pre-game.` };
      case "journeyman": { const n = extra?.journeymen ?? 1; return { lead: names.team[e.team], rest: ` takes on ${n} journeym${n === 1 ? "an" : "en"}.` }; }
      case "prayer": { const how = rollWord(pl); return { lead: names.team[e.team], rest: ` prays to Nuffle: ${sub}${how ? ` (${Number(pl.roll ?? 0)}, ${how})` : ""}.` }; }
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
    case "touchdown": return { lead: p, rest: " scores a touchdown!" };
    case "casualty": return { lead: p, rest: " causes a casualty!" };
    case "injury": return { lead: p, rest: ` ${victimPhrase(String(pl.result ?? ""), pl.stat, false)}.` };
    case "completion": return { lead: p, rest: " completes a pass!" };
    case "catch": return { lead: p, rest: " catches the ball." };
    case "throwTeamMate": return { lead: p, rest: " throws a team-mate." };
    case "interception": return { lead: p, rest: " intercepts the ball!" };
    case "deflection": return { lead: p, rest: " deflects the ball." };
    case "foul": return { lead: p, rest: " commits a foul." };
    case "sentOff": case "sendOff": return { lead: p, rest: " is sent off." };
    case "mvp": { const n = Number(pl.count ?? 1); return { lead: p, rest: n > 1 ? ` is the MVP (${n} awards).` : " is the MVP." }; }
    case "stalling": return { lead: teamName, rest: " is stalling." };
    case "secretObjective": return { lead: teamName, rest: ` secret objective: ${sub}` };
    case "concede": return { lead: teamName, rest: pl.legal === true ? " concedes the match (a legal concession)." : pl.legal === false ? " concedes the match (not a legal concession)." : " concedes the match." };
    case "winnings": return { lead: teamName, rest: ` earns ${Math.round(Number(pl.amount ?? 0) / 1000)}k in winnings.` };
    case "casualtiesSuffered": return { lead: teamName, rest: ` suffered ${sufferedText(pl)}.` };
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
  /** "victim" for the second line of a casualty (the injured player's side); every other row is "main". */
  part: "main" | "victim";
  /** The row's player id (the actor, or a casualty's victim on the victim line), for the portrait card. */
  playerId: string;
  type: string;
  label: string;
  stars: number;
  sub: string;
  side: Side | "centre";
  team: Side;
  chip: string;
  /** The acting player's roster sprite path (art folder), empty when the roster has none. */
  sprite: string;
  /** The acting player's shirt number ("#7") and name, empty for team-level events. */
  number: string;
  player: string;
  lead: string;
  rest: string;
  position: string;
  when: string;
  undoable: boolean;
  glyph: Glyph | undefined;
  half: number | "OT";
  turn: number;
  clock: string;
  /** Recorded by an organiser for a team they do not coach. */
  admin: boolean;
  /** A retracted event kept in the log: who removed it, when (a time of day), and whether an organiser did. */
  removed: { by: string; at: string; admin: boolean } | null;
}

/** Newest first; only events still in force (the server names them in effectiveEventIds). */
export function feedRows(
  events: readonly RecordedEvent[], effectiveIds: readonly string[], teams: Record<Side, TeamView | undefined>,
  spp: Readonly<Record<string, number>> = {}, match?: { home: { coach: string; teamName: string }; away: { coach: string; teamName: string } },
  /** The side whose players are named by number and position only (a participant's opponent); null shows every name (organisers, spectators). */
  obscureSide: Side | null = null,
): FeedRow[] {
  const live = new Set(effectiveIds);
  const rows: FeedRow[] = [];
  const names: NameCtx | undefined = match ? { coach: { home: match.home.coach, away: match.away.coach }, team: { home: match.home.teamName, away: match.away.teamName } } : undefined;
  // One row per team for journeymen ("<Team> takes on 2 journeymen"): the first event carries the count.
  const journeymen: Record<string, number> = {};
  for (const e of events) if (live.has(e.id) && e.type === "journeyman") journeymen[e.team] = (journeymen[e.team] ?? 0) + 1;
  const jmShown = new Set<string>();
  // retractions: the undo event names its target, who undid it and when (the server also copies this onto the retracted event)
  const undoOf = new Map<string, { by: string; at: string; admin: boolean }>();
  for (const u of events) if (u.type === "undo" && typeof u.payload?.target === "string") undoOf.set(u.payload.target, { by: u.by ?? "", at: u.ts ?? "", admin: u.admin === true });
  const timeOf = (iso: string): string => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
  const victimSide = (c: RecordedEvent): Side => ((c.payload?.victimTeam as Side | undefined) ?? (c.team === "home" ? "away" : "home"));
  const isLasting = (r: unknown): boolean => /^(bh|mng|ni|stat|dead|rip|death|badly|miss|niggl)/i.test(String(r ?? "").trim());
  const sameTurn = (a: RecordedEvent, b: RecordedEvent): boolean => {
    const x = a as { half?: number | string; turn?: number }, y = b as { half?: number | string; turn?: number };
    return (x.half === undefined || y.half === undefined || x.half === y.half) && (x.turn === undefined || y.turn === undefined || x.turn === y.turn);
  };
  // Order guard: an injury recorded BEFORE a casualty naming the same victim in the same turn is paired with it: the injury's line renders
  // directly beneath the casualty line (the casualty adopts its result), and the injury is not listed a second time on its own.
  const pairedInjury = new Map<string, RecordedEvent>();
  const consumed = new Set<string>();
  events.forEach((c, ci) => {
    if (c.type !== "casualty" || !live.has(c.id)) return;
    const vs = victimSide(c);
    for (let k = 0; k < ci; k += 1) {
      const inj = events[k]!;
      if (inj.type !== "injury" || !live.has(inj.id) || consumed.has(inj.id) || inj.team !== vs || inj.player !== c.payload?.victim || !isLasting(inj.payload?.result) || !sameTurn(inj, c)) continue;
      pairedInjury.set(c.id, inj);
      consumed.add(inj.id);
      break;
    }
  });
  const build = (e: RecordedEvent, part: "main" | "victim", isLive: boolean, retraction: { by: string; at: string; admin: boolean } | undefined, victimOf?: RecordedEvent): FeedRow => {
    // the row's player: the event's own, or (a casualty's victim line) the injured player on the victim's side
    const side: Side = victimOf ? victimSide(victimOf) : e.team;
    const playerId = victimOf ? String(victimOf.payload?.victim ?? "") : e.player;
    const pl = playerId ? teams[side]?.players.find((x) => x.id === playerId) : undefined;
    const sub = eventSub(e, teams, obscureSide);
    const hide = side === obscureSide;
    const who = playerId ? (pl ? (hide ? playerLabel(pl, true) : pl.name) : playerId) : "";
    const teamName = names?.team[side] ?? teams[side]?.name ?? (side === "home" ? "Home" : "Away");
    let lead: string, rest: string;
    if (victimOf) {
      const pv = victimOf.payload ?? {};
      lead = who;
      rest = ` ${victimPhrase(String(pv.result ?? ""), pv.stat, pv.apothecaryUsed === true)}.`;
    } else ({ lead, rest } = eventSentence(e, who, teamName, sub, names, { journeymen: journeymen[e.team] }));
    // the actor is named once, in the side chip (sprite / name / position): the sentence states only the action
    if (who && lead === who && !CENTRE_TYPES.has(e.type)) { lead = ""; rest = rest.replace(/^\s+/, ""); }
    const half = (e as { half?: number | "OT" }).half;
    const turn = (e as { turn?: number }).turn;
    return {
      id: e.id,
      part,
      playerId: playerId ?? "",
      type: e.type,
      label: eventLabel(e.type),
      stars: part === "victim" ? 0 : spp[e.id] ?? e.sppEarned ?? 0, // the server's SPP for this event (0 = no stars)
      sub,
      side: CENTRE_TYPES.has(e.type) ? "centre" : side,
      team: side,
      lead,
      rest,
      sprite: pl?.sprite ?? "",
      chip: playerId ? (pl ? (hide ? playerLabel(pl, true) : `${pl.number !== undefined ? `#${pl.number} ` : ""}${pl.name}`) : playerId) : "",
      number: pl?.number !== undefined ? `#${pl.number}` : "",
      player: hide ? "" : pl?.name ?? "",
      position: pl?.positionName ?? pl?.position ?? pl?.positionId ?? "",
      when: half || turn ? `${half ? (half === "OT" || half >= 3 ? "OT" : `H${half}`) : ""}${half && turn ? " " : ""}${turn ? `T${turn}` : ""}` : "",
      undoable: part === "main" && !PREGAME_TYPES.has(e.type) && isLive,
      glyph: EVENT_GLYPHS[e.type],
      half: half ?? 0,
      turn: turn ?? 0,
      clock: e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
      admin: e.admin === true,
      removed: !isLive && retraction ? { by: retraction.by, at: timeOf(retraction.at), admin: retraction.admin } : null,
    };
  };
  for (const e of events) {
    if (e.type === "undo") continue;
    const isLive = live.has(e.id);
    const retraction = e.removed ?? undoOf.get(e.id);
    if (!isLive && !retraction) continue;
    if (isLive && e.type === "journeyman") { if (jmShown.has(e.team)) continue; jmShown.add(e.team); }
    if (!isLive && e.type === "journeyman") continue;
    if (consumed.has(e.id)) continue; // listed beneath its casualty instead
    if (e.type === "casualty") {
      // two lines from the one event: the causer's line on top, the victim's line directly beneath (rows are reversed below, so the victim goes in first)
      const inj = pairedInjury.get(e.id);
      if (inj) {
        const r = inj.removed ?? undoOf.get(inj.id);
        rows.push({ ...build(inj, "victim", live.has(inj.id), r), undoable: true });
      } else if (e.payload?.victim !== undefined) rows.push(build(e, "victim", isLive, retraction, e)); // a game page's casualty may name no victim
      rows.push(build(e, "main", isLive, retraction));
      continue;
    }
    rows.push(build(e, "main", isLive, retraction));
  }
  return rows.reverse();
}

export const PREGAME_STEPS = ["fans", "weather", "journeymen", "inducements", "prayers", "coin", "timers"] as const;
/** The server's `pregame.step`: a PREGAME_STEPS entry, or kickreceive (inside coin), setup / done once playing. */
export type PregameViewStep = PregameStep | "kickreceive" | "setup" | "done";
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
/** Injury results the server accepts: stunned / KO, and the casualty table results for a player hurt with no one to credit. */
export const INJURY_RESULTS_UI = ["stunned", "KO", "BH", "MNG", "NI", "stat loss", "DEAD"] as const;
/** Mid-game weather results the server accepts. */
export const WEATHER_RESULTS_UI = ["Sweltering Heat", "Very Sunny", "Perfect Conditions", "Pouring Rain", "Blizzard"] as const;

/** One marker of the timeline strip: the event, the lane it rides (home above the line, away below, both-team on it) and its icon. */
export interface TimelineMarker { id: string; label: string; lane: "home" | "away" | "both"; glyph: Glyph | undefined; mark: string; admin: boolean; removed: boolean }

/** Markers in play order (kick-off first, end of match last) from the feed rows, which arrive newest first. */
export function timelineMarkers(rows: readonly FeedRow[]): TimelineMarker[] {
  return [...rows].filter((r) => r.part === "main").reverse().map((r) => ({ id: r.id, label: r.label, lane: r.side === "centre" ? "both" : r.side, glyph: r.glyph, mark: r.when, admin: r.admin, removed: r.removed !== null }));
}
