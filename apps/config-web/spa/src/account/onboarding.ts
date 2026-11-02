// New-user flow (owner 10-31): the blocking "Welcome to Super FUMBBL" modal. After sign-in the shell reads
// GET /api/me/onboarding; while `needed`, OnboardingDialog.vue sits over every route until POST /api/me/onboarding
// succeeds (or the coach signs out). The checks are the server's own (src/auth/contactSchema.ts, imported, not copied);
// the server stays the authority. No DOM.

import { reactive, type InjectionKey } from "vue";
import type { Fetcher } from "../session";
import { ApiError } from "../shared/api";
import {
  MAX_PHONES, nationalPart, normalizePhoneNumber, parseEmail, parsePreferredName, PHONE_LABELS, PREFERRED_NAME_MAX, type PhoneLabel,
} from "../../../src/auth/contactSchema";
import { COUNTRIES, countryByCode, countryByName, type Country } from "../../../src/auth/countries";
import { dialogKey } from "../teams/manage";

export { COUNTRIES, countryByCode, MAX_PHONES, PHONE_LABELS, PREFERRED_NAME_MAX };
export type { Country, PhoneLabel };

export const PHONE_HINT = "Without the country code, for example 555 123 4567. Start with + for a full international number.";
export const COUNTRY_REQUIRED = "Choose your country.";
/** Under the league-contact box: organisers message through the portal; nothing else is shown unless shared. */
export const LEAGUE_CONTACT_HINT = "They don't see your email or phone unless you choose to share it.";

/** The Country field's text after its model changes: a code set from outside shows its name; a code that became ""
 *  while the coach types (the text no longer names a country) keeps the text as typed (review P3). */
export function countryTextAfterModel(text: string, code: string): string {
  if (!code) return text;
  return countryByName(text)?.code === code ? text : countryByCode(code)?.name ?? text;
}

/** The calling-code prefix shown left of the phone field ("+44"); "" when the number is typed with "+" or no country. */
export function phonePrefix(row: Pick<PhoneRow, "number" | "country">, profileCountry: string): string {
  if (row.number.trim().startsWith("+")) return "";
  const c = countryByCode(row.country || profileCountry);
  return c ? `+${c.dial}` : "";
}

/** A stored phone back into the form: the national part for its country, or the full "+..." number. */
export const phoneRowOf = (p: { number: string; country?: string }): PhoneRow =>
  ({ number: p.country ? nationalPart(p) : p.number, country: p.country ?? "" });

/** The phone as the server takes it: the number as typed, and the number's own country when one is set (a saved number
 *  keeps the country it was entered for, so changing the coach's country never changes it). */
export const phoneBody = (p: PhoneRow, _profileCountry?: string) =>
  ({ number: p.number.trim(), ...(p.country && !p.number.trim().startsWith("+") ? { country: p.country } : {}) });
export const EMAIL_UNVERIFIED_NOTE = "We'll verify this address later.";

export interface OnboardingInfo {
  needed: boolean;
  /** An earlier privacy notice was accepted: the dialog is step 2 alone (no coach-name step, no step indicator). */
  reaccept?: boolean;
  prefill: { preferredName: string; email: string | null; emailSource: "discord" | "user"; country?: string | null; phones?: Array<{ number: string; country?: string; label?: PhoneLabel }>; leagueContact?: boolean };
  privacyVersion: string;
  leagueContactText: string;
  leagueContactVersion?: string;
}

/** One phone (owner 10-31: a single optional number). country "" = the coach's own country. */
export interface PhoneRow { number: string; country: string }

export interface OnboardingForm {
  preferredName: string;
  email: string;
  /** The email field is an input (the coach pressed Edit, or there was no address to show). */
  editingEmail: boolean;
  /** ISO alpha-2 ("" = not chosen yet; required to finish onboarding). */
  country: string;
  phones: PhoneRow[];
  leagueContact: boolean;
  privacyAccepted: boolean;
}

export interface OnboardingProblems { preferredName: string; email: string; country: string; phones: string[] }

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
/** The phone row as it was loaded, unchanged (a stored number is checked only when the coach edits it). */
export const samePhone = (a: PhoneRow | undefined, b: PhoneRow | undefined): boolean =>
  Boolean(a && b) && a!.number.trim() === b!.number.trim() && a!.country === b!.country;
export const phonesChanged = (now: readonly PhoneRow[], initial: readonly PhoneRow[]): boolean =>
  now.length !== initial.length || now.some((p, i) => !samePhone(p, initial[i]));

