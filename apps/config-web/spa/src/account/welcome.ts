// Onboarding step 1, "Your coach name" (/app/welcome, spec-registration-creation-flows 11-02 §3 + Q2): the SPA screen
// the Discord callback lands on, replacing the retired vanilla discord-complete.html (its old path 302s here). The same
// server routes and the same safety: GET /api/auth/discord/pending (the verified Discord identity held server-side under
// the pending cookie), GET /api/fork/name-available (live check), POST /api/auth/discord/complete (provisional signup ->
// fork account -> identity row; or link an existing account with its password; or the returning-coach login). Every
// refusal is the server's (ban / deletion marker / fence / reserved name / CSRF); this file only mirrors the old page's
// client checks so the coach sees them before submitting. No DOM: WelcomeView.vue renders it.

import { reactive } from "vue";
import type { Fetcher } from "../session";
import type { ApiError } from "../shared/api";
import { isReservedCoachName, RESERVED_NAME_MESSAGE } from "../../../src/privacy/reservedNames";

export const COACH_NAME_MAX = 40;
/** An ApiError's status (read by shape: an error may come from another bundle's ApiError class). */
const statusOf = (e: unknown): number | undefined => (e as Partial<ApiError> | null)?.status;
export const NAME_REQUIRED = "Enter a coach name.";
export const NAME_TOO_LONG = `Coach names must be at most ${COACH_NAME_MAX} characters.`;
export const NAME_AVAILABLE = "That coach name is available.";
export const NAME_TAKEN = "That coach name is taken. If it's your account, choose \"I already have a Super FUMBBL account\" and enter its password.";
export const NAME_LINK = "That coach already exists. Enter its password to link it to your Discord account. The account and its password don't change.";
export const NAME_DESKTOP_MISSING = "That coach does not exist. Create the account in Super FUMBBL before signing in.";
export const PASSWORD_REQUIRED = "Enter the account's password to link it.";
/** Where a sign-in with no `next` of its own lands (spec §3 step 5: the coach page with its Get started panel). */
export const WELCOME_LANDING = "/app/home";

/** The old page's checks, in its order: empty, too long, then the reserved pseudonym (the server's own rule). */
export function coachNameProblem(raw: string): string {
  const coach = raw.trim();
  if (!coach) return NAME_REQUIRED;
  if (coach.length > COACH_NAME_MAX) return NAME_TOO_LONG;
  if (isReservedCoachName(coach)) return RESERVED_NAME_MESSAGE;
  return "";
}

export type CallbackError = "host-browser-mismatch" | "expired" | "invalid-state";

/** The callback's ?error= codes (discordCompletionErrorUrl), as a title and one plain sentence. */
export function callbackErrorText(code: string | null, origin: string): { title: string; message: string } | null {
  if (code === "host-browser-mismatch") return {
    title: "Sign-in came back to a different browser",
    message: `This sign-in did not return to the browser or profile that started it. Open ${origin}/ and try again in the same browser.`,
  };
  if (code === "expired") return { title: "Discord sign-in expired", message: "This Discord sign-in expired. Start again." };
  if (code === "invalid-state") return { title: "Discord sign-in could not be verified", message: "The sign-in could not be checked. Start again." };
  return null;
}

/** The landing after step 1: the sign-in's own `next` wins; the bare "/" default goes to the coach page. */
export function welcomeLanding(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return WELCOME_LANDING;
  return next === "/" ? WELCOME_LANDING : next;
}

export interface PendingDiscord {
  pending: boolean;
  discordUsername?: string;
  existingFfbCoachId?: string | null;
  requestedFfbCoachId?: string | null;
  desktop?: boolean;
}
interface CompleteResult { coach?: string; next?: string; clientHandoff?: boolean }

export type WelcomePhase =
  | "loading" // reading the pending sign-in
  | "form" // step 1: choose a name or link an account
  | "signing-in" // a returning coach: completing without a form
  | "done" // signed in: the view navigates to `landing`
  | "handoff" // desktop sign-in authorised: return to the app
  | "missing" // no pending sign-in (expired, or already used)
  | "error"; // a callback error or a refusal before the form

export type Availability = "idle" | "waiting" | "checking" | "available" | "taken" | "invalid" | "error";

export interface WelcomeState {
  phase: WelcomePhase;
  title: string;
  message: string;
  discordUsername: string;
  desktop: boolean;
  /** The desktop sign-in's required coach (the field is read-only then). */
  requested: string;
  name: string;
  password: string;
  /** "I already have a Super FUMBBL account": the password field is open and the submit links. */
  linking: boolean;
  availability: Availability;
  /** The line under the name field (availability, the problem, or the server's refusal of the check). */
  note: string;
  busy: boolean;
  /** A refusal of the submit, shown verbatim. */
  error: string;
  /** Signed-in coach (done / handoff). */
  coach: string;
  landing: string;
}

