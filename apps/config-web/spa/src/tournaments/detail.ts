// Tournament detail controller (/app/tournaments/:id): GET /api/tournaments/:id for Overview / Entrants / Rounds and
// GET /api/tournaments/:id/standings for Standings. Reads are public; fixtures are whatever the server sends
// (anonymous visitors get none). Phase 2/3 add the player actions (register, withdraw, submit a team) and the
// organiser actions (roles, settings, roster lock, start, generate fixtures, participant flags). Every write refetches
// the tournament and shows the server's message on failure; nothing is retried. No DOM; rendered by the views.

import { reactive, type InjectionKey } from "vue";
import { fromZoneInput, localDay, localWhen, toZoneInput } from "../shared/localTime";
import {
  ApiError,
  type BuilderSaveSummary,
  type TournamentDetailResponse,
  type TournamentEntrantFlags,
  type TournamentPairingSystem,
  type TournamentRoundPreview,
  type TournamentSeedingMode,
  type TournamentDeadlines,
  type TournamentActivityEntry,
  type TournamentFixtureEdit,
  type TournamentResultValues,
  type TournamentEntrant,
  type TournamentFixture,
  type TournamentLocation,
  type TournamentNewsPost,
  type TournamentRound,
  type TournamentStandingRow,
  type TournamentSummary,
  type TournamentCheckIn,
  type TournamentMyRegistration,
  type TournamentRegistrationStatus,
  type TournamentRegistrationsResponse,
} from "../shared/api";
import type { Fetcher } from "../session";
import type { ShareField } from "../account/sharing";

export type DetailTab = "overview" | "entrants" | "rounds" | "standings" | "statistics" | "honours" | "awards" | "manage";
export const DETAIL_TABS: ReadonlyArray<{ id: DetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "entrants", label: "Entrants" },
  { id: "rounds", label: "Rounds" },
  { id: "standings", label: "Standings" },
  { id: "statistics", label: "Statistics" },
  { id: "honours", label: "Honours" },
  { id: "awards", label: "Awards" },
];
/** The organiser tab, shown only when the server says the viewer manages this tournament. */
export const MANAGE_TAB: { id: DetailTab; label: string } = { id: "manage", label: "Manage" };
export const isDetailTab = (v: unknown): v is DetailTab => v === "manage" || DETAIL_TABS.some((t) => t.id === v);
export const tabsFor = (manage: boolean): ReadonlyArray<{ id: DetailTab; label: string }> => (manage ? [...DETAIL_TABS, MANAGE_TAB] : DETAIL_TABS);

export interface TournamentDetailState {
  id: string;
  tournament: TournamentSummary | null;
  /** The Tournament Series it belongs to (the front block's chip links to /series/:id). */
  series: { id: string; name: string } | null;
  entrants: TournamentEntrant[];
  rounds: TournamentRound[];
  fixtures: TournamentFixture[];
  /** Organiser result edits the server let this viewer see (newest first). */
  activity: TournamentActivityEntry[];
  standings: TournamentStandingRow[];
  standingsStatus: "idle" | "loading" | "ok" | "error";
  standingsError: string;
  loaded: boolean;
  loading: boolean;
  notFound: boolean;
  error: string;
  capabilities: { manage: boolean; assignRoles: boolean };
  /** The write in flight ("" = none): buttons disable while it runs. */
  busy: string;
  /** The last write's server message (failure) and a short confirmation (success). */
  actionError: string;
  notice: string;
  /** The name of the last write ("register", "page", "banner", "news:<id>"...): panels show only their own messages. */
  lastAction: string;
  /** The signed-in coach's saved teams (Roster Builder saves) for Register / Submit team. Never library teams. */
  teamOptions: { status: "idle" | "loading" | "ok"; saves: BuilderSaveSummary[] };
  /** Generate fixtures preview (organiser), or null. */
  preview: TournamentRoundPreview | null;
  /** The Start Tournament outcome: refused = some roster is not verified (the table shows which). */
  startOutcome: "" | "refused" | "started";
  /** Registration (lane L4): the public facts, the check-in times, and the viewer's own entry in any state. */
  registrationStatus: TournamentRegistrationStatus | null;
  checkIn: TournamentCheckIn | null;
  myRegistration: TournamentMyRegistration | null;
  /** The organisers' Registrations panel (GET .../registrations, managers only). */
  registrations: { status: "idle" | "loading" | "ok" | "error"; data: TournamentRegistrationsResponse | null; error: string };
}

export interface RegistrationExtras { share?: ShareField[]; notNafMember?: boolean }

/** The POST /entrants body: teamId, share (always sent, [] = nothing), notNafMember only when ticked. NAF details are
 *  never typed per entry (owner 10-31): on a NAF-sanctioned tournament the server takes them from the coach's profile. */
export function registrationBody(teamId: string, entry: RegistrationExtras) {
  return { teamId, share: entry.share ?? [], ...(entry.notNafMember ? { notNafMember: true } : {}) };
}

/** The NAF details on the coach's profile, as GET /api/me/sharing reports them. */
export interface ProfileNafView { nafNumber?: string; nafName?: string }

/** The NAF name and number a coach types into the inline "add to your profile" form. */
export interface NafLinkDraft { nafName: string; nafId: string }

const NAF_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;
export const NAF_ADD_PROMPT = "Add your NAF name and number, or tick \"I am not a NAF member\".";

/** The NAF problem with a registration (or NAF answer) form, "" = fine. On a sanctioned tournament the profile's NAF
 *  details or "not a NAF member" settle it; otherwise the inline form must hold a NAF name and number (the server's
 *  link check stays the authority). Not sanctioned: nothing to check. */
export function nafProblem(sanctioned: boolean, profile: ProfileNafView | null | undefined, notNafMember: boolean, draft: NafLinkDraft): string {
  if (!sanctioned || notNafMember || profile?.nafNumber) return "";
  const name = draft.nafName.trim();
  const id = draft.nafId.trim();
  if (!name && !id) return NAF_ADD_PROMPT;
  if (!name) return "Enter your NAF name.";
  if (name.length > 60) return "NAF name must be at most 60 characters.";
  if (!NAF_NAME.test(name)) return "NAF name can use letters, digits, spaces and . _ ' -";
  if (!id) return "Enter your NAF number.";
  if (!/^\d{1,10}$/.test(id)) return "NAF number must be 1 to 10 digits.";
  return "";
}

