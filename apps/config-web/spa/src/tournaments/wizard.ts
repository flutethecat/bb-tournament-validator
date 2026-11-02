// Tournament creation wizard (/app/tournaments/new; registration spec 2026-11-02 §6, lane L3): Ruleset -> Details ->
// Registration -> Review, then "Save draft" (unpublished: only the organisers see it) or "Publish". One POST
// /api/tournaments carries the old dialog's body (create.ts createBody) plus `publish`, the details, the page fields and the
// registration settings; the server validates everything before it writes (src/tournaments/api.ts wizardCreateFields).
//
// The form survives a trip to the Tournament Creator ("Create a new ruleset", ?return=wizard) in sessionStorage: a
// per-viewer convenience only, read and written inside try/catch, and cleared once the tournament exists.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import { createBody, type CreateTournamentBody, type TournamentFormat } from "./create";
import { fromLocalInput, PAIRING_LABEL, SEEDING_LABEL, TIEBREAKER_LABEL, type TournamentPrimaryTiebreaker } from "./detail";
import type { TournamentPairingSystem, TournamentSeedingMode } from "../shared/api";
import { normalisePayPal, normaliseVenmo } from "../shared/payLinks";

export type WizardStep = "ruleset" | "details" | "registration" | "review";
export const WIZARD_STEPS: ReadonlyArray<{ id: WizardStep; label: string }> = [
  { id: "ruleset", label: "Ruleset" }, { id: "details", label: "Details" }, { id: "registration", label: "Registration" }, { id: "review", label: "Review" },
];
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
    packageName: "", name: "", seriesId: "", startsAt: "", endsAt: "", playOnFork: false, venue: "", address: "", mapUrl: "", startTime: "",
    format: "swiss", roundCount: "", pairingSystem: "", seedingMode: "elo", primaryTiebreaker: "buchholz", turnTimer: "optional", summary: "",
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
  deadlines?: { registration?: string; checkIn?: string };
  registration: {
    opensAt?: string; approval: "auto" | "organiser"; waitlist: boolean; rosterLater: boolean; rosterBy?: string;
    checkIn: { self: boolean; opensAt?: string };
  };
}

/** The POST /api/tournaments body: exactly the old dialog's (createBody) plus the wizard fields. */
export function wizardBody(form: WizardForm, publish: boolean): WizardBody {
  const base = createBody({
    name: form.name, packageName: form.packageName, maxPlayers: form.maxPlayers, format: form.format, roundCount: form.roundCount,
    primaryTiebreaker: form.primaryTiebreaker, nafSanctioned: form.nafSanctioned, ...(form.seriesId ? { seriesId: form.seriesId } : {}),
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

/** The first problem with a step (the server's own checks; its message still wins when it refuses), or "". */
export function stepProblem(step: WizardStep, form: WizardForm): string {
  if (step === "ruleset") return form.packageName ? "" : "Choose a ruleset.";
  if (step === "details") {
    const name = form.name.trim();
    if (!name) return "Enter a name.";
    if (name.length > 100) return "The name can be at most 100 characters.";
    if (form.format === "swiss" && form.roundCount !== "") {
      const rounds = Number(form.roundCount);
      if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 50) return "Rounds must be a whole number from 1 to 50 (or blank for Auto).";
    }
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
  const s = series.find((x) => x.id === form.seriesId);
  const defaultPairing = s?.seeding ? SERIES_PAIRING[s.seeding] ?? "dutch" : "dutch";
  const rows = (list: Array<[string, string | false | undefined]>) => list.filter((r): r is [string, string] => Boolean(r[1])).map(([k, v]) => ({ k, v }));
  return {
    ruleset: rows([["Ruleset", form.packageName || "Not chosen"]]),
    details: rows([
      ["Name", form.name.trim()],
      ["Series", s?.name],
      ["Starts", when(form.startsAt)],
      ["Ends", when(form.endsAt)],
      ["Played on", form.playOnFork ? "Super FUMBBL" : "Tabletop"],
      ["Venue", !form.playOnFork && form.venue.trim()],
      ["Address", !form.playOnFork && form.address.trim()],
      ["Local start", !form.playOnFork && form.startTime],
      ["Format", FORMAT_LABEL[form.format]],
      ["Rounds", form.format === "swiss" ? (form.roundCount === "" ? "Auto" : String(form.roundCount)) : undefined],
      ["Pairing", form.format === "swiss" ? PAIRING_LABEL[form.pairingSystem || defaultPairing] : undefined],
      ["Seeding", SEEDING_LABEL[form.seedingMode]],
      ["Tiebreaker", TIEBREAKER_LABEL[form.primaryTiebreaker]],
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
}

const NUMBER_OR_BLANK: ReadonlySet<keyof WizardForm> = new Set(["roundCount", "maxPlayers"]);

function readDraft(): { step?: WizardStep; form?: Partial<WizardForm> } | undefined {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as { step?: WizardStep; form?: Partial<WizardForm> } : undefined;
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
  });
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
          const ok = typeof v === typeof blank[k] || (NUMBER_OR_BLANK.has(k) && (v === "" || typeof v === "number"));
          if (v !== undefined && ok) (form as unknown as Record<string, unknown>)[k] = v;
        }
      }
      if (form.approval !== "auto") form.approval = "auto"; // organiser approval waits for lane L4
      state.form = form;
      state.step = saved?.step && WIZARD_STEPS.some((s) => s.id === saved.step) ? saved.step : "ruleset";
      if (opts.seriesId) state.form.seriesId = opts.seriesId;
      if (opts.packageName) { state.form.packageName = opts.packageName; if (state.step === "ruleset") state.step = "details"; }
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
    /** POST /api/tournaments. Resolves to the new id, or undefined with `error` set. */
    async submit(publish: boolean): Promise<string | undefined> {
      if (state.busy) return undefined;
      const bad = firstProblemStep(state.form);
      if (bad) { state.error = bad.problem; state.step = bad.step; return undefined; }
      state.busy = publish ? "publish" : "draft";
      state.error = "";
      state.signedOut = false;
      try {
        const res = await deps.api<{ tournament?: { id?: unknown } }>("/api/tournaments", { method: "POST", body: wizardBody(state.form, publish) });
        const id = typeof res?.tournament?.id === "string" ? res.tournament.id : "";
        if (!id) { state.error = "The server did not return the new tournament."; return undefined; }
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