/** Per-field problems ("" = fine). `initialPhones` = the rows as loaded: an unchanged stored phone is not re-checked, so
 *  a number saved under older rules still displays and never blocks an unrelated edit. */
export function onboardingProblems(form: OnboardingForm, initialPhones: readonly PhoneRow[] = []): OnboardingProblems {
  return {
    preferredName: msg(() => parsePreferredName(form.preferredName)),
    email: msg(() => parseEmail(form.email)),
    country: countryByCode(form.country) ? "" : COUNTRY_REQUIRED,
    phones: form.phones.map((p, i) => {
      if (samePhone(p, initialPhones[i])) return "";
      if (!p.number.trim()) return "Enter a number or remove it.";
      return msg(() => normalizePhoneNumber(p.number, p.country || form.country));
    }),
  };
}

/** "Save and continue" is enabled only with a valid form and the privacy notice accepted. */
export function canSubmit(form: OnboardingForm, initialPhones: readonly PhoneRow[] = []): boolean {
  const p = onboardingProblems(form, initialPhones);
  return form.privacyAccepted && !p.preferredName && !p.email && !p.country && p.phones.every((x) => !x);
}

/** The POST body; phones only when the coach changed them (absent = the server keeps the stored number). */
export function onboardingBody(form: OnboardingForm, privacyVersion: string, initialPhones: readonly PhoneRow[] = []) {
  return {
    preferredName: form.preferredName.trim(),
    email: form.email.trim() || null,
    country: form.country,
    ...(phonesChanged(form.phones, initialPhones) ? { phones: form.phones.slice(0, MAX_PHONES).map((p) => phoneBody(p, form.country)) } : {}),
    leagueContact: form.leagueContact,
    privacyAccepted: form.privacyAccepted,
    privacyVersion,
  };
}

/** The keyboard inside the modal: Tab wraps (dialogKey), Escape does nothing (blocking), shell shortcuts stopped. */
export function onboardingKey<T>(e: { key: string; shiftKey: boolean }, focusables: readonly T[], active: T | null) {
  return dialogKey(e, focusables, active, true);
}

const blankForm = (): OnboardingForm => ({ preferredName: "", email: "", editingEmail: false, country: "", phones: [], leagueContact: false, privacyAccepted: false });

export function createOnboarding(deps: { api: Fetcher; onSignedOut?: () => void }) {
  const state = reactive<OnboardingState>({ coach: "", info: null, form: blankForm(), busy: false, error: "" });
  let readFor = "";
  /** The phone rows as loaded (unchanged = not re-checked, not re-sent). */
  let initialPhones: PhoneRow[] = [];

  /** Reads GET /api/me/onboarding for the coach (once per coach; "" clears). A failed read leaves no modal: the
   *  server's 428 gate still holds every /api/me write, and the next sign-in or reload asks again. */
  async function load(coach: string): Promise<void> {
    if (coach === readFor) return;
    readFor = coach;
    state.coach = coach;
    state.info = null;
    state.error = "";
    state.form = blankForm();
    initialPhones = [];
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
        // After a privacy-version bump the stored numbers and choice come back prefilled (never wiped on submit).
        country: info.prefill.country ?? "",
        phones: (info.prefill.phones ?? []).slice(0, MAX_PHONES).map(phoneRowOf),
        leagueContact: info.prefill.leagueContact === true,
      };
      initialPhones = state.form.phones.map((p) => ({ ...p }));
    } catch {
      if (readFor === coach) readFor = ""; // retry on the next call
    }
  }

  return {
    state,
    load,
    open: (): boolean => Boolean(state.coach && state.info?.needed),
    problems: (): OnboardingProblems => onboardingProblems(state.form, initialPhones),
    canSubmit: (): boolean => !state.busy && canSubmit(state.form, initialPhones),
    editEmail(): void { state.form.editingEmail = true; },
    addPhone(): void { if (state.form.phones.length < MAX_PHONES) state.form.phones.push({ number: "", country: "" }); },
    removePhone(i: number): void { state.form.phones.splice(i, 1); },
    async submit(): Promise<boolean> {
      if (!state.info || state.busy || !canSubmit(state.form, initialPhones)) return false;
      state.busy = true;
      state.error = "";
      try {
        const info = await deps.api<OnboardingInfo>("/api/me/onboarding", { method: "POST", body: onboardingBody(state.form, state.info.privacyVersion, initialPhones) });
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
