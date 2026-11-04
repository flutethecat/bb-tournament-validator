// Tournament creation wizard (/app/tournaments/new; registration spec 2026-11-02 §6, lane L3; creation wizards v2):
// Ruleset (+ house rules) -> General -> Format -> Registration -> Review, then "Save as draft" (unpublished: only the
// organisers see it) or "Publish now". Older saved drafts used a single "details" step: it opens as General. One POST
// /api/tournaments carries the old dialog's body (create.ts createBody) plus `publish`, the details, the page fields and the
// registration settings; the server validates everything before it writes (src/tournaments/api.ts wizardCreateFields).
//
// The form survives a trip to the Tournament Creator ("Create a new ruleset", ?return=wizard) in sessionStorage: a
// per-viewer convenience only, read and written inside try/catch, and cleared once the tournament exists.

import { isDiscordWebhook } from "../shared/discord";
import { reactive, toRaw, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import { createBody, type CreateTournamentBody, type TournamentFormat } from "./create";
import { fromLocalInput, PAIRING_LABEL, SEEDING_LABEL, toLocalInput, type TournamentPrimaryTiebreaker } from "./detail";
import { minutesBefore, resolveRelative, type RelativeTimes, type TournamentTemplateContent } from "../shared/templates";
import type { TournamentPairingSystem, TournamentSeedingMode } from "../shared/api";
import { normalisePayPal, normaliseVenmo } from "../shared/payLinks";
import {
  chainFromPrimary, chainText, DEFAULT_POINTS, DEFAULT_RULESET_PACKAGE, DEFAULT_TIEBREAKER_CHAIN, defaultHouseRules, FormatError, houseRulesRows,
  HouseRulesError, PAIRING_AVOID_LABEL, parseHouseRules, parsePointsScheme, parseRegions, parseTiebreakerChain, pointsText, rulesetLabel,
  type ChainTiebreaker, type HouseRules, type PairingAvoid, type PointsScheme,
} from "../shared/competition";

export type WizardStep = "ruleset" | "general" | "format" | "registration" | "review";
export const WIZARD_STEPS: ReadonlyArray<{ id: WizardStep; label: string }> = [
  { id: "ruleset", label: "Ruleset" }, { id: "general", label: "General" }, { id: "format", label: "Format" }, { id: "registration", label: "Registration" }, { id: "review", label: "Review" },
];
/** Step ids an older saved draft may carry (the v1 wizard's single "details" step held what General now starts with). */
export const LEGACY_STEP: Readonly<Record<string, WizardStep>> = { details: "general" };
/** A saved step id as a v2 step (unknown = undefined). */
export function migrateStep(step: unknown): WizardStep | undefined {
  if (typeof step !== "string") return undefined;
  if (WIZARD_STEPS.some((s) => s.id === step)) return step as WizardStep;
  return LEGACY_STEP[step];
}
export const DRAFT_KEY = "sf.tournamentWizard";
export const PUBLISHED_NOTICE = "Tournament published.";
export const DRAFT_NOTICE = "Tournament saved as an unpublished draft. Only its organisers can see it until you publish it.";

export type TurnTimerMode = "off" | "optional" | "required";
export const TURN_TIMER_LABEL: Record<TurnTimerMode, string> = { off: "Off", optional: "Optional", required: "Required" };
export const APPROVAL_LABEL = { auto: "Accept entries automatically", organiser: "Organisers approve each entry" } as const;

export interface WizardForm {
  packageName: string;
  name: string;
  seriesId: string;
  /** datetime-local values (UTC), "" = not set. */
  startsAt: string;
  endsAt: string;
  playOnFork: boolean;
  venue: string;
  address: string;
  mapUrl: string;
  startTime: string;
  format: TournamentFormat;
  roundCount: number | "";
  /** "" = the default (Dutch, or the series' seeding). */
  pairingSystem: TournamentPairingSystem | "";
  seedingMode: TournamentSeedingMode;
  primaryTiebreaker: TournamentPrimaryTiebreaker;
  turnTimer: TurnTimerMode;
  summary: string;
  /** Creation wizards v2: W/D/L, the tiebreaker chain after points, Swiss avoidance, regions, house rules. */
  points: PointsScheme;
  tiebreakerChain: ChainTiebreaker[];
  pairingAvoid: PairingAvoid;
  regions: string[];
  houseRules: HouseRules;
  // registration
  opensAt: string;
  closesAt: string;
  maxPlayers: number | "";
  waitlist: boolean;
  approval: "auto" | "organiser";
  rosterLater: boolean;
  rosterBy: string;
  selfCheckIn: boolean;
  checkInOpensAt: string;
  checkInClosesAt: string;
  entryFee: string;
  /** Payment links (optional): a PayPal.Me link and a Venmo username. */
  payPal: string;
  venmo: string;
  nafSanctioned: boolean;
}

/** The owner's defaults (11-02): auto-accept (Q5), waitlist on (Q6), roster later on (Q4), self check-in on (Q11). */
export function blankWizardForm(): WizardForm {
  return {
    // BB2025 is preselected (owner 11-02); the wizard clears it if this server has no such package.
    packageName: DEFAULT_RULESET_PACKAGE, name: "", seriesId: "", startsAt: "", endsAt: "", playOnFork: false, venue: "", address: "", mapUrl: "", startTime: "",
    format: "swiss", roundCount: "", pairingSystem: "", seedingMode: "elo", primaryTiebreaker: "buchholz", turnTimer: "optional", summary: "",
    points: { ...DEFAULT_POINTS }, tiebreakerChain: [...DEFAULT_TIEBREAKER_CHAIN], pairingAvoid: "none", regions: [], houseRules: defaultHouseRules("tournament"),
    opensAt: "", closesAt: "", maxPlayers: 16, waitlist: true, approval: "auto", rosterLater: true, rosterBy: "", selfCheckIn: true,
    checkInOpensAt: "", checkInClosesAt: "", entryFee: "", payPal: "", venmo: "", nafSanctioned: false,
  };
}

export interface WizardBody extends CreateTournamentBody {
  publish: boolean;
  startsAt?: string;
  endsAt?: string;
  playOnFork?: true;
  pairingSystem?: TournamentPairingSystem;
  seedingMode: TournamentSeedingMode;
  turnTimer: { enforced: TurnTimerMode };
  location?: { venue?: string; address?: string; mapUrl?: string };
  startTime?: string;
  entryFee?: string;
  payPal?: string;
  venmo?: string;
  summary?: string;
  tiebreakers: ChainTiebreaker[];
  points: PointsScheme;
  houseRules: HouseRules;
  pairingAvoid?: PairingAvoid;
  regions?: string[];
  deadlines?: { registration?: string; checkIn?: string };
  registration: {
    opensAt?: string; approval: "auto" | "organiser"; waitlist: boolean; rosterLater: boolean; rosterBy?: string;
    checkIn: { self: boolean; opensAt?: string };
  };
}

/** The POST /api/tournaments body: exactly the old dialog's (createBody) plus the wizard fields. */
export function wizardBody(form: WizardForm, publish: boolean): WizardBody {
  // The old single field still rides along (the server reads the chain over it); it mirrors chain[0] when it can.
  const first = form.tiebreakerChain[0];
  const base = createBody({
    name: form.name, packageName: form.packageName, maxPlayers: form.maxPlayers, format: form.format, roundCount: form.roundCount,
    primaryTiebreaker: first === "buchholz" || first === "sonnebornBerger" ? first : form.primaryTiebreaker, nafSanctioned: form.nafSanctioned, ...(form.seriesId ? { seriesId: form.seriesId } : {}),
  });
  const iso = (v: string) => (v ? fromLocalInput(v) : "");
  const startsAt = iso(form.startsAt);
  const endsAt = iso(form.endsAt);
  const tabletop = !form.playOnFork;
  const location = tabletop ? {
    ...(form.venue.trim() ? { venue: form.venue.trim() } : {}),
    ...(form.address.trim() ? { address: form.address.trim() } : {}),
    ...(form.mapUrl.trim() ? { mapUrl: form.mapUrl.trim() } : {}),
  } : {};
  const registration = iso(form.closesAt);
  const checkIn = form.selfCheckIn ? iso(form.checkInClosesAt) : "";
  const deadlines = { ...(registration ? { registration } : {}), ...(checkIn ? { checkIn } : {}) };
  const opensAt = iso(form.opensAt);
  const rosterBy = form.rosterLater ? iso(form.rosterBy) : "";
  const checkInOpens = form.selfCheckIn ? iso(form.checkInOpensAt) : "";
  const payPal = normalisePayPal(form.payPal);
  const venmo = normaliseVenmo(form.venmo);
  return {
    ...base,
    publish,
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    ...(form.playOnFork ? { playOnFork: true as const } : {}),
    ...(form.format === "swiss" && form.pairingSystem ? { pairingSystem: form.pairingSystem } : {}),
    seedingMode: form.seedingMode,
    turnTimer: { enforced: form.turnTimer },
    ...(Object.keys(location).length ? { location } : {}),
    ...(tabletop && form.startTime ? { startTime: form.startTime } : {}),
    ...(form.entryFee.trim() ? { entryFee: form.entryFee.trim() } : {}),
    ...(form.payPal.trim() ? { payPal: payPal.ok ? payPal.value : form.payPal.trim() } : {}),
    ...(form.venmo.trim() ? { venmo: venmo.ok ? venmo.value : form.venmo.trim() } : {}),
    ...(form.summary.trim() ? { summary: form.summary.trim() } : {}),
    tiebreakers: [...form.tiebreakerChain],
    points: { win: Number(form.points.win), draw: Number(form.points.draw), loss: Number(form.points.loss) },
    houseRules: structuredClone(toRaw(form.houseRules)),
    ...(form.format === "swiss" && form.pairingAvoid !== "none" ? { pairingAvoid: form.pairingAvoid } : {}),
    ...(regionList(form).length ? { regions: regionList(form) } : {}),
    ...(Object.keys(deadlines).length ? { deadlines } : {}),
    registration: {
      ...(opensAt ? { opensAt } : {}),
      approval: form.approval,
      waitlist: form.waitlist,
      rosterLater: form.rosterLater,
      ...(rosterBy ? { rosterBy } : {}),
      checkIn: { self: form.selfCheckIn, ...(checkInOpens ? { opensAt: checkInOpens } : {}) },
    },
  };
}

const before = (a: string, b: string) => Boolean(a && b) && a >= b;
const regionList = (form: Pick<WizardForm, "regions">): string[] => form.regions.map((r) => r.trim()).filter(Boolean);
const parsed = (check: () => unknown): string => {
  try { check(); return ""; } catch (e) { return e instanceof FormatError || e instanceof HouseRulesError ? e.message : "Check this step."; }
};

/** The first problem with a step (the server's own checks; its message still wins when it refuses), or "". */
export function stepProblem(step: WizardStep, form: WizardForm): string {
  if (step === "ruleset") {
    if (!form.packageName) return "Choose a ruleset.";
    return parsed(() => parseHouseRules(form.houseRules, "tournament"));
  }
  if (step === "format") {
    if (form.format === "swiss" && form.roundCount !== "") {
      const rounds = Number(form.roundCount);
      if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 50) return "Rounds must be a whole number from 1 to 50 (or blank for Auto).";
    }
    return parsed(() => parsePointsScheme(form.points)) || parsed(() => parseTiebreakerChain(form.tiebreakerChain)) || parsed(() => parseRegions(form.regions));
  }
  if (step === "general") {
    const name = form.name.trim();
    if (!name) return "Enter a name.";
    if (name.length > 100) return "The name can be at most 100 characters.";
    if (form.startsAt && form.endsAt && form.startsAt > form.endsAt) return "The end must not be before the start.";
    if (!form.playOnFork && form.mapUrl.trim() && !/^https?:\/\/\S+$/i.test(form.mapUrl.trim())) return "The map link must start with http:// or https://.";
    if (form.summary.length > 4000) return "The summary can be at most 4000 characters.";
    return "";
  }
  if (step === "registration") {
    const max = Number(form.maxPlayers);
    if (form.maxPlayers === "" || !Number.isSafeInteger(max) || max < 2) return "Places must be a whole number of at least 2.";
    if (before(form.opensAt, form.closesAt)) return "Registration must open before it closes.";
    if (form.closesAt && form.startsAt && form.closesAt > form.startsAt) return "Registration must close by the start.";
    if (form.selfCheckIn && before(form.checkInOpensAt, form.checkInClosesAt)) return "Check-in must open before it closes.";
    if (!form.closesAt && before(form.opensAt, form.startsAt)) return "Registration must open before the tournament starts.";
    if (form.selfCheckIn && !form.checkInClosesAt && before(form.checkInOpensAt, form.startsAt)) return "Check-in must open before the tournament starts.";
    if (form.entryFee.length > 40) return "The entry fee can be at most 40 characters.";
    const payPal = normalisePayPal(form.payPal);
    if (!payPal.ok) return payPal.error;
    const venmo = normaliseVenmo(form.venmo);
    if (!venmo.ok) return venmo.error;
    return "";
  }
  return "";
}