/** The line a coach with profile NAF details sees on a NAF-sanctioned tournament (owner 10-31: they are told). */
export function nafSharedLine(profile: ProfileNafView): string {
  return profile.nafName
    ? `Your NAF name ${profile.nafName} and number ${profile.nafNumber} will be shared with the organiser.`
    : `Your NAF number ${profile.nafNumber} will be shared with the organiser.`;
}

export const NAF_LINK_PATH = "/api/me/connections/naf";

/** Saves the inline NAF name and number to the coach's profile through the Account NAF link (POST /api/me/connections/naf:
 *  same validation and NAF coach page check as the Account page). Returns the profile's NAF details after the save. */
export async function linkProfileNaf(api: Fetcher, draft: NafLinkDraft): Promise<ProfileNafView> {
  const view = await api<{ nafName?: string; nafId?: string }>(NAF_LINK_PATH, {
    method: "POST", body: { nafName: draft.nafName.trim(), nafId: draft.nafId.trim() },
  });
  return { ...(view.nafId ? { nafNumber: view.nafId } : {}), ...(view.nafName ? { nafName: view.nafName } : {}) };
}

export interface TournamentSettingsPatch {
  startsAt?: string;
  endsAt?: string;
  maxPlayers?: number;
  roundCount?: number;
  pairingSystem?: TournamentPairingSystem;
  seedingMode?: TournamentSeedingMode;
  primaryTiebreaker?: "buchholz" | "sonnebornBerger";
  nafSanctioned?: boolean;
  playOnFork?: boolean;
  /** Creation wizards v2: the tiebreaker chain after points, W/D/L, house rules (merged by the server), avoidance, regions. */
  tiebreakers?: import("../../../src/competition/format").ChainTiebreaker[];
  points?: { win: number; draw: number; loss: number };
  houseRules?: import("../../../src/competition/houseRules").HouseRules;
  pairingAvoid?: import("../../../src/competition/format").PairingAvoid;
  regions?: string[];
  /** Creation wizards v2: a ruleset change, the required change message (registered coaches) and the after-start confirmation. */
  packageName?: string;
  changeMessage?: string;
  confirmAfterStart?: boolean;
  /** Tournament page fields: null clears (location / deadlines replace as a whole). */
  location?: TournamentLocation | null;
  /** Site search region (owner 11-04): a country and free text; null clears. */
  region?: import("../../../src/competition/region").CompetitionRegion | null;
  startTime?: string | null;
  entryFee?: string | null;
  payPal?: string | null;
  venmo?: string | null;
  summary?: string | null;
  notes?: string | null;
  deadlines?: TournamentDeadlines | null;
  /** Registration settings (lane L4, Manage → Registrations): replaced as a whole; null clears back to the old rules. */
  registration?: NonNullable<TournamentSummary["registration"]> | null;
}

export interface NewsInput { title?: string; body?: string; pinned?: boolean }

