// Account page "Contact & consent" section: GET/PATCH /api/me/contact (preferred name, email, phones, the league-contact
// consent). Privacy acceptance is read-only here (version + date). Same checks as the onboarding modal
// (src/account/onboarding.ts, from the server's src/auth/contactSchema.ts). No DOM; rendered by AccountContact.vue.

import { reactive } from "vue";
import type { Fetcher } from "../session";
import { ApiError } from "../shared/api";
import { normalizePhoneNumber } from "../../../src/auth/contactSchema";
import { onboardingProblems, type OnboardingProblems, type PhoneLabel, type PhoneRow } from "./onboarding";

export interface ContactInfo {
  preferredName: string;
  email: string | null;
  emailSource: "discord" | "user";
  emailVerified: boolean;
  phones: Array<{ number: string; label?: PhoneLabel }>;
  leagueContact: { granted: boolean; at: string; version: string } | null;
  privacy: { acceptedVersion: string; at: string } | null;
  privacyVersion: string;
  leagueContactText: string;
}

export interface ContactForm { preferredName: string; email: string; phones: PhoneRow[]; leagueContact: boolean }

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
  phones: v.phones.map((p) => ({ number: p.number, label: p.label ?? "" })),
  leagueContact: v.leagueContact?.granted === true,
});

/** "2026-10-31T12:00:00.000Z" -> "2026-10-31" (the date only; "" for none). */
export const dateOf = (iso: string | undefined | null): string => (iso ? iso.slice(0, 10) : "");

export function contactProblems(form: ContactForm): OnboardingProblems {
  return onboardingProblems({ ...form, editingEmail: true, privacyAccepted: true });
}

export function contactBody(form: ContactForm) {
  return {
    preferredName: form.preferredName.trim(),
    email: form.email.trim() || null,
    phones: form.phones.map((p) => ({ number: normalizePhoneNumber(p.number), ...(p.label ? { label: p.label } : {}) })),
    leagueContact: form.leagueContact,
  };
}

export function createContactEditor(deps: { api: Fetcher }) {
  const state = reactive<ContactState>({
    view: null, form: { preferredName: "", email: "", phones: [], leagueContact: false }, loaded: false, loadFailed: false, saving: false, error: "", notice: "",
  });
  const problems = () => contactProblems(state.form);
  const valid = () => { const p = problems(); return !p.preferredName && !p.email && p.phones.every((x) => !x); };
  const dirty = () => Boolean(state.view) && JSON.stringify(contactBodySafe(state.form)) !== JSON.stringify(contactBodySafe(formOf(state.view!)));
  function contactBodySafe(form: ContactForm) {
    try { return contactBody(form); } catch { return form; }
  }
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
    addPhone(): void { if (state.form.phones.length < 3) state.form.phones.push({ number: "", label: "mobile" }); },
    removePhone(i: number): void { state.form.phones.splice(i, 1); },
    async save(): Promise<boolean> {
      state.notice = "";
      if (state.saving) return false;
      if (!valid()) { state.error = "Fix the highlighted fields first."; return false; }
      state.saving = true;
      state.error = "";
      try {
        const v = await deps.api<ContactInfo>("/api/me/contact", { method: "PATCH", body: contactBody(state.form) });
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