/** The first step with a problem (review sends the organiser back there), or undefined. */
export function firstProblemStep(form: WizardForm): { step: WizardStep; problem: string } | undefined {
  for (const { id } of WIZARD_STEPS) {
    const problem = stepProblem(id, form);
    if (problem) return { step: id, problem };
  }
  return undefined;
}

export interface WizardPackage { name: string; description?: string; date?: string; format?: string }
export interface WizardSeries { id: string; name: string; seeding?: string }

/** Packages whose name or description contain the search text (case-insensitive). */
export function filterPackages(packages: readonly WizardPackage[], query: string): WizardPackage[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...packages];
  return packages.filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q));
}

const SERIES_PAIRING: Record<string, TournamentPairingSystem> = { dutch: "dutch", monrad: "monrad", elo: "eloSeeded" };
const FORMAT_LABEL: Record<TournamentFormat, string> = { swiss: "Swiss", roundRobin: "Round-Robin", knockout: "Knockout" };
const when = (v: string) => (v ? `${v.replace("T", " ")} UTC` : "");

/** Key/value rows for the summary panel and the review step (only what is set, in step order). */
export function summaryRows(form: WizardForm, series: readonly WizardSeries[]): Record<WizardStep, Array<{ k: string; v: string }>> {
  const regions = regionList(form);
  const s = series.find((x) => x.id === form.seriesId);
  const defaultPairing = s?.seeding ? SERIES_PAIRING[s.seeding] ?? "dutch" : "dutch";
  const rows = (list: Array<[string, string | false | undefined]>) => list.filter((r): r is [string, string] => Boolean(r[1])).map(([k, v]) => ({ k, v }));
  return {
    ruleset: [
      ...rows([["Ruleset", form.packageName ? rulesetLabel(form.packageName) : "Not chosen"]]),
      ...houseRulesRows(form.houseRules, "tournament"),
    ],
    general: rows([
      ["Name", form.name.trim()],
      ["Series", s?.name],
      ["Starts", when(form.startsAt)],
      ["Ends", when(form.endsAt)],
      ["Played on", form.playOnFork ? "Super FUMBBL" : "Tabletop"],
      ["Venue", !form.playOnFork && form.venue.trim()],
      ["Address", !form.playOnFork && form.address.trim()],
      ["Local start", !form.playOnFork && form.startTime],
    ]),
    format: rows([
      ["Format", FORMAT_LABEL[form.format]],
      ["Rounds", form.format === "swiss" ? (form.roundCount === "" ? "Auto" : String(form.roundCount)) : undefined],
      ["Pairing", form.format === "swiss" ? PAIRING_LABEL[form.pairingSystem || defaultPairing] : undefined],
      ["Seeding", SEEDING_LABEL[form.seedingMode]],
      ["Points (W/D/L)", pointsText(form.points)],
      ["Ranking", chainText(form.tiebreakerChain)],
      ["Avoid pairing", form.format === "swiss" ? PAIRING_AVOID_LABEL[form.pairingAvoid] : undefined],
      ["Regions", regions.length ? regions.join(", ") : undefined],
      ["Turn timer", TURN_TIMER_LABEL[form.turnTimer]],
    ]),
    registration: rows([
      ["Opens", form.opensAt ? when(form.opensAt) : "When published"],
      ["Closes", form.closesAt ? when(form.closesAt) : "At the start"],
      ["Places", form.maxPlayers === "" ? "" : String(form.maxPlayers)],
      ["Waitlist", form.waitlist ? "On" : "Off"],
      ["Approval", form.approval === "auto" ? "Automatic" : "Organisers"],
      ["Rosters", form.rosterLater ? (form.rosterBy ? `Later, by ${when(form.rosterBy)}` : "Later") : "With the entry"],
      ["Check-in", form.selfCheckIn ? "Self check-in" : "Organisers only"],
      ["Entry fee", form.entryFee.trim()],
      ["PayPal", form.payPal.trim() && (normalisePayPal(form.payPal).ok ? "Link set" : "Check the link")],
      ["Venmo", form.venmo.trim() && `@${form.venmo.trim().replace(/^@/, "")}`],
      ["NAF", form.nafSanctioned ? "Sanctioned" : "Not sanctioned"],
    ]),
    review: [],
  };
}

