/**
 * Competition templates (creation wizards v2, round 2 Q10 + round 3): the shapes and pure helpers shared by the server
 * (src/templates) and the SPA (spa/src/shared/templates.ts). Owner's words: "Let's also have users able to configure
 * templates for seasons under the league settings." and "Let's extend template functionality to tournament organizers.
 * Allow them to grant access to their created template to another organizer."
 *
 * Accepted design: a template belongs to the organiser who made it. They can share it with named organisers. Shared
 * organisers can use it and copy it, but not edit the original. The owner can stop sharing at any time; competitions
 * already made from it keep their settings. Same for league and tournament templates.
 *
 * A template is settings only: never a webhook URL, a coach, a team, a registration or a result. Payment links are the
 * owner's own and optional: only the owner ever reads them back (a shared view and a copy drop them), and using them
 * is asked each time.
 *
 * Kinds: "season" (a league season: phases, divisions, registration settings, regions, payment-link defaults and the
 * rules + house rules snapshot) and "tournament". A ladder kind is meant to join TEMPLATE_KINDS later with its own
 * content shape and parser; nothing else here assumes only two kinds.
 *
 * Pure and dependency-free apart from the other pure competition modules, so the SPA imports it by relative path.
 */
import {
  DEFAULT_POINTS, PAIRING_AVOID, parsePairingAvoid, parsePointsScheme, parseRegions, parseTiebreakerChain,
  type ChainTiebreaker, type PairingAvoid, type PointsScheme,
} from "./format.js";
import { parseHouseRules, type HouseRules } from "./houseRules.js";

export type TemplateKind = "season" | "tournament";
/** Every kind the store accepts. A future "ladder" kind is added here with its content parser. */
export const TEMPLATE_KINDS: readonly TemplateKind[] = ["season", "tournament"];
export const isTemplateKind = (v: unknown): v is TemplateKind => typeof v === "string" && (TEMPLATE_KINDS as readonly string[]).includes(v);
export const TEMPLATE_KIND_LABEL: Record<TemplateKind, string> = { season: "Season", tournament: "Tournament" };

export const TEMPLATE_NAME_MAX = 60;
export const TEMPLATE_DESCRIPTION_MAX = 300;
/** Templates one organiser may own, and organisers one template may be shared with. */
export const TEMPLATES_PER_OWNER = 100;
export const SHARES_PER_TEMPLATE = 50;
export const TEMPLATE_ID = /^tp[a-f0-9]{12}$/;

export class TemplateError extends Error {
  constructor(readonly status: number, message: string, readonly field?: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** The owner's payment links (PayPal.Me link in its https form, Venmo username without the @). */
export interface TemplatePayLinks { payPal?: string; venmo?: string }

// ---- relative times ---------------------------------------------------------------------------------------------

/** Times a tournament template keeps relative to the start: minutes BEFORE the start (negative = after); null = blank
 *  (the wizard's default: registration opens at publication and closes at the start, check-in 24 h before to the start). */
export interface RelativeTimes {
  registrationOpens: number | null;
  registrationCloses: number | null;
  rosterBy: number | null;
  checkInOpens: number | null;
  checkInCloses: number | null;
}
export const RELATIVE_KEYS = ["registrationOpens", "registrationCloses", "rosterBy", "checkInOpens", "checkInCloses"] as const;
export const RELATIVE_LABEL: Record<(typeof RELATIVE_KEYS)[number], string> = {
  registrationOpens: "Registration opens",
  registrationCloses: "Registration closes",
  rosterBy: "Roster deadline",
  checkInOpens: "Check-in opens",
  checkInCloses: "Check-in closes",
};
/** A year before the start to a week after it. */
export const RELATIVE_MAX_MINUTES = 366 * 24 * 60;
export const RELATIVE_MIN_MINUTES = -7 * 24 * 60;
export const blankRelative = (): RelativeTimes => ({ registrationOpens: null, registrationCloses: null, rosterBy: null, checkInOpens: null, checkInCloses: null });

/** Minutes from `iso` to the start (positive = before it); null when either is missing or unreadable. */
export function minutesBefore(startIso: string | undefined | null, iso: string | undefined | null): number | null {
  if (!startIso || !iso) return null;
  const s = Date.parse(startIso);
  const t = Date.parse(iso);
  if (Number.isNaN(s) || Number.isNaN(t)) return null;
  const m = Math.round((s - t) / 60000);
  return m < RELATIVE_MIN_MINUTES || m > RELATIVE_MAX_MINUTES ? null : m;
}

/** The ISO time `minutes` before the start ("" when there is no start or no offset). */
export function resolveRelative(startIso: string | undefined | null, minutes: number | null | undefined): string {
  if (!startIso || minutes === null || minutes === undefined) return "";
  const s = Date.parse(startIso);
  if (Number.isNaN(s)) return "";
  return new Date(s - minutes * 60000).toISOString();
}

/** "24 hours before the start", "2 days before the start", "at the start", "30 minutes after the start". */
export function relativeText(minutes: number | null): string {
  if (minutes === null) return "";
  if (minutes === 0) return "At the start";
  const abs = Math.abs(minutes);
  const unit = abs % 1440 === 0 ? { n: abs / 1440, w: "day" } : abs % 60 === 0 ? { n: abs / 60, w: "hour" } : { n: abs, w: "minute" };
  return `${unit.n} ${unit.w}${unit.n === 1 ? "" : "s"} ${minutes > 0 ? "before" : "after"} the start`;
}

function parseRelative(raw: unknown): RelativeTimes {
  const out = blankRelative();
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) throw new TemplateError(400, "Relative times must be an object.", "relative");
  for (const k of RELATIVE_KEYS) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < RELATIVE_MIN_MINUTES || v > RELATIVE_MAX_MINUTES)
      throw new TemplateError(400, `${RELATIVE_LABEL[k]} must be a whole number of minutes, at most a year before the start and a week after it.`, `relative.${k}`);
    out[k] = v;
  }
  return out;
}