/** Raw image upload (PUT) with the same-origin session; answers the JSON body or throws an ApiError. */
export type RawUploader = (path: string, body: Blob) => Promise<unknown>;
const fetchUpload: RawUploader = async (path, body) => {
  const res = await fetch(path, {
    method: "PUT", credentials: "same-origin", headers: { "x-cw-auth": "1", "content-type": body.type || "application/octet-stream" }, body,
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Upload failed (${res.status}).`);
  return data;
};

export interface EntrantPatch { flags?: Partial<TournamentEntrantFlags>; manualSeed?: number | null }

/** Only http(s) image URLs are rendered as crests; anything else (data:, javascript:, relative junk) is dropped. */
export function safeCrestUrl(url: string | undefined | null): string {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim()) ? url.trim() : "";
}

/** `onChanged` runs after every successful write (register, withdraw, submit, organiser actions): the shell's nav trees and
 *  deadlines refetch through it. */
export function createTournamentDetail(deps: { api: Fetcher; onSignedOut?: () => void; onChanged?: () => void; upload?: RawUploader }) {
  const state = reactive<TournamentDetailState>({
    id: "", tournament: null, series: null, entrants: [], rounds: [], fixtures: [], activity: [], standings: [], standingsStatus: "idle", standingsError: "",
    loaded: false, loading: false, notFound: false, error: "",
    capabilities: { manage: false, assignRoles: false }, busy: "", actionError: "", notice: "", lastAction: "",
    teamOptions: { status: "idle", saves: [] }, preview: null, startOutcome: "",
    registrationStatus: null, checkIn: null, myRegistration: null, registrations: { status: "idle", data: null, error: "" },
  });

  // Request generations: a response is applied only if no newer request of its kind started (A -> B -> A safe).
  let loadGen = 0;
  let standingsGen = 0;
  let registrationsGen = 0;
  const signedOut = (err: unknown): boolean => {
    if (err instanceof ApiError && err.status === 401 && deps.onSignedOut) { deps.onSignedOut(); return true; }
    return false;
  };

  /** `silent` = a background refresh: a failure other than 404 keeps what is on screen. */
  async function load(id: string, silent = false): Promise<void> {
    if (state.id !== id) {
      state.tournament = null; state.series = null; state.entrants = []; state.rounds = []; state.fixtures = []; state.activity = [];
      state.standings = []; state.standingsStatus = "idle"; state.standingsError = "";
      state.capabilities = { manage: false, assignRoles: false }; state.preview = null; state.startOutcome = "";
      state.actionError = ""; state.notice = "";
      state.registrationStatus = null; state.checkIn = null; state.myRegistration = null; state.registrations = { status: "idle", data: null, error: "" };
      registrationsGen++;
      standingsGen++;
    }
    state.id = id;
    const mine = ++loadGen;
    state.loading = true;
    try {
      const res = await deps.api<TournamentDetailResponse>(`/api/tournaments/${encodeURIComponent(id)}`);
      if (mine !== loadGen) return;
      state.tournament = res.tournament;
      state.series = res.series && typeof res.series.id === "string" && typeof res.series.name === "string" ? { id: res.series.id, name: res.series.name } : null;
      state.entrants = res.entrants ?? [];
      state.rounds = [...(res.rounds ?? [])].sort((a, b) => a.number - b.number);
      state.fixtures = res.scheduledMatches ?? [];
      state.activity = Array.isArray(res.activity) ? res.activity : [];
      state.capabilities = { manage: res.capabilities?.manage === true, assignRoles: res.capabilities?.assignRoles === true };
      state.registrationStatus = res.registrationStatus ?? null;
      state.checkIn = res.checkIn ?? null;
      state.myRegistration = res.myRegistration ?? null;
      state.error = "";
      state.notFound = false;
    } catch (err) {
      if (mine !== loadGen) return;
      const notFound = err instanceof ApiError && err.status === 404;
      if (silent && !notFound && state.tournament) return;
      state.tournament = null;
      state.notFound = notFound;
      state.error = signedOut(err) ? "Signed out. Sign in and try again." : err instanceof Error ? err.message : "Can't load this tournament.";
    } finally {
      if (mine === loadGen) { state.loading = false; state.loaded = true; }
    }
  }

  async function loadStandings(silent = false): Promise<void> {
    const id = state.id;
    if (!id) return;
    const mine = ++standingsGen;
    if (!silent) state.standingsStatus = "loading";
    try {
      // GET /api/tournaments/:id/standings answers { tournamentId, standings: Row[] }.
      const res = await deps.api<{ standings?: TournamentStandingRow[] }>(`/api/tournaments/${encodeURIComponent(id)}/standings`);
      if (mine !== standingsGen) return;
      state.standings = Array.isArray(res?.standings) ? res.standings : [];
      state.standingsError = "";
      state.standingsStatus = "ok";
    } catch (err) {
      if (mine !== standingsGen) return;
      if (silent && state.standingsStatus === "ok") return;
      state.standings = [];
      state.standingsError = signedOut(err) ? "Signed out. Sign in and try again." : err instanceof Error ? err.message : "Can't load standings.";
      state.standingsStatus = "error";
    }
  }

  /** The organisers' Registrations panel (managers only; a failure keeps what is on screen when silent). */
  async function loadRegistrations(silent = false): Promise<void> {
    const id = state.id;
    if (!id || !state.capabilities.manage) return;
    const mine = ++registrationsGen;
    if (!silent) state.registrations.status = "loading";
    try {
      const res = await deps.api<TournamentRegistrationsResponse>(`/api/tournaments/${encodeURIComponent(id)}/registrations`);
      if (mine !== registrationsGen) return;
      state.registrations = { status: "ok", data: res, error: "" };
    } catch (err) {
      if (mine !== registrationsGen) return;
      if (silent && state.registrations.status === "ok") return;
      state.registrations = { status: "error", data: null, error: signedOut(err) ? "Signed out. Sign in and try again." : err instanceof Error ? err.message : "Can't load registrations." };
    }
  }

  /** Background refresh: the tournament, and the standings / registrations if they have been opened. */
  async function refresh(): Promise<void> {
    if (!state.id) return;
    await Promise.all([
      load(state.id, true),
      state.standingsStatus === "idle" ? Promise.resolve() : loadStandings(true),
      state.registrations.status === "idle" ? Promise.resolve() : loadRegistrations(true),
    ]);
  }

  /** Loads what a tab needs the first time it is shown. */
  async function ensureTab(tab: DetailTab): Promise<void> {
    // Statistics / Honours / Awards poll the standings too: their totals are the results signal (tournaments/honours.ts resultsStamp).
    const results = tab === "standings" || tab === "statistics" || tab === "honours" || tab === "awards";
    if (results && state.tournament && state.standingsStatus === "idle") await loadStandings();
  }

  const base = (): string => `/api/tournaments/${encodeURIComponent(state.id)}`;
  const message = (err: unknown, fallback: string): string =>
    signedOut(err) ? "Signed out. Sign in and try again." : err instanceof Error ? err.message : fallback;

  /** One write: busy flag, server message on failure, refetch (tournament + opened standings) after it either way. */
  async function run<T>(name: string, write: () => Promise<T>, notice = ""): Promise<T | undefined> {
    if (!state.id || state.busy) return undefined;
    state.busy = name;
    state.lastAction = name;
    state.actionError = "";
    state.notice = "";
    try {
      const out = await write();
      state.notice = notice;
      deps.onChanged?.();
      return out;
    } catch (err) {
      state.actionError = message(err, "That did not work.");
      return undefined;
    } finally {
      state.busy = "";
      await refresh();
    }
  }

  /** The signed-in coach's saved teams (a failed read is an empty list, never an error). The fork library is never read. */
  async function loadTeamOptions(coach: string): Promise<void> {
    if (!coach) return;
    state.teamOptions.status = "loading";
    const saves = await deps.api<{ saves?: BuilderSaveSummary[] }>("/api/fork/team-builder/saves").then((r) => r.saves ?? []).catch(() => [] as BuilderSaveSummary[]);
    state.teamOptions = { status: "ok", saves };
  }

  // ---- player actions ----
  /** Self-registration with the share picker (owner 10-31): `share` = what the organisers see beyond the coach name and
   *  teams; on a NAF-sanctioned tournament a NAF number, or notNafMember. */
  const register = (teamId: string, entry: RegistrationExtras = {}) =>
    run("register", () => deps.api(`${base()}/entrants`, { method: "POST", body: registrationBody(teamId, entry) }), "You are registered.");
  /** The coach's NAF answer for their entry (NAF-sanctioned tournament): "not a NAF member", or the NAF details now on
   *  their profile (fromProfile). */
  const answerNaf = (entrantId: string, answer: { notNafMember?: boolean } = {}) =>
    run("naf", () => deps.api(`${base()}/entrants/${encodeURIComponent(entrantId)}/naf`, {
      method: "POST", body: answer.notNafMember ? { notNafMember: true } : { fromProfile: true },
    }), "NAF answer saved.");
  // ---- registration (lane L4) ----
  /** The register sheet's request (registration.ts registerBody). The confirmation follows the server's outcome. */
  async function registerEntry(body: Record<string, unknown>): Promise<boolean> {
    const out = await run("register", () => deps.api<{ registration?: { state?: string; position?: number } }>(`${base()}/entrants`, { method: "POST", body }));
    if (out === undefined) return false;
    const s = out?.registration?.state;
    state.notice = s === "pending" ? "Entry received. The organisers review every entry."
      : s === "waitlisted" ? `It's full, so you're on the waitlist${out?.registration?.position ? ` (#${out.registration.position})` : ""}.`
        : "You are registered.";
    return true;
  }
  /** Withdraw the viewer's own entry in any live state (pending and waitlisted entries are not in `entrants`). */
  const withdrawEntry = (entrantId: string) =>
    run("withdraw", () => deps.api(`${base()}/entrants/${encodeURIComponent(entrantId)}`, { method: "DELETE" }), "Your entry is withdrawn.");
  /** Self check-in during the check-in window. */
  const checkIn = () => run("checkin", () => deps.api(`${base()}/check-in`, { method: "POST", body: {} }), "You are checked in.");
  /** A new personal check-in QR (the old one stops working); also asks for the first one when none was issued yet. */
  const newCheckInCode = () => run("checkin-code", () => deps.api(`${base()}/check-in/code`, { method: "POST", body: {} }), "Here is your new check-in code. The old one no longer works.");
  /** "I've paid" (or taking it back): the organisers see "Coach says paid" and still tick Paid themselves. */
  const claimPaid = (entrantId: string, paid: boolean) =>
    run("paid", () => deps.api(`${base()}/entrants/${encodeURIComponent(entrantId)}/paid-claim`, { method: "POST", body: { paid } }),
      paid ? "Thanks. The organisers will check the payment and mark it received." : "Payment note removed.");
  /** Organisers: accept / waitlist / decline / promote / remove (with "promote" = take the next in line). */
  const decide = (entrantId: string, verb: "accept" | "waitlist" | "decline" | "promote" | "remove", extra: { reason?: string; promote?: boolean } = {}) => {
    const words = { accept: "Entry accepted.", waitlist: "Moved to the waitlist.", decline: "Entry declined.", promote: "Promoted from the waitlist.", remove: "Entry removed." } as const;
    return run(`reg:${entrantId}`, () => deps.api(`${base()}/registrations/${encodeURIComponent(entrantId)}/${verb}`, {
      method: "POST", body: { ...(extra.reason?.trim() ? { reason: extra.reason.trim() } : {}), ...(extra.promote ? { promote: true } : {}) },
    }), words[verb]);
  };

  const withdraw = () => {
    const mine = state.tournament?.myEntrantId;
    return mine
      ? run("withdraw", () => deps.api(`${base()}/entrants/${encodeURIComponent(mine)}`, { method: "DELETE" }), "Your entry is withdrawn.")
      : Promise.resolve(undefined);
  };
  const submit = (saveId: string) =>
    run("submit", () => deps.api(`${base()}/submissions`, { method: "POST", body: { saveId } }), "Team submitted.");

  // ---- organiser actions ----
  const saveSettings = (patch: TournamentSettingsPatch) =>
    run("settings", () => deps.api(base(), { method: "PATCH", body: patch }), "Settings saved.");
  const setOwner = (coachId: string) =>
    run("owner", () => deps.api(`${base()}/owner`, { method: "POST", body: { coachId } }), "Owner changed.");
  const addOrganizer = (coachId: string) =>
    run("organizers", () => deps.api(`${base()}/organizers/${encodeURIComponent(coachId)}`, { method: "POST" }), "Organiser added.");
  const removeOrganizer = (coachId: string) =>
    run("organizers", () => deps.api(`${base()}/organizers/${encodeURIComponent(coachId)}`, { method: "DELETE" }), "Organiser removed.");
  const lockRosters = () => run("lock", () => deps.api(`${base()}/lock-rosters`, { method: "POST" }), "Rosters locked.");
  const unlockRosters = () => run("lock", () => deps.api(`${base()}/unlock-rosters`, { method: "POST" }), "Rosters unlocked.");
  const finish = () => run("finish", () => deps.api(`${base()}/finish`, { method: "POST" }), "Tournament finished.");
  /** Lane L3: publish a hidden draft (public, registration per its window) or put a draft nobody entered back out of sight. */
  const publish = () => run("publish", () => deps.api(`${base()}/publish`, { method: "POST" }), "Tournament published.");
  const unpublish = () => run("publish", () => deps.api(`${base()}/unpublish`, { method: "POST" }), "Tournament unpublished. Only its organisers can see it.");
  const patchEntrant = (entrantId: string, patch: EntrantPatch) =>
    run(`entrant:${entrantId}`, () => deps.api(`${base()}/entrants/${encodeURIComponent(entrantId)}`, { method: "PATCH", body: patch }));

  // ---- tournament page (page fields, banner, news) ----
  const savePage = (patch: TournamentSettingsPatch) =>
    run("page", () => deps.api(base(), { method: "PATCH", body: patch }), "Tournament page saved.");
  const uploadBanner = (image: Blob) =>
    run("banner", () => (deps.upload ?? fetchUpload)(`${base()}/banner`, image), "Banner updated.");
  const removeBanner = () => run("banner", () => deps.api(`${base()}/banner`, { method: "DELETE" }), "Banner removed.");
  const postNews = (input: NewsInput) =>
    run("news", () => deps.api(`${base()}/news`, { method: "POST", body: input }), "News posted.");
  const editNews = (id: string, patch: NewsInput) =>
    run(`news:${id}`, () => deps.api(`${base()}/news/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }), "News updated.");
  const deleteNews = (id: string) =>
    run(`news:${id}`, () => deps.api(`${base()}/news/${encodeURIComponent(id)}`, { method: "DELETE" }), "News deleted.");

  /** One click: lock + validate + start. A refusal (409) leaves the lock, so the table shows which rosters fail. */
  async function start(force = false): Promise<void> {
    state.startOutcome = "";
    const ok = await run("start", () => deps.api(`${base()}/start`, { method: "POST", body: force ? { force: true } : {} }), "Tournament started.");
    state.startOutcome = ok === undefined ? (state.actionError ? "refused" : "") : "started";
  }

  async function previewRound(pairingSystem?: TournamentPairingSystem, seedingMode?: TournamentSeedingMode): Promise<void> {
    if (!state.id || state.busy) return;
    state.busy = "preview";
    state.actionError = "";
    try {
      state.preview = await deps.api<TournamentRoundPreview>(`${base()}/rounds`, {
        method: "POST",
        body: { preview: true, ...(pairingSystem ? { pairingSystem } : {}), ...(seedingMode ? { seedingMode } : {}) },
      });
    } catch (err) {
      state.preview = null;
      state.actionError = message(err, "Can't preview the round.");
    } finally {
      state.busy = "";
    }
  }

  async function generateRound(pairingSystem?: TournamentPairingSystem, seedingMode?: TournamentSeedingMode): Promise<boolean> {
    const ok = await run("generate", () => deps.api(`${base()}/rounds`, {
      method: "POST",
      body: { ...(pairingSystem ? { pairingSystem } : {}), ...(seedingMode ? { seedingMode } : {}) },
    }), "Fixtures generated.");
    if (ok !== undefined) state.preview = null;
    return ok !== undefined;
  }

  // ---- organiser result edits (owner ruling 10-29 §7) ----
  /** Override a recorded result at the fixture revision the dialog loaded (a stale one answers 409, never a silent
   *  overwrite); `confirmFinished` is needed on a finished tournament. Answers whether it saved. */
  async function editResult(fixtureId: string, edit: ResultEditForm, revision: number): Promise<boolean> {
    const ok = await run(`result:${fixtureId}`, () => deps.api(`${base()}/fixtures/${encodeURIComponent(fixtureId)}/result`, {
      method: "PATCH", body: resultEditBody({ revision }, edit),
    }), "Result edited.");
    return ok !== undefined;
  }
  /** Clear a recorded result back to unplayed. */
  async function clearResult(fixtureId: string, edit: Pick<ResultEditForm, "reason" | "confirmFinished">, revision: number): Promise<boolean> {
    const reason = fieldText(edit.reason);
    const ok = await run(`result:${fixtureId}`, () => deps.api(`${base()}/fixtures/${encodeURIComponent(fixtureId)}/result/clear`, {
      method: "POST", body: { revision, ...(reason ? { reason } : {}), ...(edit.confirmFinished ? { confirmFinished: true } : {}) },
    }), "Result cleared.");
    return ok !== undefined;
  }

  return {
    state, load, loadStandings, ensureTab, refresh, loadTeamOptions,
    editResult, clearResult,
    register, withdraw, submit, answerNaf,
    registerEntry, withdrawEntry, checkIn, newCheckInCode, claimPaid, decide, loadRegistrations,
    saveSettings, setOwner, addOrganizer, removeOrganizer, lockRosters, unlockRosters, finish, publish, unpublish, patchEntrant,
    start, previewRound, generateRound,
    savePage, uploadBanner, removeBanner, postNews, editNews, deleteNews,
  };
}