/** Relative template times and the form fields they fill. */
export const RELATIVE_FIELDS: ReadonlyArray<[keyof RelativeTimes, "opensAt" | "closesAt" | "rosterBy" | "checkInOpensAt" | "checkInClosesAt"]> = [
  ["registrationOpens", "opensAt"], ["registrationCloses", "closesAt"], ["rosterBy", "rosterBy"], ["checkInOpens", "checkInOpensAt"], ["checkInCloses", "checkInClosesAt"],
];

/** The wizard's settings as a tournament template body (Review → "Save as template"): times become minutes before the
 *  start; the webhook never goes in (only the event toggles); payment links only when kept. */
export function templateContent(form: WizardForm, events: Record<string, boolean>, includePayLinks: boolean): Record<string, unknown> {
  const start = form.startsAt ? fromLocalInput(form.startsAt) : "";
  const rel = (v: string, on = true) => (on && v ? minutesBefore(start, fromLocalInput(v)) : null);
  const payPal = normalisePayPal(form.payPal);
  const venmo = normaliseVenmo(form.venmo);
  const pay = { ...(payPal.ok && payPal.value ? { payPal: payPal.value } : {}), ...(venmo.ok && venmo.value ? { venmo: venmo.value } : {}) };
  return {
    packageName: form.packageName, houseRules: structuredClone(toRaw(form.houseRules)), format: form.format,
    roundCount: form.format === "swiss" && form.roundCount !== "" ? Number(form.roundCount) : null,
    pairingSystem: form.format === "swiss" && form.pairingSystem ? form.pairingSystem : null,
    seedingMode: form.seedingMode, turnTimer: form.turnTimer, tiebreakers: [...form.tiebreakerChain],
    points: { win: Number(form.points.win), draw: Number(form.points.draw), loss: Number(form.points.loss) },
    pairingAvoid: form.format === "swiss" ? form.pairingAvoid : "none", regions: regionList(form), playOnFork: form.playOnFork,
    maxPlayers: form.maxPlayers === "" ? 16 : Number(form.maxPlayers), approval: form.approval, waitlist: form.waitlist, rosterLater: form.rosterLater,
    selfCheckIn: form.selfCheckIn, nafSanctioned: form.nafSanctioned, entryFee: form.entryFee.trim(),
    relative: {
      registrationOpens: rel(form.opensAt), registrationCloses: rel(form.closesAt), rosterBy: rel(form.rosterBy, form.rosterLater),
      checkInOpens: rel(form.checkInOpensAt, form.selfCheckIn), checkInCloses: rel(form.checkInClosesAt, form.selfCheckIn),
    },
    discordEvents: { ...events },
    ...(includePayLinks && Object.keys(pay).length ? { payLinks: pay } : {}),
  };
}