// ---- tournament content -----------------------------------------------------------------------------------------

export type TemplateFormat = "swiss" | "roundRobin" | "knockout";
export type TemplatePairing = "dutch" | "monrad" | "eloSeeded";
export const TEMPLATE_FORMATS: readonly TemplateFormat[] = ["swiss", "roundRobin", "knockout"];
export const TEMPLATE_PAIRINGS: readonly TemplatePairing[] = ["dutch", "monrad", "eloSeeded"];

export interface TournamentTemplateContent {
  /** The ruleset reference (a saved package name), never a copy of the package. */
  packageName: string;
  houseRules: HouseRules;
  format: TemplateFormat;
  /** Swiss only; null = Auto. */
  roundCount: number | null;
  /** Swiss only; null = the default (Dutch, or the series' seeding). */
  pairingSystem: TemplatePairing | null;
  seedingMode: "elo" | "manual";
  turnTimer: "off" | "optional" | "required";
  /** After points, in order. */
  tiebreakers: ChainTiebreaker[];
  points: PointsScheme;
  pairingAvoid: PairingAvoid;
  regions: string[];
  playOnFork: boolean;
  maxPlayers: number;
  approval: "auto" | "organiser";
  waitlist: boolean;
  rosterLater: boolean;
  selfCheckIn: boolean;
  nafSanctioned: boolean;
  entryFee: string;
  relative: RelativeTimes;
  /** The Discord event toggles only (tournament event keys). Never the webhook URL. */
  discordEvents: Record<string, boolean>;
  /** Optional, the owner's own; asked on use. */
  payLinks?: TemplatePayLinks;
}

export interface TournamentContentOptions {
  /** The event keys a tournament's Discord setup has (src/discord/catalogue.ts eventKeysFor("tournament")). */
  eventKeys: readonly string[];
  /** A payment link check (src/payments/links.ts parsePayField): undefined = absent, else ok + value or the refusal. */
  payField: (kind: "payPal" | "venmo", raw: unknown) => { ok: true; value: string } | { ok: false; error: string } | undefined;
}

export const ENTRY_FEE_TEMPLATE_MAX = 40;
export const MAX_PLAYERS_TEMPLATE = 512;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const bool = (v: unknown, field: string, fallback: boolean): boolean => {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new TemplateError(400, `${field} must be true or false.`, field);
  return v;
};
/** Format / house-rules parser errors as template errors (400 with their field). */
function wrap<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof TemplateError) throw e;
    const err = e as { message?: string; field?: string };
    throw new TemplateError(400, err.message ?? "That template is not valid.", err.field);
  }
}

/** Optional payment links; absent fields stay absent, a bad one is refused. */
export function parsePayLinks(raw: unknown, payField: TournamentContentOptions["payField"]): TemplatePayLinks | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObj(raw)) throw new TemplateError(400, "Payment links must be an object.", "payLinks");
  const out: TemplatePayLinks = {};
  for (const kind of ["payPal", "venmo"] as const) {
    const checked = payField(kind, raw[kind]);
    if (!checked) continue;
    if (!checked.ok) throw new TemplateError(400, checked.error, `payLinks.${kind}`);
    if (checked.value) out[kind] = checked.value;
  }
  return out.payPal || out.venmo ? out : undefined;
}