export type TournamentDetail = ReturnType<typeof createTournamentDetail>;
export const TOURNAMENT_DETAIL_KEY: InjectionKey<TournamentDetail> = Symbol("tournament-detail");

// ---- display helpers (pure) ----

export interface TeamLabel { entrantId: string; team: string; coach: string; race: string; logoUrl: string }

/** Entrant lookup by id: team and coach as the server named them, with the team id as the fallback name. */
export function teamLabels(entrants: TournamentEntrant[]): Map<string, TeamLabel> {
  const out = new Map<string, TeamLabel>();
  for (const e of entrants) {
    out.set(e.id, { entrantId: e.id, team: e.teamName || e.teamId, coach: e.coachId ?? "", race: e.race ?? "", logoUrl: safeCrestUrl(e.logoUrl) });
  }
  return out;
}

export interface FixtureSideView { team: string; coach: string; logoUrl: string; score: number | null; cas: number | null }
export interface FixtureView { id: string; status: string; home: FixtureSideView; away: FixtureSideView | null; played: boolean; edited: TournamentFixtureEdit | null }
export interface RoundView { number: number; status: string; fixtures: FixtureView[] }

const sideView = (label: TeamLabel | undefined, side: { teamId: string; coach: { ffbCoachId: string } }, score: number | null, cas: number | null): FixtureSideView => ({
  team: label?.team || side.teamId, coach: label?.coach || side.coach.ffbCoachId, logoUrl: label?.logoUrl ?? "", score, cas,
});