export interface WizardState {
  step: WizardStep;
  form: WizardForm;
  packages: WizardPackage[];
  packagesStatus: "idle" | "loading" | "ready" | "error";
  series: WizardSeries[];
  search: string;
  busy: "" | "draft" | "publish";
  error: string;
  signedOut: boolean;
  /** Registration step, Discord group: a webhook (a secret: never saved in the browser draft) and the tournament-mode
   *  events, sent to PATCH /api/tournaments/:id/discord right after the tournament is created. */
  discord: { webhook: string; events: Record<string, boolean> };
  /** "Start from template": the template's name, and its times relative to the start (filled in once Starts is set). */
  template: { name: string; relative: RelativeTimes; filled: Partial<Record<string, string>> } | null;
}

/** Tournament mode (requirement 6): what a tournament's Discord setup starts with ticked; the rest starts off. */
export const TOURNAMENT_DISCORD_EVENTS: ReadonlyArray<{ key: string; label: string; on: boolean }> = [
  { key: "published", label: "Published", on: true },
  { key: "registrationClosing", label: "Registration closing in 24 hours", on: true },
  { key: "checkInOpen", label: "Check-in open", on: true },
  { key: "roundPosted", label: "Pairings posted", on: true },
  { key: "matchResult", label: "Match end", on: true },
  { key: "roundStandings", label: "Round summary", on: true },
  { key: "finalStandings", label: "Final standings and champion", on: true },
  { key: "newRegistration", label: "New registration", on: false },
  { key: "registrationOpened", label: "Registration opened", on: false },
  { key: "matchStarted", label: "Match started", on: false },
  { key: "news", label: "News", on: false },
];
export const tournamentModeEvents = (): Record<string, boolean> => Object.fromEntries(TOURNAMENT_DISCORD_EVENTS.map((e) => [e.key, e.on]));

