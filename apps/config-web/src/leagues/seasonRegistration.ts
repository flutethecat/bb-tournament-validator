/**
 * Per-season registration settings (registration spec 2026-11-02 Q7, lane L5), backed by the registration core's window
 * (src/registration/window.ts).
 *
 * A season carries `registration` (SeasonRegistration): the league's Registrations settings (allowed rosters, Allow
 * registration, max teams, max per race) plus the window (opens / closes), approval (default organiser, Q5), waitlist
 * (default on, Q6), existing teams (default off, Q8), joining mid-season (default off, Q9) and the entry-fee text (Q17).
 * A new season copies the league's settings as its defaults; a season without its own settings (every season made before
 * this lane) reads the league's current settings, so nothing live changes meaning.
 *
 * Self-registration is open when (seasonWindowStatus): the league is published, the season is not finished, its stage is
 * registration (or active with joining mid-season on), Allow registration is on, and now is in [opensAt, closesAt).
 * The cap check (max teams, max per race) is the core's roomFor; registrationCheck.ts combines both with the roster class.
 */
import {
  normalizeCap, organiserMayAdd, windowStatus, type ApprovalMode, type CompetitionSnapshot, type RegistrationWindow, type WindowStatus,
} from "../registration/index.js";
import { normalisePayPal, parsePayField, venmoUrl } from "../payments/links.js";
import { isDraftLeague, seasonStage } from "./lifecycle.js";
import { DEFAULT_REGISTRATIONS, parseRegistrations, registrationsOf, SettingsError } from "./settings.js";
import { leagueOwner } from "./store.js";
import { leagueTimeZone } from "./timeZone.js";
import type { LeagueRecord, LeagueRegistrations, SeasonRecord } from "./types.js";

export interface SeasonRegistration extends LeagueRegistrations {
  /** ISO; absent = open as soon as the stage allows. */
  opensAt?: string;
  /** ISO; absent = open until the season starts. */
  closesAt?: string;
  approval: ApprovalMode;
  waitlist: boolean;
  allowExistingTeams: boolean;
  allowMidSeason: boolean;
  /** Entry fee text shown at registration (no payment processing, Q17). */
  entryFee: string;
  /** Payment links (src/payments/links.ts), next to the entry fee: "" = none here, absent = the league default. */
  payPal?: string;
  venmo?: string;
}

/** The owner's accepted defaults for the window fields (core defaultRegistrationWindow("league")). */
export const SEASON_WINDOW_DEFAULTS = { approval: "organiser" as ApprovalMode, waitlist: true, allowExistingTeams: false, allowMidSeason: false, entryFee: "" };

/** A new season's settings: the league's Registrations settings plus the window defaults. */
export function defaultSeasonRegistration(league: Pick<LeagueRecord, "registrations">): SeasonRegistration {
  return { ...structuredClone(registrationsOf(league)), ...SEASON_WINDOW_DEFAULTS };
}

/** The season's effective settings: its own, else the league's current ones, over the defaults. */
export function seasonRegistrationOf(league: Pick<LeagueRecord, "registrations">, season: Pick<SeasonRecord, "registration"> | undefined): SeasonRegistration {
  const base = defaultSeasonRegistration(league);
  const own = season?.registration;
  if (!own) return base;
  const out: SeasonRegistration = {
    ...base,
    ...own,
    allowedRosters: { ...DEFAULT_REGISTRATIONS.allowedRosters, ...(own.allowedRosters ?? base.allowedRosters) },
  };
  if (out.approval !== "auto" && out.approval !== "organiser") out.approval = base.approval;
  for (const k of ["waitlist", "allowExistingTeams", "allowMidSeason", "allowRegistration"] as const) if (typeof out[k] !== "boolean") out[k] = base[k];
  if (typeof out.entryFee !== "string") out.entryFee = "";
  // A stored link that is not (or no longer) valid is dropped from the read; "" (cleared for this season) stays.
  if (typeof out.payPal !== "string" || (out.payPal && normalisePayPal(out.payPal).ok !== true)) delete out.payPal;
  if (typeof out.venmo !== "string" || (out.venmo && !venmoUrl(out.venmo))) delete out.venmo;
  return out;
}

