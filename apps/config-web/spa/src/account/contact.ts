// Account page "Contact & consent" section: GET/PATCH /api/me/contact (preferred name, email, phones, the league-contact
// consent). Privacy acceptance is read-only here (version + date). Same checks as the onboarding modal
// (src/account/onboarding.ts, from the server's src/auth/contactSchema.ts). No DOM; rendered by AccountContact.vue.

import { reactive } from "vue";
import type { Fetcher } from "../session";
import { ApiError } from "../shared/api";
import { MAX_PHONES } from "../../../src/auth/contactSchema";
import { onboardingProblems, phoneBody, phonesChanged, phoneRowOf, type OnboardingProblems, type PhoneLabel, type PhoneRow } from "./onboarding";

export interface ContactInfo {
  preferredName: string;
  email: string | null;
  emailSource: "discord" | "user";
  emailVerified: boolean;
  country: string | null;
  phones: Array<{ number: string; country?: string; label?: PhoneLabel }>;
  leagueContact: { granted: boolean; at: string; version: string } | null;
  privacy: { acceptedVersion: string; at: string } | null;
  privacyVersion: string;
  leagueContactText: string;
}

export interface ContactForm { preferredName: string; email: string; country: string; phones: PhoneRow[]; leagueContact: boolean }

export interface ContactState {
  view: ContactInfo | null;
  form: ContactForm;
  loaded: boolean;
  loadFailed: boolean;
  saving: boolean;
  error: string;
  notice: string;
}

const formOf = (v: ContactInfo): ContactForm => ({
  preferredName: v.preferredName,
  email: v.email ?? "",
  country: v.country ?? "",
  phones: v.phones.slice(0, MAX_PHONES).map(phoneRowOf),
  leagueContact: v.leagueContact?.granted === true,
});

/** "2026-10-31T12:00:00.000Z" -> "2026-10-31" (the date only; "" for none). */
export const dateOf = (iso: string | undefined | null): string => (iso ? iso.slice(0, 10) : "");

/** Country is not required here (coaches onboarded before it existed are not re-gated), except to add a phone. */
export function contactProblems(form: ContactForm, view?: ContactInfo | null): OnboardingProblems {
  // The stored phone is checked only when the coach changes it (an old number never blocks a name edit).
  const initial = view ? formOf(view).phones : [];
  const p = onboardingProblems({ ...form, editingEmail: true, privacyAccepted: true }, initial);
  const country = form.country ? p.country : phonesChanged(form.phones, initial) && form.phones.length ? "Choose your country first." : "";
  return { ...p, country };
}

export function contactBody(form: ContactForm) {
  return {
    preferredName: form.preferredName.trim(),
    email: form.email.trim() || null,
    ...(form.country ? { country: form.country } : {}),
    phones: form.phones.slice(0, MAX_PHONES).map((p) => phoneBody(p, form.country)),
    leagueContact: form.leagueContact,
  };
}

type ContactBody = ReturnType<typeof contactBody>;
/** Only the fields that differ from what the server last answered: a name edit never resubmits consent or phones. */
export function changedFields(form: ContactForm, view: ContactInfo): Partial<ContactBody> {
  const next = contactBody(form);
  const was = contactBody(formOf(view));
  const out: Partial<ContactBody> = {};
  for (const key of Object.keys(next) as Array<keyof ContactBody>) {
    if (JSON.stringify(next[key]) !== JSON.stringify(was[key])) (out as Record<string, unknown>)[key] = next[key];
  }
  return out;
}

export function createContactEditor(deps: { api: Fetcher }) {
  const state = reactive<ContactState>({
    view: null, form: { preferredName: "", email: "", country: "", phones: [], leagueContact: false }, loaded: false, loadFailed: false, saving: false, error: "", notice: "",
  });
  const problems = () => contactProblems(state.form, state.view);
  const valid = () => { const p = problems(); return !p.preferredName && !p.email && !p.country && p.phones.every((x) => !x); };
  const dirty = () => {
    if (!state.view) return false;
    try { return Object.keys(changedFields(state.form, state.view)).length > 0; } catch { return true; }
  };
  return {
    state,
    problems,
    valid,
    dirty,
    async load(): Promise<void> {
      try {
        const v = await deps.api<ContactInfo>("/api/me/contact");
        state.view = v;
        state.form = formOf(v);
        state.loaded = true;
        state.loadFailed = false;
        state.error = "";
      } catch (e) {
        state.loadFailed = true;
        state.error = (e as Error).message || "Can't load your contact details.";
      }
    },
    addPhone(): void { if (state.form.phones.length < MAX_PHONES) state.form.phones.push({ number: "", country: "" }); },
    removePhone(i: number): void { state.form.phones.splice(i, 1); },
    async save(): Promise<boolean> {
      state.notice = "";
      if (state.saving) return false;
      if (!valid()) { state.error = "Fix the highlighted fields first."; return false; }
      if (!state.view) return false;
      const body = changedFields(state.form, state.view);
      if (!Object.keys(body).length) { state.notice = "Nothing to save."; return true; }
      state.saving = true;
      state.error = "";
      try {
        const v = await deps.api<ContactInfo>("/api/me/contact", { method: "PATCH", body });
        state.view = v;
        state.form = formOf(v);
        state.notice = "Saved.";
        return true;
      } catch (e) {
        state.error = e instanceof ApiError && e.status === 428 ? "Complete the welcome form first." : (e as Error).message || "Could not save. Try again.";
        return false;
      } finally {
        state.saving = false;
      }
    },
  };
}

export type ContactEditor = ReturnType<typeof createContactEditor>;