const NUMBER_OR_BLANK: ReadonlySet<keyof WizardForm> = new Set(["roundCount", "maxPlayers"]);

/** A saved form's object-valued fields, checked with the server's own parsers (a bad value keeps the default). */
function restoreObject(k: keyof WizardForm, v: unknown): unknown {
  try {
    if (k === "houseRules") return parseHouseRules(v, "tournament");
    if (k === "points") return parsePointsScheme(v);
    if (k === "tiebreakerChain") return parseTiebreakerChain(v);
    if (k === "regions") return Array.isArray(v) && v.every((r) => typeof r === "string") ? [...v] : undefined;
  } catch { return undefined; }
  return undefined;
}
const OBJECT_FIELDS: ReadonlySet<keyof WizardForm> = new Set(["houseRules", "points", "tiebreakerChain", "regions"]);

function readDraft(): { step?: unknown; form?: Partial<WizardForm> } | undefined {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as { step?: unknown; form?: Partial<WizardForm> } : undefined;
  } catch { return undefined; }
}
function writeDraft(value: { step: WizardStep; form: WizardForm } | null): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (value) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch { /* no storage */ }
}

export function createTournamentWizard(deps: { api: Fetcher; onSignedOut?: () => void; onCreated?: (id: string, published: boolean) => void }) {
  const state = reactive<WizardState>({
    step: "ruleset", form: blankWizardForm(), packages: [], packagesStatus: "idle", series: [], search: "", busy: "", error: "", signedOut: false,
    discord: { webhook: "", events: tournamentModeEvents() },
    template: null,
  });
  /** Fill the template's relative times from Starts: a field still blank, or still holding what the template put there. */
  function resolveTemplateTimes(): void {
    const t = state.template;
    if (!t || !state.form.startsAt) return;
    const start = fromLocalInput(state.form.startsAt);
    for (const [key, field] of RELATIVE_FIELDS) {
      const at = toLocalInput(resolveRelative(start, t.relative[key]));
      if (!at) continue;
      if (state.form[field] === "" || state.form[field] === t.filled[field]) { state.form[field] = at; t.filled[field] = at; }
    }
  }
  const blank = blankWizardForm();
  const keys = Object.keys(blank) as Array<keyof WizardForm>;

  return {
    state,
    /** Opens the wizard: restores a saved draft (back from the Tournament Creator), then applies ?package= / ?series=. */
    start(opts: { packageName?: string; seriesId?: string; restore?: boolean } = {}): void {
      const saved = opts.restore === false ? undefined : readDraft();
      const form = blankWizardForm();
      if (saved?.form) {
        for (const k of keys) {
          const v = saved.form[k];
          if (v === undefined) continue;
          if (OBJECT_FIELDS.has(k)) {
            const value = restoreObject(k, v);
            if (value !== undefined) (form as unknown as Record<string, unknown>)[k] = value;
            continue;
          }
          const ok = typeof v === typeof blank[k] || (NUMBER_OR_BLANK.has(k) && (v === "" || typeof v === "number"));
          if (ok) (form as unknown as Record<string, unknown>)[k] = v;
        }
        // A v1 draft had one "first tiebreaker" and no chain: it becomes the chain's first entry (the old ladder).
        if (saved.form.tiebreakerChain === undefined && (saved.form.primaryTiebreaker === "buchholz" || saved.form.primaryTiebreaker === "sonnebornBerger"))
          form.tiebreakerChain = chainFromPrimary(saved.form.primaryTiebreaker);
      }
      if (form.approval !== "auto" && form.approval !== "organiser") form.approval = "auto";
      state.form = form;
      state.step = migrateStep(saved?.step) ?? "ruleset";
      if (opts.seriesId) state.form.seriesId = opts.seriesId;
      if (opts.packageName) { state.form.packageName = opts.packageName; if (state.step === "ruleset") state.step = "general"; }
      state.error = "";
      state.signedOut = false;
    },
    /** Keep the form for this tab (Tournament Creator round trip). */
    remember(): void { writeDraft({ step: state.step, form: state.form }); },
    forget(): void { writeDraft(null); },
    async loadPackages(): Promise<void> {
      state.packagesStatus = "loading";
      try {
        const list = await deps.api<unknown>("/api/packages");
        state.packages = (Array.isArray(list) ? list : [])
          .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object" && typeof (e as { name?: unknown }).name === "string" && Boolean((e as { name: string }).name))
          .map((e) => ({
            name: String(e.name),
            ...(typeof e.description === "string" && e.description ? { description: e.description } : {}),
            ...(typeof e.date === "string" && e.date ? { date: e.date } : {}),
            ...(typeof e.format === "string" ? { format: e.format } : {}),
          }));
        state.packagesStatus = "ready";
        // The preselected BB2025 card only stands when this server has that package.
        if (state.form.packageName === DEFAULT_RULESET_PACKAGE && !state.packages.some((p) => p.name === DEFAULT_RULESET_PACKAGE)) state.form.packageName = "";
      } catch {
        state.packagesStatus = state.packages.length ? "ready" : "error";
      }
    },
    /** Series the coach may create inside (their own; admins: all). A failed read leaves the list empty. */
    async loadSeries(): Promise<void> {
      try {
        const res = await deps.api<{ series?: Array<{ id?: unknown; name?: unknown; seeding?: unknown; canEdit?: unknown }> }>("/api/series");
        state.series = (res?.series ?? [])
          .filter((s) => s.canEdit === true && typeof s.id === "string" && typeof s.name === "string")
          .map((s) => ({ id: s.id as string, name: s.name as string, ...(typeof s.seeding === "string" ? { seeding: s.seeding } : {}) }));
      } catch { state.series = []; }
    },
    pickPackage(name: string): void { state.form.packageName = name; },
    resolveTemplateTimes,
    /** "Start from template": the template's settings over the form (name, dates, venue and summary stay); its times
     *  relative to the start fill in once Starts is set; payment links only when the organiser said so. */
    applyTemplate(name: string, c: TournamentTemplateContent, usePayLinks: boolean): void {
      const f = state.form;
      f.packageName = c.packageName;
      f.houseRules = structuredClone(c.houseRules);
      f.format = c.format;
      f.roundCount = c.roundCount ?? "";
      f.pairingSystem = c.pairingSystem ?? "";
      f.seedingMode = c.seedingMode;
      f.turnTimer = c.turnTimer;
      f.tiebreakerChain = [...c.tiebreakers];
      f.points = { ...c.points };
      f.pairingAvoid = c.pairingAvoid;
      f.regions = [...c.regions];
      f.playOnFork = c.playOnFork;
      f.maxPlayers = c.maxPlayers;
      f.approval = c.approval;
      f.waitlist = c.waitlist;
      f.rosterLater = c.rosterLater;
      f.selfCheckIn = c.selfCheckIn;
      f.nafSanctioned = c.nafSanctioned;
      f.entryFee = c.entryFee;
      if (usePayLinks && c.payLinks) { f.payPal = c.payLinks.payPal ?? ""; f.venmo = c.payLinks.venmo ?? ""; }
      for (const [, field] of RELATIVE_FIELDS) f[field] = "";
      state.discord.events = { ...tournamentModeEvents(), ...c.discordEvents };
      state.template = { name, relative: { ...c.relative }, filled: {} };
      resolveTemplateTimes();
      state.error = "";
    },
    /** Move to a step; going forward checks every step before it (the first problem shows and the wizard stays). */
    go(step: WizardStep): boolean {
      const to = WIZARD_STEPS.findIndex((s) => s.id === step);
      for (const { id } of WIZARD_STEPS.slice(0, to)) {
        const problem = stepProblem(id, state.form);
        if (problem) { state.error = problem; state.step = id; return false; }
      }
      state.error = "";
      state.step = step;
      return true;
    },
    /** POST /api/tournaments. Resolves to the new id, or undefined with `error` set. Save as draft and Publish now both
     *  check the whole form first (the first problem opens its step).
     *  PAYMENT SLOT (owner 11-02: "the review page is where payment would go"): a future charge-at-publish step runs here,
     *  before the POST, for `publish === true` only. Nothing is charged today. */
    async submit(publish: boolean): Promise<string | undefined> {
      if (state.busy) return undefined;
      const bad = firstProblemStep(state.form);
      if (bad) { state.error = bad.problem; state.step = bad.step; return undefined; }
      if (state.discord.webhook.trim() && !isDiscordWebhook(state.discord.webhook)) { state.error = "That is not a Discord webhook URL (https://discord.com/api/webhooks/...)."; state.step = "registration"; return undefined; }
      state.busy = publish ? "publish" : "draft";
      state.error = "";
      state.signedOut = false;
      try {
        const res = await deps.api<{ tournament?: { id?: unknown } }>("/api/tournaments", { method: "POST", body: wizardBody(state.form, publish) });
        const id = typeof res?.tournament?.id === "string" ? res.tournament.id : "";
        if (!id) { state.error = "The server did not return the new tournament."; return undefined; }
        // Discord (Registration step): saved on the new tournament; a failure leaves it for Manage -> Discord.
        const hook = state.discord.webhook.trim();
        if (hook) {
          try { await deps.api(`/api/tournaments/${encodeURIComponent(id)}/discord`, { method: "PATCH", body: { url: hook, events: { ...state.discord.events } } }); } catch { /* set it in Manage */ }
          state.discord.webhook = "";
        }
        writeDraft(null);
        deps.onCreated?.(id, publish);
        return id;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          deps.onSignedOut?.();
          state.signedOut = true;
          state.error = "Signed out. Sign in and try again.";
        } else {
          state.error = err instanceof Error ? err.message : "Can't create the tournament.";
        }
        return undefined;
      } finally {
        state.busy = "";
      }
    },
  };
}

export type TournamentWizard = ReturnType<typeof createTournamentWizard>;
export const TOURNAMENT_WIZARD_KEY: InjectionKey<TournamentWizard> = Symbol("tournament-wizard");