/** Validated payment link fields of a body into the season's settings ("" = cleared for this season). */
function applyPayFields(r: Record<string, unknown>, next: SeasonRegistration): void {
  for (const kind of ["payPal", "venmo"] as const) {
    const checked = parsePayField(kind, r[kind]);
    if (!checked) continue;
    if (!checked.ok) throw new SettingsError(400, checked.error, kind);
    next[kind] = checked.value;
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export const ENTRY_FEE_MAX = 200;
/** Window dates: 2000-01-01 to 2100-01-01 (anything else is a typo). */
const MIN_T = Date.UTC(2000, 0, 1);
const MAX_T = Date.UTC(2100, 0, 1);

function isoOrClear(v: unknown, field: string, label: string): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw new SettingsError(400, `${label} must be a date and time.`, field);
  const t = Date.parse(v);
  if (Number.isNaN(t) || t < MIN_T || t > MAX_T) throw new SettingsError(400, `${label} must be a date and time.`, field);
  return new Date(t).toISOString();
}

const boolField = (v: unknown, field: string): boolean => {
  if (typeof v !== "boolean") throw new SettingsError(400, `${field} must be true or false.`, field);
  return v;
};

/**
 * Validates a season registration patch over `prior`. The shared fields (allowed rosters, Allow registration, max teams,
 * max per race) go through the Registrations tab's own parser (settings.ts parseRegistrations), so the wizard, the
 * league defaults and the season settings refuse the same things with the same words.
 */
export function parseSeasonRegistration(raw: unknown, prior: SeasonRegistration): SeasonRegistration {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SettingsError(400, "registration must be an object.", "registration");
  const r = raw as Record<string, unknown>;
  const shared = parseRegistrations(
    { allowedRosters: r.allowedRosters, allowRegistration: r.allowRegistration, maxRegistrations: r.maxRegistrations, maxPerRace: r.maxPerRace },
    { allowedRosters: prior.allowedRosters, allowRegistration: prior.allowRegistration, maxRegistrations: prior.maxRegistrations, maxPerRace: prior.maxPerRace },
  );
  const next: SeasonRegistration = { ...structuredClone(prior), ...shared };
  for (const [k, label] of [["opensAt", "Registration opens"], ["closesAt", "Registration closes"]] as const) {
    if (r[k] === undefined) continue;
    const v = isoOrClear(r[k], k, label);
    if (v === null) delete next[k]; else next[k] = v;
  }
  if (next.opensAt && next.closesAt && Date.parse(next.closesAt) <= Date.parse(next.opensAt))
    throw new SettingsError(400, "Registration must close after it opens.", "closesAt");
  if (r.approval !== undefined) {
    if (r.approval !== "auto" && r.approval !== "organiser") throw new SettingsError(400, "Approval must be organiser approval or auto-accept.", "approval");
    next.approval = r.approval;
  }
  for (const k of ["waitlist", "allowExistingTeams", "allowMidSeason"] as const) if (r[k] !== undefined) next[k] = boolField(r[k], k);
  if (r.entryFee !== undefined) {
    if (r.entryFee !== null && typeof r.entryFee !== "string") throw new SettingsError(400, "Entry fee must be text.", "entryFee");
    const fee = String(r.entryFee ?? "").replace(CONTROL, "").trim();
    if (fee.length > ENTRY_FEE_MAX) throw new SettingsError(400, `Entry fee must be at most ${ENTRY_FEE_MAX} characters.`, "entryFee");
    next.entryFee = fee;
  }
  applyPayFields(r, next);
  return next;
}

/** The season's settings as the core's window (max teams = cap, max per race = perRace). */
export function seasonWindow(reg: SeasonRegistration): RegistrationWindow {
  return {
    ...(reg.opensAt ? { opensAt: reg.opensAt } : {}),
    ...(reg.closesAt ? { closesAt: reg.closesAt } : {}),
    cap: normalizeCap(reg.maxRegistrations),
    perRace: normalizeCap(reg.maxPerRace),
    approval: reg.approval,
    waitlist: reg.waitlist,
    allowExistingTeams: reg.allowExistingTeams,
    allowMidSeason: reg.allowMidSeason,
  };
}

/** The core's view of one league season (the league adapter L6 builds on this). */
export function seasonSnapshot(league: LeagueRecord, season: SeasonRecord): CompetitionSnapshot {
  const owner = leagueOwner(league);
  return {
    kind: "league",
    id: `${league.id}/${season.id}`,
    name: `${league.name} ${season.name}`,
    published: !isDraftLeague(league),
    finished: season.status === "completed",
    started: seasonStage(season) === "active",
    locked: false,
    test: league.test === true,
    window: seasonWindow(seasonRegistrationOf(league, season)),
    managers: [...new Set([...(owner ? [owner] : []), ...league.organisers])],
  };
}

/** "Thu 5 Nov 2026, 19:00 (Europe London)": a gate's opening in the league zone. */
export function gateWhen(iso: string, zone: string): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return `${g("weekday")} ${g("day")} ${g("month")} ${g("year")}, ${g("hour")}:${g("minute")} (${zone.replace(/_/g, " ")})`;
}

const NOT_OPEN: WindowStatus = { open: false, reason: "not-yet-open", message: "Registration is not open yet." };

/**
 * Is self-registration open for this season now? The core decides published / finished / started / the dates; on top of
 * it a season in setup, or one whose organisers turned Allow registration off, is not open yet.
 */
export function seasonWindowStatus(league: LeagueRecord, season: SeasonRecord, now: Date): WindowStatus {
  const core = windowStatus(seasonSnapshot(league, season), now);
  if (!core.open) return core;
  // The Registration gate (gates.ts) while shut: joins are refused until it opens, whatever the window's own dates say.
  const gate = season.gates?.registration;
  if (gate && (!gate.opensAt || now.getTime() < Date.parse(gate.opensAt))) return { open: false, reason: "not-yet-open", message: gate.opensAt ? `Registration opens ${gateWhen(gate.opensAt, leagueTimeZone(league))}.` : "Registration opens when the organisers open it." };
  if (seasonStage(season) === "setup" || !seasonRegistrationOf(league, season).allowRegistration) return NOT_OPEN;
  return core;
}

/** What organisers may still do (add or decide entries) while self-registration is closed: until play starts. */
export function seasonOrganiserWindow(league: LeagueRecord, season: SeasonRecord): WindowStatus {
  return organiserMayAdd(seasonSnapshot(league, season));
}