export function createWelcome(deps: { api: Fetcher; origin?: string }) {
  const state = reactive<WelcomeState>({
    phase: "loading", title: "Checking your Discord sign-in", message: "", discordUsername: "", desktop: false, requested: "",
    name: "", password: "", linking: false, availability: "idle", note: "", busy: false, error: "", coach: "", landing: WELCOME_LANDING,
  });
  let checkSeq = 0;
  let available = false;

  function finish(result: CompleteResult, fallback: string): void {
    state.coach = typeof result.coach === "string" ? result.coach : fallback;
    state.busy = false;
    if (result.clientHandoff === true) {
      state.phase = "handoff";
      state.title = "Sign-in complete";
      state.message = `Authorisation complete for ${state.coach}. Go back to Super FUMBBL: the app is picking up the session now.`;
      return;
    }
    state.phase = "done";
    state.title = `Signed in as ${state.coach}`;
    state.landing = welcomeLanding(result.next);
  }

  const complete = (coach: string, password?: string) =>
    deps.api<CompleteResult>("/api/auth/discord/complete", { method: "POST", body: { ffbCoachId: coach, ...(password ? { password } : {}) } });

  function fail(title: string, message: string): void {
    state.phase = "error";
    state.title = title;
    state.message = message;
    state.busy = false;
  }

  /** Reads the pending sign-in. `search` = location.search (the callback's ?error=). */
  async function init(search = ""): Promise<void> {
    const callback = callbackErrorText(new URLSearchParams(search).get("error"), deps.origin ?? "");
    if (callback) return fail(callback.title, callback.message);
    let pending: PendingDiscord;
    try {
      pending = await deps.api<PendingDiscord>("/api/auth/discord/pending");
    } catch (e) {
      if (statusOf(e) === 404) {
        state.phase = "missing";
        state.title = "No Discord sign-in to finish";
        state.message = "This sign-in has expired or was already used. Sign in with Discord again.";
        return;
      }
      return fail("Discord sign-in unavailable", (e as Error).message || "Can't read your Discord sign-in.");
    }
    const existing = typeof pending.existingFfbCoachId === "string" ? pending.existingFfbCoachId : "";
    const requested = typeof pending.requestedFfbCoachId === "string" ? pending.requestedFfbCoachId : "";
    state.discordUsername = typeof pending.discordUsername === "string" ? pending.discordUsername : "";
    state.desktop = pending.desktop === true;
    state.requested = requested;
    const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
    if (state.desktop && requested && existing && !same(requested, existing))
      return fail("Different coach account", "This Discord account is already linked to a different coach. Sign out and use the matching account.");
    // A returning coach (a confirmed link): no step 1, straight to the session (step 2 follows only if needed).
    if (existing && (!requested || same(existing, requested))) {
      state.phase = "signing-in";
      state.title = `Signing in as ${existing}`;
      state.busy = true;
      try {
        finish(await complete(existing), existing);
      } catch (e) {
        fail("Sign-in refused", (e as Error).message || "Could not finish signing in.");
      }
      return;
    }
    state.phase = "form";
    state.title = requested ? `Link Discord to ${requested}` : "Your coach name";
    state.name = requested || state.discordUsername;
    await check();
  }

  /** The live availability check (the old page's checkAvailability): a newer edit wins over a slower answer. */
  async function check(): Promise<boolean> {
    const coach = state.name.trim();
    const seq = ++checkSeq;
    available = false;
    const problem = coachNameProblem(state.name);
    if (problem) {
      state.availability = "invalid";
      state.note = problem;
      return false;
    }
    state.availability = "checking";
    state.note = "Checking availability…";
    try {
      const result = await deps.api<{ available?: boolean; canLink?: boolean }>(`/api/fork/name-available?coach=${encodeURIComponent(coach)}`);
      if (seq !== checkSeq || coach !== state.name.trim()) return false;
      available = result.available === true;
      if (result.canLink === true) state.linking = true;
      state.availability = available ? "available" : "taken";
      state.note = state.linking
        ? NAME_LINK
        : available ? (state.desktop ? NAME_DESKTOP_MISSING : NAME_AVAILABLE) : NAME_TAKEN;
      return true;
    } catch (e) {
      if (seq !== checkSeq) return false;
      state.availability = "error";
      state.note = (e as Error).message || "Could not check that name.";
      return false;
    }
  }

  /** A keystroke in the name field: forget the last answer (the view debounces the next check). */
  function edited(): void {
    checkSeq++;
    available = false;
    state.password = "";
    state.error = "";
    state.availability = "waiting";
    state.note = coachNameProblem(state.name) || "Waiting to check availability…";
  }

  function setLinking(on: boolean): void {
    state.linking = on;
    state.error = "";
    if (!on) state.password = "";
    if (state.availability === "available" || state.availability === "taken")
      state.note = on ? NAME_LINK : available ? (state.desktop ? NAME_DESKTOP_MISSING : NAME_AVAILABLE) : NAME_TAKEN;
  }

  /** The old page's submit rule: a checked name; a desktop sign-in never creates; linking needs the password. */
  function canSubmit(): boolean {
    if (state.phase !== "form" || state.busy) return false;
    const checked = state.availability === "available" || state.availability === "taken";
    return checked && !(state.desktop && available) && !(state.linking && !state.password);
  }

  async function submit(): Promise<boolean> {
    if (state.phase !== "form" || state.busy) return false;
    state.error = "";
    if (!(state.availability === "available" || state.availability === "taken") && !(await check())) {
      state.error = coachNameProblem(state.name) || "Enter a valid coach name.";
      return false;
    }
    if (state.linking && !state.password) { state.error = PASSWORD_REQUIRED; return false; }
    if (!canSubmit()) return false;
    const coach = state.name.trim();
    state.busy = true;
    state.note = state.linking ? "Checking the password and linking your account…" : available ? "Creating your account…" : "Checking whether this account can be linked…";
    try {
      finish(await complete(coach, state.linking ? state.password : undefined), coach);
      return true;
    } catch (e) {
      state.busy = false;
      state.error = (e as Error).message || "Could not finish signing in.";
      const data = (e as Partial<ApiError> | null)?.data as { canLink?: unknown } | undefined;
      if (data?.canLink === true) {
        available = false;
        state.availability = "taken";
        state.linking = true;
        state.note = NAME_LINK;
      } else {
        state.note = "";
      }
      return false;
    }
  }

  return { state, init, check, edited, setLinking, canSubmit, submit };
}

export type Welcome = ReturnType<typeof createWelcome>;