/** Rounds with their fixtures; a round the server has no fixtures for (anonymous) is listed empty. */
export function roundViews(s: Pick<TournamentDetailState, "rounds" | "fixtures" | "entrants">): RoundView[] {
  const labels = teamLabels(s.entrants);
  const numbers = new Set<number>(s.rounds.map((r) => r.number));
  for (const f of s.fixtures) numbers.add(f.roundNumber);
  return [...numbers].sort((a, b) => a - b).map((number) => ({
    number,
    status: s.rounds.find((r) => r.number === number)?.status ?? "active",
    fixtures: s.fixtures.filter((f) => f.roundNumber === number).map((f) => {
      const r = f.result;
      return {
        id: f.id,
        status: f.status,
        played: Boolean(r),
        home: sideView(labels.get(f.home.entrantId), f.home, r ? r.homeScore : null, r ? r.homeCasualties ?? null : null),
        away: f.away ? sideView(labels.get(f.away.entrantId), f.away, r ? r.awayScore : null, r ? r.awayCasualties ?? null : null) : null,
        edited: f.edited?.kind === "result" ? f.edited : null,
      };
    }),
  }));
}

export interface StandingView {
  rank: number; team: string; coach: string; race: string; logoUrl: string;
  points: number; played: number; wins: number; draws: number; losses: number; td: number; cas: number; tiebreak: string;
}

const TIEBREAK_LABEL: Record<string, string> = {
  buchholz: "Buchholz", sonnebornBerger: "SB", opponentWinPercentage: "OW%", headToHead: "H2H",
  touchdownDifferential: "TD +/-", touchdownsFor: "TD", casualtyDifferential: "CAS +/-", casualtiesFor: "CAS", seed: "Seed",
};

/** The column header for the tournament's first tiebreaker (Buchholz when the server names none). */
export function tiebreakLabel(t: Pick<TournamentSummary, "tiebreakers"> | null): string {
  return TIEBREAK_LABEL[t?.tiebreakers?.[0] ?? "buchholz"] ?? "Tiebreak";
}

export const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

function tiebreakValue(row: TournamentStandingRow, key: string): string {
  const n = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));
  switch (key) {
    case "sonnebornBerger": return n(row.sonnebornBerger);
    case "opponentWinPercentage": return `${Math.round(row.opponentWinPercentage * 100)}%`;
    case "touchdownDifferential": return signed(row.touchdownDifferential);
    case "casualtyDifferential": return signed(row.casualtyDifferential);
    case "touchdownsFor": return n(row.touchdownsFor);
    case "casualtiesFor": return n(row.casualtiesFor);
    case "seed": return n(row.seed);
    case "headToHead": return "";
    default: return n(row.buchholz);
  }
}

