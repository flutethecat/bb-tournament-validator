// New-user flow (owner 10-31): the blocking "Welcome to Super FUMBBL" modal. After sign-in the shell reads
// GET /api/me/onboarding; while `needed`, OnboardingDialog.vue sits over every route until POST /api/me/onboarding
// succeeds (or the coach signs out). The checks are the server's own (src/auth/contactSchema.ts, imported, not copied);
// the server stays the authority. No DOM.

import { reactive, type InjectionKey } from "vue";
import type { Fetcher } from "../session";
import { ApiError } from "../shared/api";
import {
  MAX_PHONES, normalizePhoneNumber, parseEmail, parsePreferredName, PHONE_LABELS, PREFERRED_NAME_MAX, type PhoneLabel,
} from "../../../src/auth/contactSchema";
import { dialogKey } from "../teams/manage";

export { MAX_PHONES, PHONE_LABELS, PREFERRED_NAME_MAX };
export type { PhoneLabel };

export const PHONE_HINT = "Start with + and your country code, for example +1 555 123 4567.";
export const EMAIL_UNVERIFIED_NOTE = "We'll verify this address later.";

export interface OnboardingInfo {
  needed: boolean;
  prefill: { preferredName: string; email: string | null; emailSource: "discord" | "user" };
  privacyVersion: string;
  leagueContactText: string;
  leagueContactVersion?: string;
}

export interface PhoneRow { number: string; label: PhoneLabel | "" }

export interface OnboardingForm {
  preferredName: string;
  email: string;
  /** The email field is an input (the coach pressed Edit, or there was no address to show). */
  editingEmail: boolean;
  phones: PhoneRow[];
  leagueContact: boolean;
  privacyAccepted: boolean;
}

export interface OnboardingProblems { preferredName: string; email: string; phones: string[] }

export interface OnboardingState {
  /** The coach the last read was for ("" = none). */
  coach: string;
  info: OnboardingInfo | null;
  form: OnboardingForm;
  busy: boolean;
  error: string;
}

const msg = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return (e as Error).message; } };

/** Per-field problems ("" = fine). An empty phone row is a problem too (remove it or fill it in). */
export function onboardingProblems(form: OnboardingForm): OnboardingProblems {
  return {
    preferredName: msg(() => parsePreferredName(form.preferredName)),
    email: msg(() => parseEmail(form.email)),
    phones: form.phones.map((p, i) => {
      if (!p.number.trim()) return "Enter a number or remove this row.";
      const problem = msg(() => normalizePhoneNumber(p.number));
      if (problem) return problem;
      const n = normalizePhoneNumber(p.number);
      return form.phones.slice(0, i).some((q) => msg(() => normalizePhoneNumber(q.number)) === "" && normalizePhoneNumber(q.number) === n) ? "Listed twice." : "";
    }),
  };
}

/** "Save and continue" is enabled only with a valid form and the privacy notice accepted. */
export function canSubmit(form: OnboardingForm): boolean {
  const p = onboardingProblems(form);
  return form.privacyAccepted && !p.preferredName && !p.email && p.phones.every((x) => !x);
}

export function onboardingBody(form: OnboardingForm, privacyVersion: string) {
  return {
    preferredName: form.preferredName.trim(),
    email: form.email.trim() || null,
    phones: form.phones.map((p) => ({ number: normalizePhoneNumber(p.number), ...(p.label ? { label: p.label } : {}) })),
    leagueContact: form.leagueContact,
    privacyAccepted: form.privacyAccepted,
    privacyVersion,
  };
}

/** The keyboard inside the modal: Tab wraps (dialogKey), Escape does nothing (blocking), shell shortcuts stopped. */
export function onboardingKey<T>(e: { key: string; shiftKey: boolean }, focusables: readonly T[], active: T | null) {
  return dialogKey(e, focusables, active, true);
}

const blankForm = (): OnboardingForm => ({ preferredName: "", email: "", editingEmail: false, phones: [], leagueContact: false, privacyAccepted: false });

export function createOnboarding(deps: { api: Fetcher; onSignedOut?: () => void }) {
  const state = reactive<OnboardingState>({ coach: "", info: null, form: blankForm(), busy: false, error: "" });
  let readFor = "";

  /** Reads GET /api/me/onboarding for the coach (once per coach; "" clears). A failed read leaves no modal: the
   *  server's 428 gate still holds every /api/me write, and the next sign-in or reload asks again. */
  async function load(coach: string): Promise<void> {
    if (coach === readFor) return;
    readFor = coach;
    state.coach = coach;
    state.info = null;
    state.error = "";
    state.form = blankForm();
    if (!coach) return;
    try {
      const info = await deps.api<OnboardingInfo>("/api/me/onboarding");
      if (readFor !== coach) return;
      state.info = info;
      state.form = {
        ...blankForm(),
        preferredName: info.prefill.preferredName ?? "",
        email: info.prefill.email ?? "",
        editingEmail: !info.prefill.email,
      };
    } catch {
      if (readFor === coach) readFor = ""; // retry on the next call
    }
  }

  return {
    state,
    load,
    open: (): boolean => Boolean(state.coach && state.info?.needed),
    problems: (): OnboardingProblems => onboardingProblems(state.form),
    canSubmit: (): boolean => !state.busy && canSubmit(state.form),
    editEmail(): void { state.form.editingEmail = true; },
    addPhone(): void { if (state.form.phones.length < MAX_PHONES) state.form.phones.push({ number: "", label: "mobile" }); },
    removePhone(i: number): void { state.form.phones.splice(i, 1); },
    async submit(): Promise<boolean> {
      if (!state.info || state.busy || !canSubmit(state.form)) return false;
      state.busy = true;
      state.error = "";
      try {
        const info = await deps.api<OnboardingInfo>("/api/me/onboarding", { method: "POST", body: onboardingBody(state.form, state.info.privacyVersion) });
        state.info = info;
        return !info.needed;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) { state.error = "Signed out. Sign in again."; deps.onSignedOut?.(); }
        else state.error = (e as Error).message || "Could not save. Try again.";
        return false;
      } finally {
        state.busy = false;
      }
    },
  };
}

export type Onboarding = ReturnType<typeof createOnboarding>;
export const ONBOARDING_KEY: InjectionKey<Onboarding> = Symbol("onboarding");