/** A tournament template's settings from a request body (the wizard's Review) or a capture, every field checked by the
 *  same parsers the tournament routes use. Unknown fields are dropped, so nothing else can ride into a template. */
export function parseTournamentTemplateContent(raw: unknown, opts: TournamentContentOptions): TournamentTemplateContent {
  if (!isObj(raw)) throw new TemplateError(400, "The template settings must be an object.", "content");
  if (typeof raw.packageName !== "string" || !raw.packageName.trim() || raw.packageName.length > 200) throw new TemplateError(400, "Choose a ruleset.", "packageName");
  const format = raw.format === undefined ? "swiss" : raw.format;
  if (!oneOf(format, TEMPLATE_FORMATS)) throw new TemplateError(400, "Format must be swiss, roundRobin or knockout.", "format");
  let roundCount: number | null = null;
  if (raw.roundCount !== undefined && raw.roundCount !== null && raw.roundCount !== "") {
    if (format !== "swiss") throw new TemplateError(400, "Rounds can be set only for Swiss.", "roundCount");
    if (typeof raw.roundCount !== "number" || !Number.isInteger(raw.roundCount) || raw.roundCount < 1 || raw.roundCount > 50) throw new TemplateError(400, "Rounds must be a whole number from 1 to 50.", "roundCount");
    roundCount = raw.roundCount;
  }
  let pairingSystem: TemplatePairing | null = null;
  if (raw.pairingSystem !== undefined && raw.pairingSystem !== null && raw.pairingSystem !== "") {
    if (!oneOf(raw.pairingSystem, TEMPLATE_PAIRINGS)) throw new TemplateError(400, "Pairing must be dutch, monrad or eloSeeded.", "pairingSystem");
    pairingSystem = format === "swiss" ? raw.pairingSystem : null;
  }
  const seedingMode = raw.seedingMode === undefined ? "elo" : raw.seedingMode;
  if (!oneOf(seedingMode, ["elo", "manual"] as const)) throw new TemplateError(400, "Seeding must be elo or manual.", "seedingMode");
  const turnTimer = raw.turnTimer === undefined ? "optional" : raw.turnTimer;
  if (!oneOf(turnTimer, ["off", "optional", "required"] as const)) throw new TemplateError(400, "Turn timer must be off, optional or required.", "turnTimer");
  const maxPlayers = raw.maxPlayers === undefined ? 16 : raw.maxPlayers;
  if (typeof maxPlayers !== "number" || !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > MAX_PLAYERS_TEMPLATE) throw new TemplateError(400, `Places must be a whole number from 2 to ${MAX_PLAYERS_TEMPLATE}.`, "maxPlayers");
  const approval = raw.approval === undefined ? "auto" : raw.approval;
  if (!oneOf(approval, ["auto", "organiser"] as const)) throw new TemplateError(400, "Approval must be auto or organiser.", "approval");
  if (raw.entryFee !== undefined && raw.entryFee !== null && typeof raw.entryFee !== "string") throw new TemplateError(400, "Entry fee must be text.", "entryFee");
  // eslint-disable-next-line no-control-regex
  const entryFee = String(raw.entryFee ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (entryFee.length > ENTRY_FEE_TEMPLATE_MAX) throw new TemplateError(400, `The entry fee can be at most ${ENTRY_FEE_TEMPLATE_MAX} characters.`, "entryFee");
  const discordEvents: Record<string, boolean> = {};
  if (raw.discordEvents !== undefined && raw.discordEvents !== null) {
    if (!isObj(raw.discordEvents)) throw new TemplateError(400, "Discord events must be an object.", "discordEvents");
    for (const [k, v] of Object.entries(raw.discordEvents)) {
      if (!opts.eventKeys.includes(k)) continue; // a key the tournament setup does not have is dropped, never stored
      if (typeof v !== "boolean") throw new TemplateError(400, `Discord event ${k.slice(0, 40)} must be true or false.`, "discordEvents");
      discordEvents[k] = v;
    }
  }
  const pairingAvoid = raw.pairingAvoid === undefined || raw.pairingAvoid === null ? "none" : wrap(() => parsePairingAvoid(raw.pairingAvoid));
  const payLinks = parsePayLinks(raw.payLinks, opts.payField);
  return {
    packageName: raw.packageName.trim(),
    houseRules: wrap(() => parseHouseRules(raw.houseRules ?? {}, "tournament")),
    format,
    roundCount,
    pairingSystem,
    seedingMode,
    turnTimer,
    tiebreakers: raw.tiebreakers === undefined ? ["buchholz", "touchdownDifferential", "casualtyDifferential"] : wrap(() => parseTiebreakerChain(raw.tiebreakers)),
    points: raw.points === undefined ? { ...DEFAULT_POINTS } : wrap(() => parsePointsScheme(raw.points)),
    pairingAvoid: format === "swiss" && (PAIRING_AVOID as readonly string[]).includes(pairingAvoid) ? pairingAvoid : "none",
    regions: raw.regions === undefined ? [] : wrap(() => parseRegions(raw.regions)),
    playOnFork: bool(raw.playOnFork, "playOnFork", false),
    maxPlayers,
    approval,
    waitlist: bool(raw.waitlist, "waitlist", true),
    rosterLater: bool(raw.rosterLater, "rosterLater", true),
    selfCheckIn: bool(raw.selfCheckIn, "selfCheckIn", true),
    nafSanctioned: bool(raw.nafSanctioned, "nafSanctioned", false),
    entryFee,
    relative: parseRelative(raw.relative),
    discordEvents,
    ...(payLinks ? { payLinks } : {}),
  };
}

// ---- season content (the shapes; the server checks them with the league settings parsers) --------------------------

export interface SeasonTemplatePhase {
  id: string;
  category: string;
  name: string;
  /** Division names ("" = one unnamed division). */
  groups: string[];
  format?: "table" | "knockout";
  includes?: string[];
  points?: { win: number; draw: number; loss: number };
  tiebreaks?: string[];
}

export interface SeasonTemplateRegistration {
  allowedRosters: { official: boolean; nafApproved: boolean; unofficial: boolean };
  allowRegistration: boolean;
  maxRegistrations: number | null;
  maxPerRace: number | null;
  approval: "auto" | "organiser";
  waitlist: boolean;
  allowExistingTeams: boolean;
  allowMidSeason: boolean;
  entryFee: string;
}

export interface SeasonTemplateContent {
  /** The rules snapshot: base ruleset, ruleset card (package name or null) and the league house rules. */
  ruleset: "BB2020" | "BB2025";
  rulesetPackage: string | null;
  houseRules: HouseRules;
  /** Phase structure only: never standings, fixtures, teams or results. */
  phases: SeasonTemplatePhase[];
  /** Registration settings without the window's dates (a new season sets its own). */
  registration: SeasonTemplateRegistration;
  regions: string[];
  /** Payment-link defaults (optional, the owner's own; asked on use). */
  payLinks?: TemplatePayLinks;
}

export type TemplateContent = SeasonTemplateContent | TournamentTemplateContent;

// ---- summaries (the Templates list, the pickers) ------------------------------------------------------------------

const FORMAT_TEXT: Record<TemplateFormat, string> = { swiss: "Swiss", roundRobin: "Round-Robin", knockout: "Knockout" };

/** Short key/value rows describing a template's settings (both kinds). */
export function templateSummary(kind: TemplateKind, content: unknown): Array<{ k: string; v: string }> {
  if (!isObj(content)) return [];
  const rows: Array<{ k: string; v: string }> = [];
  const add = (k: string, v: unknown) => { if (typeof v === "string" && v) rows.push({ k, v }); };
  if (kind === "season") {
    const c = content as Partial<SeasonTemplateContent>;
    add("Ruleset", c.rulesetPackage || c.ruleset);
    const phases = Array.isArray(c.phases) ? c.phases : [];
    add("Phases", phases.map((p) => p.name).filter(Boolean).join(", "));
    const regular = phases.find((p) => p.id === "season-regular") ?? phases[0];
    const divisions = (regular?.groups ?? []).filter(Boolean);
    add("Divisions", divisions.length ? divisions.join(", ") : "One");
    const r = c.registration;
    if (r) {
      add("Approval", r.approval === "auto" ? "Auto-accept" : "Organiser approval");
      add("Max teams", r.maxRegistrations === null ? "No limit" : String(r.maxRegistrations));
      add("Entry fee", r.entryFee);
    }
    if (Array.isArray(c.regions) && c.regions.length) add("Regions", c.regions.join(", "));
    return rows;
  }
  const c = content as Partial<TournamentTemplateContent>;
  add("Ruleset", c.packageName);
  if (c.format) add("Format", `${FORMAT_TEXT[c.format] ?? c.format}${c.format === "swiss" ? `, ${c.roundCount ? `${c.roundCount} rounds` : "auto rounds"}` : ""}`);
  if (c.points) add("Points (W/D/L)", `${c.points.win} / ${c.points.draw} / ${c.points.loss}`);
  if (typeof c.maxPlayers === "number") add("Places", String(c.maxPlayers));
  if (c.relative) {
    const ci = c.selfCheckIn ? relativeText(c.relative.checkInOpens) : "";
    add("Check-in opens", ci);
  }
  add("Entry fee", c.entryFee);
  return rows;
}