export function standingViews(s: Pick<TournamentDetailState, "standings" | "entrants" | "tournament">): StandingView[] {
  const labels = teamLabels(s.entrants);
  const key = s.tournament?.tiebreakers?.[0] ?? "buchholz";
  return s.standings.map((r) => {
    const l = labels.get(r.entrantId);
    return {
      rank: r.rank, team: l?.team || r.teamId, coach: l?.coach || r.coachId, race: l?.race ?? "", logoUrl: l?.logoUrl ?? "",
      points: r.points, played: r.played, wins: r.wins, draws: r.draws, losses: r.losses,
      td: r.touchdownsFor, cas: r.casualtiesFor, tiebreak: tiebreakValue(r, key),
    };
  });
}

export function roundProgress(t: Pick<TournamentSummary, "currentRound" | "roundCount">): string {
  if (t.currentRound > 0) return `Round ${t.currentRound} of ${t.roundCount}`;
  return t.roundCount > 0 ? `Not started (${t.roundCount} rounds)` : "Not started";
}

/** The calendar day of a tournament instant in the viewer's zone ("2026-12-05"). */
export function startDate(iso: string | undefined, zone?: string): string {
  return localDay(iso, zone);
}

/** Entrant status: dropped coaches are labelled, everyone else is registered. */
export const entrantStatus = (e: TournamentEntrant): string => (e.droppedAt ? "Dropped" : "Registered");

// ---- phase 2/3 display helpers (pure) ----

export const PAIRING_LABEL: Record<TournamentPairingSystem, string> = { dutch: "Dutch", monrad: "Monrad", eloSeeded: "Rating-seeded" };
export const SEEDING_LABEL: Record<TournamentSeedingMode, string> = { elo: "By rating", manual: "Manual seeds" };
export type TournamentPrimaryTiebreaker = "buchholz" | "sonnebornBerger";
export const TIEBREAKER_LABEL: Record<TournamentPrimaryTiebreaker, string> = { buchholz: "Buchholz", sonnebornBerger: "Sonneborn-Berger" };

export type RosterState = "none" | "valid" | "invalid";
/** The roster chip: no submission, valid (validator or organiser override), invalid. */
export function rosterState(e: Pick<TournamentEntrant, "submission" | "flags">): RosterState {
  if (e.flags?.rosterVerified) return "valid";
  if (!e.submission) return "none";
  if (e.flags) return "invalid";
  return e.submission.valid ? "valid" : "invalid";
}
export const ROSTER_LABEL: Record<RosterState, string> = { none: "Not submitted", valid: "Valid", invalid: "Invalid" };
/** `.sf-chip` tones (design guide §5) for the roster and round states. */
export const ROSTER_TONE: Record<RosterState, string> = { none: "muted", valid: "ok", invalid: "urgent" };
export const ROUND_TONE: Record<string, string> = { pending: "muted", active: "soon", completed: "ok" };

/** Registration is open: draft or active before round 1, rosters not locked. */
export function registrationOpen(t: TournamentSummary, rounds: TournamentRound[]): boolean {
  return (t.status === "draft" || t.status === "active") && rounds.length === 0 && !t.rostersLockedAt;
}

export function remainingRounds(t: TournamentSummary): number {
  if (typeof t.remainingRounds === "number") return t.remainingRounds;
  return t.status === "completed" || t.status === "cancelled" ? 0 : Math.max(0, t.roundCount - t.currentRound);
}

/** The viewer's own entrant row (by the server's myEntrantId). */
export function myEntrant(s: Pick<TournamentDetailState, "tournament" | "entrants">): TournamentEntrant | undefined {
  const id = s.tournament?.myEntrantId;
  return id ? s.entrants.find((e) => e.id === id) : undefined;
}

export interface NextFixtureView { fixtureId: string; round: number; opponentEntrantId: string | null; opponentTeam: string; opponentCoach: string; status: string }

/** An entrant's next unplayed fixture (latest round first), with the opponent named from the entrant list. */
export function nextFixtureFor(entrantId: string, s: Pick<TournamentDetailState, "fixtures" | "entrants">): NextFixtureView | null {
  const labels = teamLabels(s.entrants);
  const open = [...s.fixtures]
    .filter((f) => f.status !== "completed" && f.status !== "cancelled" && f.status !== "dismissed" &&
      (f.home.entrantId === entrantId || f.away?.entrantId === entrantId))
    .sort((a, b) => b.roundNumber - a.roundNumber)[0];
  if (!open) return null;
  const other = open.home.entrantId === entrantId ? open.away : open.home;
  const label = other ? labels.get(other.entrantId) : undefined;
  return {
    fixtureId: open.id, round: open.roundNumber, status: open.status,
    opponentEntrantId: other?.entrantId ?? null,
    opponentTeam: other ? label?.team || other.teamId : "Bye",
    opponentCoach: other ? label?.coach || other.coach.ffbCoachId : "",
  };
}

/** Rounds view filtered to the fixtures an entrant plays in ("Mine"). */
export function onlyMine(rounds: RoundView[], fixtures: TournamentFixture[], entrantId: string): RoundView[] {
  const mine = new Set(fixtures.filter((f) => f.home.entrantId === entrantId || f.away?.entrantId === entrantId).map((f) => f.id));
  return rounds.map((r) => ({ ...r, fixtures: r.fixtures.filter((f) => mine.has(f.id)) })).filter((r) => r.fixtures.length > 0);
}

/** Active, every drawn round complete, rounds left: the organiser may generate the next round. */
export function canGenerateRound(t: TournamentSummary, rounds: TournamentRound[]): boolean {
  if (t.status !== "active") return false;
  if (rounds.some((r) => r.status !== "completed")) return false;
  return rounds.length < t.roundCount;
}

/** ISO instant -> the value of a datetime-local input in the viewer's zone (minutes), and back ("" clears). Owner 11-04:
 *  tournament times are instants, typed and shown in the viewer's own zone (shared/localTime.ts). */
