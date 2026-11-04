// League creation wizard (/app/leagues/new, registration spec 11-02 §4 (b), lane L5; creation wizards v2): five steps,
// General -> Rules (+ house rules) -> Season 1 -> Connections (Discord only) -> Review. The first step keeps its id
// "identity" (the draft's saved step numbers never changed). A controller over POST /api/leagues (the first Next makes the DRAFT league) and
// PATCH /api/leagues/:id/draft (every later Next saves its step), plus the pure helpers the step components use. The
// server validates with the League settings parsers, so the messages here only mirror what it will say. No DOM.

import { browserTimeZone } from "../shared/timeZone";
import { reactive, toRaw, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import { normalisePayPal, normaliseVenmo, payPalProblem, venmoProblem } from "../shared/payLinks";
import type { Fetcher } from "../session";
import { fetchUpload, type RawUploader } from "./league";
import { isWebhookUrl, teamBuildingError } from "./settings";
import type { LeagueAddress, TeamBuildingRosterRule } from "./types";
import {
  cardKey, defaultHouseRules, FormatError, houseRulesRows, HouseRulesError, parseHouseRules, parseRegions, rulesetLabel, type HouseRules,
  type PackageListItem, type RulesetCard,
} from "../shared/competition";

export type WizardStepId = "identity" | "rules" | "season" | "connections" | "review";
export const WIZARD_STEPS: ReadonlyArray<{ id: WizardStepId; n: number; label: string }> = [
  { id: "identity", n: 1, label: "General" },
  { id: "rules", n: 2, label: "Rules" },
  { id: "season", n: 3, label: "Season 1" },
  { id: "connections", n: 4, label: "Connections" },
  { id: "review", n: 5, label: "Review" },
];
export const stepIndex = (id: WizardStepId): number => WIZARD_STEPS.findIndex((s) => s.id === id);
export const isWizardStep = (v: unknown): v is WizardStepId => typeof v === "string" && WIZARD_STEPS.some((s) => s.id === v);

/** The server's wizard read model (src/leagues/wizard.ts wizardView). */
export interface WizardDraft {
  id: string;
  revision: number;
  visibility: "draft" | "published";
  step: number;
  completedAt?: string;
  test: boolean;
  identity: { name: string; fullName: string; slug: string; description: string; address: LeagueAddress | null; logoUrl?: string; bannerUrl?: string; playOnFork?: boolean; timeZone?: string | null };
  rules: {
    ruleset: "BB2020" | "BB2025";
    rulesetPackage?: string | null;
    houseRules?: HouseRules;
    allowedRosters: { official: boolean; nafApproved: boolean; unofficial: boolean };
    maxRegistrations: number | null;
    maxPerRace: number | null;
    teamBuilding: { rosters: TeamBuildingRosterRule[]; eliteSkills: string[] };
  };
  season: {
    id: string; name: string; number: number; startedAt?: string; stage: string; divisions: string[]; playoffs: boolean; revision: number;
    registration: {
      opensAt?: string; closesAt?: string; opensAtWall?: string; closesAtWall?: string;
      approval: "auto" | "organiser"; waitlist: boolean; allowExistingTeams: boolean; allowMidSeason: boolean; entryFee: string;
      payPal?: string; venmo?: string;
    };
    regions?: string[];
  } | null;
  connections: { playOnFork: boolean; discord: { configured: boolean; maskedUrl: string; events: Record<string, boolean> } };
}

export const DISCORD_EVENTS = ["news", "fixtureCreated", "matchStarted", "matchResult", "milestones"] as const;

export interface WizardForm {
  identity: {
    name: string; fullName: string; slug: string; slugEdited: boolean; description: string;
    /** Played on (a General setting since creation wizards v2): true = Super FUMBBL, false = tabletop. */
    playOnFork: boolean;
    /** IANA time zone (owner 11-02): the organiser's browser zone until changed. */
    timeZone: string;
  };
  rules: {
    ruleset: "BB2020" | "BB2025"; official: boolean; nafApproved: boolean; unofficial: boolean; maxRegistrations: string; maxPerRace: string; rosters: TeamBuildingRosterRule[];
    /** The ruleset card: a saved package name, "" = the plain base ruleset. */
    rulesetPackage: string;
    houseRules: HouseRules;
  };
  season: {
    name: string; startsAt: string; divisions: string[]; playoffs: boolean; opensAt: string; closesAt: string;
    approval: "auto" | "organiser"; waitlist: boolean; allowExistingTeams: boolean; allowMidSeason: boolean; entryFee: string;
    /** Payment links (optional): a PayPal.Me link and a Venmo username. */
    payPal: string; venmo: string;
    /** The organiser's regions (one per line in the form; blank lines dropped on save). */
    regions: string[];
  };
  /** Discord only (Played on moved to General). */
  connections: { webhook: string; clearWebhook: boolean; events: Record<string, boolean> };
}

export const NAME_MAX = 40;
export const FULL_NAME_MAX = 120;
export const DESCRIPTION_MAX = 2000;
export const ENTRY_FEE_MAX = 200;
export const RESERVED_IDS = ["new", "create", "import", "settings", "api"];
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A league address from its name ("Tahoma Area BBL" -> "tahoma-area-bbl"); the server derives the same. */
export function slugify(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
}

export function emptyForm(): WizardForm {
  return {
    identity: { name: "", fullName: "", slug: "", slugEdited: false, description: "", playOnFork: false, timeZone: browserTimeZone() },
    rules: {
      ruleset: "BB2025", official: true, nafApproved: true, unofficial: false, maxRegistrations: "", maxPerRace: "", rosters: [],
      rulesetPackage: "", houseRules: defaultHouseRules("league"),
    },
    season: {
      name: "Season 1", startsAt: "", divisions: [], playoffs: false, opensAt: "", closesAt: "",
      approval: "organiser", waitlist: true, allowExistingTeams: false, allowMidSeason: false, entryFee: "", payPal: "", venmo: "", regions: [],
    },
    connections: { webhook: "", clearWebhook: false, events: { news: true, fixtureCreated: true, matchStarted: true, matchResult: true, milestones: true } },
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** ISO -> the value of a datetime-local input, in the viewer's time zone ("" when unset or bad). */
export function toLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** A datetime-local value (viewer's time zone) -> ISO; "" -> null (cleared). */
export function fromLocalInput(v: string): string | null {
  if (!v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** A datetime-local value as a wall-clock time ("2026-11-05T19:00"), or null when empty or malformed. */
export const wallValue = (v: string): string | null => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v.trim()) ? v.trim().slice(0, 16) : null);

/** The season start date: a calendar day, stored at noon UTC so every time zone shows the same day. */
export const startDateIso = (day: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T12:00:00.000Z` : null);
export const isoDay = (iso: string | undefined): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "");

/** The form a saved draft fills in (a resumed draft opens where it was left). */
export function formFromDraft(d: WizardDraft): WizardForm {
  const f = emptyForm();
  // Older servers sent Played on under connections only.
  const played = d.identity.playOnFork ?? d.connections.playOnFork;
  f.identity = { name: d.identity.name, fullName: d.identity.fullName, slug: d.identity.slug, slugEdited: true, description: d.identity.description, playOnFork: played === true, timeZone: d.identity.timeZone || browserTimeZone() };
  f.rules = {
    ruleset: d.rules.ruleset, ...d.rules.allowedRosters,
    maxRegistrations: d.rules.maxRegistrations === null ? "" : String(d.rules.maxRegistrations),
    maxPerRace: d.rules.maxPerRace === null ? "" : String(d.rules.maxPerRace),
    rosters: structuredClone(d.rules.teamBuilding.rosters),
    rulesetPackage: d.rules.rulesetPackage ?? "",
    houseRules: d.rules.houseRules ? structuredClone(d.rules.houseRules) : defaultHouseRules("league"),
  };
  if (d.season) {
    const r = d.season.registration;
    f.season = {
      name: d.season.name, startsAt: isoDay(d.season.startedAt), divisions: [...d.season.divisions], playoffs: d.season.playoffs,
      // Wall times in the league's zone (the server sends them; the step labels the zone).
      opensAt: r.opensAtWall ?? "", closesAt: r.closesAtWall ?? "", approval: r.approval, waitlist: r.waitlist,
      allowExistingTeams: r.allowExistingTeams, allowMidSeason: r.allowMidSeason, entryFee: r.entryFee,
      payPal: r.payPal ?? "", venmo: r.venmo ?? "", regions: [...(d.season.regions ?? [])],
    };
  }
  f.connections = { webhook: "", clearWebhook: false, events: { ...d.connections.discord.events } };
  return f;
}

const limit = (v: string, max: number): number | null | "bad" => {
  const t = String(v).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : "bad";
};

export type StepErrors = Record<string, string>;

export function identityErrors(f: WizardForm, created: boolean): StepErrors {
  const i = f.identity;
  const e: StepErrors = {};
  if (!i.name.trim()) e.name = "Name is required.";
  else if (i.name.trim().length > NAME_MAX) e.name = `Name must be at most ${NAME_MAX} characters.`;
  if (i.fullName.trim().length > FULL_NAME_MAX) e.fullName = `Full name must be at most ${FULL_NAME_MAX} characters.`;
  if (i.description.trim().length > DESCRIPTION_MAX) e.description = `Description must be at most ${DESCRIPTION_MAX} characters.`;
  if (!created) {
    const slug = i.slug.trim() || slugify(i.name);
    if (!slug || !SLUG.test(slug)) e.slug = "Lower-case letters, digits and dashes (at most 64), starting with a letter or digit.";
    else if (RESERVED_IDS.includes(slug)) e.slug = `"${slug}" is reserved. Pick another league address.`;
  }
  return e;
}

export function rulesErrors(f: WizardForm): StepErrors {
  const r = f.rules;
  const e: StepErrors = {};
  if (!r.official && !r.nafApproved && !r.unofficial) e.rosters = "Allow at least one kind of roster.";
  const maxReg = limit(r.maxRegistrations, 512);
  const maxRace = limit(r.maxPerRace, 64);
  if (maxReg === "bad") e.maxRegistrations = "1 to 512, or blank for no limit.";
  if (maxRace === "bad") e.maxPerRace = "1 to 64, or blank for no limit.";
  else if (typeof maxRace === "number" && typeof maxReg === "number" && maxRace > maxReg) e.maxPerRace = "Cannot be more than max teams.";
  const tb = teamBuildingError(r.rosters);
  if (tb) e.teamBuilding = tb;
  try { parseHouseRules(r.houseRules, "league"); } catch (err) { if (err instanceof HouseRulesError) e.houseRules = err.message; }
  return e;
}

export function seasonErrors(f: WizardForm): StepErrors {
  const s = f.season;
  const e: StepErrors = {};
  if (!s.name.trim() || s.name.trim().length > 60) e.name = "Season name must be 1 to 60 characters.";
  if (s.startsAt && !startDateIso(s.startsAt)) e.startsAt = "Pick a date.";
  const names = s.divisions.map((d) => d.trim()).filter(Boolean);
  if (names.length > 16) e.divisions = "At most 16 divisions.";
  else if (names.some((n) => n.length > 40)) e.divisions = "Division names must be at most 40 characters.";
  else if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) e.divisions = "Each division needs its own name.";
  // Both are wall times in the league's zone: they compare as text.
  if (wallValue(s.opensAt) && wallValue(s.closesAt) && wallValue(s.closesAt)! <= wallValue(s.opensAt)!) e.closesAt = "Registration must close after it opens.";
  if (s.entryFee.trim().length > ENTRY_FEE_MAX) e.entryFee = `Entry fee must be at most ${ENTRY_FEE_MAX} characters.`;
  const payPal = payPalProblem(s.payPal);
  if (payPal) e.payPal = payPal;
  const venmo = venmoProblem(s.venmo);
  if (venmo) e.venmo = venmo;
  try { parseRegions(s.regions); } catch (err) { if (err instanceof FormatError) e.regions = err.message; }
  return e;
}

export function connectionsErrors(f: WizardForm): StepErrors {
  const w = f.connections.webhook.trim();
  return w && !isWebhookUrl(w) ? { webhook: "That is not a Discord webhook URL (https://discord.com/api/webhooks/...)." } : {};
}

export function stepErrors(step: WizardStepId, f: WizardForm, created: boolean): StepErrors {
  if (step === "identity") return identityErrors(f, created);
  if (step === "rules") return rulesErrors(f);
  if (step === "season") return seasonErrors(f);
  if (step === "connections") return connectionsErrors(f);
  return {};
}

/** The PATCH /draft section a step saves (the identity also goes to POST /api/leagues on the first Next). */
export function stepPayload(step: WizardStepId, f: WizardForm): Record<string, unknown> {
  if (step === "identity") {
    const i = f.identity;
    return { identity: { name: i.name.trim(), fullName: i.fullName.trim(), description: i.description.trim(), playOnFork: i.playOnFork, timeZone: i.timeZone } };
  }
  if (step === "rules") {
    const r = f.rules;
    const n = (v: string) => { const x = limit(v, 512); return typeof x === "number" ? x : null; };
    return { rules: {
      // A package card is a BB2025 pack: the base ruleset follows it.
      ruleset: r.rulesetPackage ? "BB2025" : r.ruleset, rulesetPackage: r.rulesetPackage || null, houseRules: structuredClone(toRaw(r.houseRules)),
      allowedRosters: { official: r.official, nafApproved: r.nafApproved, unofficial: r.unofficial },
      maxRegistrations: n(r.maxRegistrations), maxPerRace: n(r.maxPerRace),
      ...(r.rosters.length ? { teamBuilding: { rosters: r.rosters } } : {}),
    } };
  }
  if (step === "season") {
    const s = f.season;
    return { season: {
      name: s.name.trim(), startsAt: startDateIso(s.startsAt), divisions: s.divisions.map((d) => d.trim()).filter(Boolean), playoffs: s.playoffs,
      regions: s.regions.map((x) => x.trim()).filter(Boolean),
      registration: {
        opensAtWall: wallValue(s.opensAt), closesAtWall: wallValue(s.closesAt), approval: s.approval, waitlist: s.waitlist,
        allowExistingTeams: s.allowExistingTeams, allowMidSeason: s.allowMidSeason, entryFee: s.entryFee.trim(),
        payPal: (() => { const p = normalisePayPal(s.payPal); return p.ok ? p.value : s.payPal.trim(); })(),
        venmo: (() => { const v = normaliseVenmo(s.venmo); return v.ok ? v.value : s.venmo.trim(); })(),
      },
    } };
  }
  if (step === "connections") {
    const c = f.connections;
    const url = c.clearWebhook ? null : c.webhook.trim() || undefined;
    return { connections: { discord: { ...(url !== undefined ? { url } : {}), events: { ...c.events } } } };
  }
  return {};
}

const yes = (b: boolean): string => (b ? "Yes" : "No");
/** A wall-clock time in the league's zone, shown as typed ("2026-11-05 19:00"). */
const when = (local: string): string => (wallValue(local) ? wallValue(local)!.replace("T", " ") : "");

export interface SummaryGroup { step: WizardStepId; title: string; rows: Array<{ k: string; v: string }> }

/** The LEAGUE SUMMARY side panel and the Review step: every choice so far, grouped by step. */
export function summaryGroups(f: WizardForm, draft: WizardDraft | null): SummaryGroup[] {
  const i = f.identity;
  const r = f.rules;
  const s = f.season;
  const c = f.connections;
  const rosters = [r.official && "Official", r.nafApproved && "NAF-approved", r.unofficial && "Unofficial"].filter(Boolean).join(", ") || "None";
  const changed = r.rosters.filter((x) => x.treasury !== 1000 || x.startingSkills.primary || x.startingSkills.secondary || x.startingSkills.elite).length;
  const divisions = s.divisions.map((d) => d.trim()).filter(Boolean);
  const zone = (i.timeZone || "UTC").replace(/_/g, " ");
  const window = s.opensAt || s.closesAt ? `${when(s.opensAt) || "When opened"} to ${when(s.closesAt) || "season start"} (${zone})` : "Opens when you open it";
  const discord = c.clearWebhook ? "Removed" : c.webhook.trim() ? "New webhook" : draft?.connections.discord.configured ? "Connected" : "Not set";
  const regions = s.regions.map((x) => x.trim()).filter(Boolean);
  return [
    { step: "identity", title: "General", rows: [
      { k: "Name", v: i.name.trim() || "-" },
      ...(i.fullName.trim() ? [{ k: "Full name", v: i.fullName.trim() }] : []),
      { k: "Address", v: `/leagues/${draft?.id ?? (i.slug.trim() || slugify(i.name) || "...")}` },
      { k: "Played on", v: i.playOnFork ? "Super FUMBBL" : "Tabletop" },
      { k: "Time zone", v: i.timeZone || "UTC" },
    ] },
    { step: "rules", title: "Rules", rows: [
      { k: "Ruleset", v: rulesetLabel(r.rulesetPackage, r.ruleset) },
      { k: "Rosters", v: rosters },
      { k: "Max teams", v: r.maxRegistrations.trim() || "No limit" },
      { k: "Max per race", v: r.maxPerRace.trim() || "No limit" },
      { k: "Team building", v: changed ? `${changed} roster${changed === 1 ? "" : "s"} changed` : "Defaults" },
      { k: "Inducements", v: "Standard table" },
      ...houseRulesRows(r.houseRules, "league"),
    ] },
    { step: "season", title: s.name.trim() || "Season 1", rows: [
      ...(s.startsAt ? [{ k: "Starts", v: s.startsAt }] : []),
      { k: "Phases", v: s.playoffs ? "Regular, Play-offs" : "Regular" },
      { k: "Divisions", v: divisions.length ? divisions.join(", ") : "One" },
      { k: "Registration", v: window },
      { k: "Approval", v: s.approval === "organiser" ? "Organiser approval" : "Auto-accept" },
      { k: "Waitlist", v: yes(s.waitlist) },
      { k: "Existing teams", v: yes(s.allowExistingTeams) },
      { k: "Join mid-season", v: yes(s.allowMidSeason) },
      ...(s.entryFee.trim() ? [{ k: "Entry fee", v: s.entryFee.trim() }] : []),
      ...(s.payPal.trim() ? [{ k: "PayPal", v: normalisePayPal(s.payPal).ok ? "Link set" : "Check the link" }] : []),
      ...(s.venmo.trim() ? [{ k: "Venmo", v: `@${s.venmo.trim().replace(/^@/, "")}` }] : []),
      ...(regions.length ? [{ k: "Regions", v: regions.join(", ") }] : []),
    ] },
    { step: "connections", title: "Connections", rows: [
      { k: "Discord", v: discord },
    ] },
  ];
}

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

export interface WizardState {
  step: WizardStepId;
  form: WizardForm;
  draft: WizardDraft | null;
  /** Steps saved at least once (the step tabs ahead of the furthest one stay locked). */
  reached: number;
  busy: string;
  error: string;
  notice: string;
  /** Field errors shown after a Next was refused (server errors land on their field when it names one). */
  errors: StepErrors;
  loaded: boolean;
  logo: File | null;
  banner: File | null;
  /** The ruleset cards (GET /api/packages). */
  packages: PackageListItem[];
  packagesStatus: "idle" | "loading" | "ready" | "error";
}

/** "Create a new ruleset" keeps the Rules step's unsaved edits for this tab (sessionStorage, per draft league): a
 *  per-viewer convenience, read and written inside try/catch, removed once restored. */
export const RULES_STASH_KEY = "sf.leagueWizardRules";
const stashKey = (draftId: string): string => `${RULES_STASH_KEY}:${draftId}`;
function writeStash(draftId: string, rules: WizardForm["rules"]): void {
  try { if (typeof sessionStorage !== "undefined") sessionStorage.setItem(stashKey(draftId), JSON.stringify(rules)); } catch { /* no storage */ }
}
/** The stashed Rules form for a draft (removed as it is read), or undefined when none or unreadable. */
function takeStash(draftId: string): WizardForm["rules"] | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    const raw = sessionStorage.getItem(stashKey(draftId));
    if (raw === null) return undefined;
    sessionStorage.removeItem(stashKey(draftId));
    const v = JSON.parse(raw) as Partial<WizardForm["rules"]>;
    const f = emptyForm().rules;
    if (!v || typeof v !== "object") return undefined;
    return {
      ruleset: v.ruleset === "BB2020" ? "BB2020" : "BB2025",
      official: v.official !== false, nafApproved: v.nafApproved !== false, unofficial: v.unofficial === true,
      maxRegistrations: limitText(v.maxRegistrations, f.maxRegistrations),
      maxPerRace: limitText(v.maxPerRace, f.maxPerRace),
      rosters: Array.isArray(v.rosters) ? v.rosters as TeamBuildingRosterRule[] : f.rosters,
      rulesetPackage: typeof v.rulesetPackage === "string" ? v.rulesetPackage : "",
      houseRules: restoreHouseRules(v.houseRules),
    };
  } catch { return undefined; }
}

/** A stashed limit: the number inputs give numbers (or "" when blank); numeric strings are kept too. */
function limitText(v: unknown, fallback: string): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && (v.trim() === "" || Number.isFinite(Number(v.trim())))) return v.trim();
  return fallback;
}

/**
 * Stashed house rules restored field by field: each valid field is kept, a bad one falls back to the ruleset's, and the
 * rest are never wiped. "Cost change" with the cost cleared comes back as "Cost change" with no cost, so the step's own
 * check (rulesErrors) flags it instead of the edit being lost.
 */
function restoreHouseRules(raw: unknown): HouseRules {
  const out = defaultHouseRules("league");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const key of ["prayers", "brawlingBrutes", "maxStatIncreasesTeam", "maxStatIncreasesPlayer", "mvp", "hireFire"] as const) {
    if (r[key] === undefined) continue;
    try {
      Object.assign(out, { [key]: parseHouseRules({ [key]: r[key] }, "league")[key] });
    } catch {
      const p = r.prayers as { mode?: unknown } | undefined;
      if (key === "prayers" && p && p.mode === "cost") out.prayers = { mode: "cost" };
    }
  }
  return out;
}

/** The league's extra card: the BB2020 base ruleset (leagues only). */
export const BB2020_CARD: RulesetCard = { packageName: "", ruleset: "BB2020", label: "BB2020", line: "The 2020 edition." };
/** The picked card's key (RulesetCardPicker `selected`). */
export const selectedCardKey = (r: Pick<WizardForm["rules"], "rulesetPackage" | "ruleset">): string => cardKey({ packageName: r.rulesetPackage, ruleset: r.ruleset });

export function createLeagueWizard(deps: { api: Fetcher; upload?: RawUploader }) {
  const state = reactive<WizardState>({
    step: "identity", form: emptyForm(), draft: null, reached: 0, busy: "", error: "", notice: "", errors: {}, loaded: false, logo: null, banner: null,
    packages: [], packagesStatus: "idle",
  });
  const base = (): string => `/api/leagues/${encodeURIComponent(state.draft!.id)}`;

  function take(d: WizardDraft, refill = false): void {
    state.draft = d;
    state.reached = Math.max(state.reached, Math.min(WIZARD_STEPS.length, d.step) - 1);
    if (refill) state.form = formFromDraft(d);
    else if (!state.form.rules.rosters.length) state.form.rules.rosters = structuredClone(d.rules.teamBuilding.rosters);
  }

  /** A fresh wizard, or a draft picked back up (?draft=<id>). */
  async function start(draftId?: string, opts: { packageName?: string } = {}): Promise<void> {
    state.error = "";
    state.loaded = false;
    try {
      if (draftId) {
        const d = (await deps.api<{ draft: WizardDraft }>(`/api/leagues/${encodeURIComponent(draftId)}/draft`)).draft;
        take(d, true);
        state.step = WIZARD_STEPS[Math.min(WIZARD_STEPS.length, Math.max(1, d.step)) - 1]!.id;
        // Back from "Create a new ruleset": the Rules step's unsaved edits come back first, then the new ruleset is picked.
        const stashed = takeStash(d.id);
        if (stashed) {
          state.form.rules = { ...stashed, rosters: stashed.rosters.length ? stashed.rosters : state.form.rules.rosters };
          state.step = "rules";
        }
        if (opts.packageName) { state.form.rules.rulesetPackage = opts.packageName; state.form.rules.ruleset = "BB2025"; state.step = "rules"; }
      } else {
        state.form = emptyForm();
        state.draft = null;
        state.reached = 0;
        state.step = "identity";
      }
    } catch (err) {
      state.error = err instanceof ApiError && err.status === 404 ? "That draft league was not found." : errorText(err, "Can't load the draft league.");
    } finally {
      state.loaded = true;
    }
  }

  async function uploads(): Promise<void> {
    for (const kind of ["logo", "banner"] as const) {
      const file = state[kind];
      if (!file) continue;
      await (deps.upload ?? fetchUpload)(`${base()}/${kind}`, file);
      state[kind] = null;
    }
    if (state.draft) take((await deps.api<{ draft: WizardDraft }>(`${base()}/draft`)).draft);
  }

  function refuse(err: unknown): void {
    const data = err instanceof ApiError ? (err.data as { field?: string } | undefined) : undefined;
    const msg = errorText(err, "That did not save.");
    if (data?.field) state.errors = { ...state.errors, [data.field.replace(/^(identity|rules|season|connections)\./, "")]: msg };
    state.error = msg;
  }

  async function loadPackages(): Promise<void> {
    state.packagesStatus = "loading";
    try {
      const list = await deps.api<unknown>("/api/packages");
      state.packages = (Array.isArray(list) ? list : [])
        .filter((e): e is { name: string; description?: unknown; format?: unknown } => Boolean(e) && typeof e === "object" && typeof (e as { name?: unknown }).name === "string")
        .map((e) => ({ name: e.name, ...(typeof e.description === "string" && e.description ? { description: e.description } : {}), ...(typeof e.format === "string" ? { format: e.format } : {}) }));
      state.packagesStatus = "ready";
    } catch {
      state.packagesStatus = state.packages.length ? "ready" : "error";
    }
  }

  /** The first step (before Review) with a problem, checked as its Next would. */
  function firstProblem(): WizardStepId | undefined {
    for (const s of WIZARD_STEPS) {
      if (s.id === "review") break;
      if (Object.keys(stepErrors(s.id, state.form, Boolean(state.draft))).length) return s.id;
    }
    return undefined;
  }

  /** Saves the current step (creating the draft on the first one); false when it was refused. */
  async function saveStep(extra: Record<string, unknown> = {}): Promise<boolean> {
    const step = state.step;
    state.errors = stepErrors(step, state.form, Boolean(state.draft));
    state.error = "";
    state.notice = "";
    if (Object.keys(state.errors).length) { state.error = "Check the highlighted fields."; return false; }
    state.busy = step;
    try {
      const nextN = Math.min(WIZARD_STEPS.length, stepIndex(step) + 2);
      if (!state.draft) {
        const i = state.form.identity;
        const res = await deps.api<{ draft: WizardDraft }>("/api/leagues", { method: "POST", body: {
          ...(stepPayload("identity", state.form).identity as Record<string, unknown>), slug: i.slug.trim() || slugify(i.name),
        } });
        take(res.draft);
      } else if (step !== "review" || Object.keys(extra).length) {
        const res = await deps.api<{ draft: WizardDraft }>(`${base()}/draft`, { method: "PATCH", body: {
          revision: state.draft.revision, step: nextN, ...stepPayload(step, state.form), ...extra,
        } });
        take(res.draft);
      }
      if (step === "identity") await uploads();
      if (step === "connections") { state.form.connections.webhook = ""; state.form.connections.clearWebhook = false; }
      state.reached = Math.max(state.reached, nextN - 1);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && state.draft && /changed since/.test(err.message)) {
        await start(state.draft.id);
        state.error = "This draft changed in another window, so it was reloaded. Check it and continue.";
      } else refuse(err);
      return false;
    } finally {
      state.busy = "";
    }
  }

  return {
    state,
    start,
    /** Save this step, then open the next one. */
    async next(): Promise<boolean> {
      if (!(await saveStep())) return false;
      const i = stepIndex(state.step);
      if (i < WIZARD_STEPS.length - 1) state.step = WIZARD_STEPS[i + 1]!.id;
      return true;
    },
    back(): void { const i = stepIndex(state.step); if (i > 0) { state.step = WIZARD_STEPS[i - 1]!.id; state.error = ""; state.errors = {}; } },
    /** Jump to a step already reached (the step tabs and the Review's Edit links). */
    go(id: WizardStepId): void {
      if (stepIndex(id) <= state.reached || id === state.step) { state.step = id; state.error = ""; state.errors = {}; }
    },
    canGo: (id: WizardStepId): boolean => stepIndex(id) <= state.reached || id === state.step,
    /** "Save as template" on the Season step: saves the step first (the template is captured from the saved draft season),
     *  then answers the league and season to capture; undefined when the step was refused. */
    async saveForTemplate(): Promise<{ leagueId: string; seasonId: string } | undefined> {
      if (!(await saveStep())) return undefined;
      const seasonId = state.draft?.season?.id;
      return state.draft && seasonId ? { leagueId: state.draft.id, seasonId } : undefined;
    },
    loadPackages,
    /** Keep the Rules step's unsaved edits before leaving for the Tournament Creator ("Create a new ruleset"). */
    stashRules(): void { if (state.draft) writeStash(state.draft.id, JSON.parse(JSON.stringify(state.form.rules)) as WizardForm["rules"]); },
    /** Pick a ruleset card ("" package = a plain base ruleset). */
    pickRuleset(card: RulesetCard): void {
      state.form.rules.rulesetPackage = card.packageName;
      state.form.rules.ruleset = card.packageName ? "BB2025" : card.ruleset ?? "BB2025";
    },
    /**
     * Review: Save as draft (`publish` false) or Publish now (true). Both check the whole form first (the first step with
     * a problem opens with its fields marked) and finish the wizard; Publish now then publishes the league.
     * PAYMENT SLOT (owner 11-02: "the review page is where payment would go"): a future charge-at-publish step runs here,
     * before the publish POST. Nothing is charged today.
     */
    async finish(publish: boolean): Promise<boolean> {
      if (!state.draft || state.busy) return false;
      const bad = firstProblem();
      if (bad) {
        state.step = bad;
        state.errors = stepErrors(bad, state.form, true);
        state.error = "Check the highlighted fields.";
        return false;
      }
      if (!(await saveStep({ complete: true }))) return false;
      if (!publish) return true;
      state.busy = "publish";
      try {
        await deps.api(`${base()}/publish`, { method: "POST", body: {} });
        return true;
      } catch (err) {
        state.error = errorText(err, "The league did not publish. It is saved as a draft: publish it from League settings.");
        return false;
      } finally {
        state.busy = "";
      }
    },
    /** The old single finish (kept for callers): save as a draft. */
    async create(): Promise<boolean> { return this.finish(false); },
    testDiscord: async (): Promise<void> => {
      if (!state.draft) return;
      state.busy = "discord-test";
      state.error = "";
      try { await deps.api(`${base()}/discord/test`, { method: "POST", body: {} }); state.notice = "Test post sent. Check the channel."; } catch (err) { state.error = errorText(err, "The test post did not go."); } finally { state.busy = ""; }
    },
    summary: () => summaryGroups(state.form, state.draft),
  };
}
export type LeagueWizard = ReturnType<typeof createLeagueWizard>;
export const LEAGUE_WIZARD_KEY: InjectionKey<LeagueWizard> = Symbol("league-wizard");

export { canCreateLeague } from "./lifecycle";