export function toLocalInput(iso: string | undefined, zone?: string): string {
  return toZoneInput(iso, zone);
}
export function fromLocalInput(value: string, zone?: string): string {
  return fromZoneInput(value, zone);
}

export interface SubmitChoice { ref: string; label: string; group: "Saved teams" }

/** Submit team choices: the coach's saved teams (save:<id>). Fork library teams are never offered (owner 11-03). */
export function submitChoices(options: TournamentDetailState["teamOptions"]): SubmitChoice[] {
  return options.saves.map((s) => ({ ref: `save:${s.id}`, label: `${s.name}${s.raceName ? ` (${s.raceName})` : ""}`, group: "Saved teams" as const }));
}

// ---- tournament page helpers (pure) ----

/** The Tournament Builder pre-filtered to a package (its ?package= deep link). */
export const rulesetBuilderHref = (packageName: string): string => `/tournament-team-builder?package=${encodeURIComponent(packageName)}`;
/** The Tournament Creator opened on a package (organiser page in the SPA; the name rides in the query so dots survive). */
export const rulesetCreatorHref = (packageName: string): string => `/app/tournament-creator?package=${encodeURIComponent(packageName)}`;

/** Two-letter initials for the ruleset crest fallback ("nut-cup" -> "NC"). */
export function rulesetInitials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => w[0]) : [...(words[0] ?? "").slice(0, 2)];
  return letters.join("").toUpperCase() || "?";
}

/** "01 Nov 2026, 16:00 GMT" for a deadline, in the viewer's zone; "" when absent or unreadable. */
export function dateTimeLabel(iso: string | undefined, zone?: string): string {
  return localWhen(iso, zone);
}

const FORMAT_NAME: Record<TournamentSummary["format"], string> = { swiss: "Swiss", roundRobin: "Round robin", knockout: "Knockout" };

/** "Swiss · Dutch · 5 rounds" (the pairing system only for Swiss). */
export function formatLine(t: Pick<TournamentSummary, "format" | "pairingSystem" | "roundCount">): string {
  const parts = [FORMAT_NAME[t.format] ?? t.format];
  if (t.format === "swiss") parts.push(PAIRING_LABEL[t.pairingSystem ?? "eloSeeded"]);
  if (t.roundCount > 0) parts.push(`${t.roundCount} ${t.roundCount === 1 ? "round" : "rounds"}`);
  return parts.join(" · ");
}

/** Places left, or null when the tournament is uncapped (maxPlayers 0). */
export function placesLeft(t: Pick<TournamentSummary, "maxPlayers" | "entrantCount">): number | null {
  return t.maxPlayers > 0 ? Math.max(0, t.maxPlayers - (t.entrantCount ?? 0)) : null;
}

export interface FactView { key: string; label: string; value: string; href?: string; sub?: string; subHref?: string }

/** The facts strip: only the facts the server sent (absent fields are left out, never shown as blanks). */
export function factsStrip(t: TournamentSummary, zone?: string): FactView[] {
  const out: FactView[] = [];
  const loc = t.location;
  if (loc && (loc.venue || loc.address)) {
    const mapUrl = loc.mapUrl && /^https?:\/\//i.test(loc.mapUrl) ? loc.mapUrl : undefined;
    out.push({
      key: "location", label: "Location", value: loc.venue || loc.address || "",
      ...(loc.venue && loc.address ? { sub: loc.address } : {}),
      ...(mapUrl ? { subHref: mapUrl } : {}),
    });
  }
  const start = startDate(t.startsAt, zone);
  const end = startDate(t.endsAt, zone);
  out.push({ key: "dates", label: "Dates", value: start ? (end && end !== start ? `${start} to ${end}` : start) : "Not set" });
  // The start instant in the viewer's own zone (owner 11-04); the organiser's "Start time" text is the venue's clock.
  const starts = localWhen(t.startsAt, zone);
  if (starts) out.push({ key: "starts", label: "Starts", value: starts });
  if (t.startTime) out.push({ key: "startTime", label: starts ? "Venue start time" : "Start time", value: t.startTime });
  const ruleset = t.rulesetPackName || t.packageName;
  if (ruleset) out.push({ key: "ruleset", label: "Ruleset", value: ruleset, href: rulesetBuilderHref(ruleset) });
  out.push({ key: "format", label: "Format", value: formatLine(t) });
  if (t.entryFee) out.push({ key: "entryFee", label: "Entry fee", value: t.entryFee });
  const entrants = t.entrantCount ?? 0;
  out.push({ key: "entrants", label: "Entrants", value: t.maxPlayers > 0 ? `${entrants} of ${t.maxPlayers}` : String(entrants) });
  const left = placesLeft(t);
  if (left !== null) out.push({ key: "places", label: "Places left", value: String(left) });
  if (t.ownerCoachId) out.push({ key: "organisers", label: "Organisers", value: [t.ownerCoachId, ...(t.organizerCoachIds ?? [])].join(", ") });
  const reg = dateTimeLabel(t.deadlines?.registration, zone);
  if (reg) out.push({ key: "registration", label: "Registration closes", value: reg });
  const checkIn = dateTimeLabel(t.deadlines?.checkIn, zone);
  if (checkIn) out.push({ key: "checkIn", label: "Check-in by", value: checkIn });
  out.push({ key: "round", label: "Round", value: roundProgress(t) });
  out.push({ key: "roundsLeft", label: "Rounds left", value: String(remainingRounds(t)) });
  return out;
}

/** News as the server ordered it (pinned first, newest first); re-sorted defensively. */
export function newsList(t: Pick<TournamentSummary, "news"> | null): TournamentNewsPost[] {
  return [...(t?.news ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.at) - Date.parse(a.at));
}

/** Only same-origin API paths render as the banner image. */
export function safeBannerUrl(url: string | undefined): string {
  return typeof url === "string" && /^\/api\/tournaments\/[\w-]{1,64}\/banner(\?v=[a-f0-9]{1,64})?$/.test(url) ? url : "";
}

/** Write names whose messages show in their own panel (the page form, the News panel, Manage → Rounds and its Edit
 *  result dialog), not in My entry / Summary. */
export const isPageAction = (name: string): boolean =>
  name === "page" || name === "banner" || name === "news" || name.startsWith("news:") || name.startsWith("result:")
  // Registration (lane L4): the Registrations panel and the Check in bar show their own messages.
  || name.startsWith("reg:") || name === "checkin";

// ---- organiser result edits (pure) ----

/** The Edit result dialog's fields. Vue's v-model on a number input hands back a number (or "" when empty), so every
 *  numeric field is string | number and read through fieldText(). */
export interface ResultEditForm { homeScore: string | number; awayScore: string | number; homeCas: string | number; awayCas: string | number; reason: string; confirmFinished: boolean }

/** A form field as trimmed text, whatever the input handed back (number, string, null). */
export const fieldText = (v: unknown): string => (typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : typeof v === "string" ? v.trim() : "");

/** The dialog's starting values: the fixture's current result. */
export function resultEditForm(f: Pick<TournamentFixture, "result">): ResultEditForm {
  const r = f.result;
  const n = (v: number | undefined): string => (v === undefined ? "" : String(v));
  return { homeScore: n(r?.homeScore), awayScore: n(r?.awayScore), homeCas: n(r?.homeCasualties), awayCas: n(r?.awayCasualties), reason: "", confirmFinished: false };
}

const wholeNumber = (v: unknown): number | null => (/^\d{1,2}$/.test(fieldText(v)) ? Number(fieldText(v)) : null);

/** The problem with the dialog's fields ("" = fine). The server stays the authority. */
export function resultEditProblem(form: ResultEditForm, f: Pick<TournamentFixture, "result">, finished: boolean): string {
  if (wholeNumber(form.homeScore) === null || wholeNumber(form.awayScore) === null) return "Enter both scores (0 to 99).";
  const hc = fieldText(form.homeCas);
  const ac = fieldText(form.awayCas);
  if ((hc === "") !== (ac === "")) return "Enter both casualty counts, or leave both empty.";
  if (hc !== "" && (wholeNumber(hc) === null || wholeNumber(ac) === null)) return "Casualties are whole numbers from 0 to 99.";
  if (fieldText(form.reason).length > 500) return "Keep the reason under 500 characters.";
  const r = f.result;
  if (r && wholeNumber(form.homeScore) === r.homeScore && wholeNumber(form.awayScore) === r.awayScore &&
    (hc === "" ? undefined : Number(hc)) === r.homeCasualties && (ac === "" ? undefined : Number(ac)) === r.awayCasualties)
    return "Nothing changed yet.";
  if (finished && !form.confirmFinished) return "Tick the box to change a finished tournament.";
  return "";
}

/** PATCH .../fixtures/:id/result body. */
export function resultEditBody(f: Pick<TournamentFixture, "revision">, form: ResultEditForm) {
  const reason = fieldText(form.reason);
  const hc = fieldText(form.homeCas);
  const ac = fieldText(form.awayCas);
  return {
    revision: f.revision ?? 0,
    homeScore: Number(fieldText(form.homeScore)),
    awayScore: Number(fieldText(form.awayScore)),
    ...(hc !== "" && ac !== "" ? { homeCasualties: Number(hc), awayCasualties: Number(ac) } : {}),
    ...(reason ? { reason } : {}),
    ...(form.confirmFinished ? { confirmFinished: true } : {}),
  };
}

/** Where a fixture's result came from (the source record stays linked after an edit). */
export function resultSource(f: Pick<TournamentFixture, "launch" | "result">): "Online game" | "Tabletop match" | "Entered by an organiser" | "" {
  if (f.launch?.gameId) return "Online game";
  if (f.result?.opId) return "Tabletop match";
  return f.result ? "Entered by an organiser" : "";
}

/** "2 - 1 (CAS 3 - 0)" for a result, "No result" for null. */
export function resultText(r: TournamentResultValues | null | undefined): string {
  if (!r) return "No result";
  const cas = r.homeCasualties !== undefined && r.awayCasualties !== undefined ? ` (CAS ${r.homeCasualties} - ${r.awayCasualties})` : "";
  return `${r.homeScore} - ${r.awayScore}${cas}`;
}

/** The Edited chip's tooltip: who changed it, when, and why when the server sent the reason. */
export function editedTitle(e: TournamentFixtureEdit): string {
  const day = startDate(e.at);
  const cleared = e.cleared || Boolean(e.reportedAgainAt);
  const what = cleared ? "Result cleared" : "Result edited";
  const parts = [`${what} by ${e.byCoachId || "an organiser"}${day ? ` on ${day}` : ""}`];
  if (e.reportedAgainAt) parts.push(`reported again on ${startDate(e.reportedAgainAt)}`);
  if (e.previous !== undefined && e.previous !== null && !cleared) parts.push(`was ${resultText(e.previous)}`);
  if (e.reason) parts.push(`reason: ${e.reason}`);
  return parts.join(", ") + ".";
}

/** Rounds drawn after a fixture's round (their pairings stay as drawn when its result changes). */
export function laterRounds(rounds: TournamentRound[], roundNumber: number): number[] {
  return rounds.filter((r) => r.number > roundNumber).map((r) => r.number).sort((a, b) => a - b);
}

export interface ActivityView { id: string; when: string; by: string; text: string; reason: string }

/** The activity feed lines (newest first): "Round 2: Ann's Orcs v Bob's Elves edited to 2 - 1 (was 1 - 1)". */
export function activityViews(s: Pick<TournamentDetailState, "activity" | "fixtures" | "entrants">): ActivityView[] {
  const labels = teamLabels(s.entrants);
  return s.activity.map((a) => {
    const f = s.fixtures.find((x) => x.id === a.fixtureId);
    const name = (side: TournamentFixture["home"] | undefined) => (side ? labels.get(side.entrantId)?.team || side.teamId : "");
    const pairing = f ? `${name(f.home)} v ${name(f.away)}` : "a fixture";
    // Who / when only (the server sends old and new values to the managers and the fixture's coaches).
    const was = a.previous ? ` (was ${resultText(a.previous)})` : "";
    const text = a.kind === "result-cleared"
      ? `Round ${a.roundNumber}: ${pairing} result cleared${was}`
      : a.result ? `Round ${a.roundNumber}: ${pairing} edited to ${resultText(a.result)}${was}` : `Round ${a.roundNumber}: ${pairing} result edited`;
    return { id: a.id, when: dateTimeLabel(a.at), by: a.by, text, reason: a.reason ?? "" };
  });
}
