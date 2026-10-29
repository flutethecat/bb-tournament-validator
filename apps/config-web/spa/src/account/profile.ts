// Account page IDENTITY panel: GET/PATCH /api/me/profile (display name, FUMBBL name, NAF name and number; avatar and
// Discord read-only). The checks mirror the server's (src/accountProfile.ts), which stays the authority. No DOM;
// rendered by AccountIdentity.vue.

import { reactive } from "vue";
import type { Fetcher } from "../session";

export interface ProfileView {
  coach: string;
  displayName: string;
  fumbblName: string;
  fumbblLinked: boolean;
  nafName: string;
  nafId: string;
  avatar: string | null;
  avatarSource: "profile" | "discord" | "none";
  discord: { linked: boolean; username: string };
}

export type ProfileField = "displayName" | "fumbblName" | "nafName" | "nafId";
export type ProfileForm = Record<ProfileField, string>;

export const DISPLAY_NAME_MAX = 32;
export const FUMBBL_NAME_MAX = 40;
export const NAF_NAME_MAX = 60;
const DISPLAY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;
const FUMBBL_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

const clean = (v: string) => v.normalize("NFC").trim().replace(/\s+/g, " ");

/** Per-field problems ("" = fine), same rules as the server. */
export function profileProblems(form: ProfileForm): ProfileForm {
  const d = clean(form.displayName);
  const f = clean(form.fumbblName);
  const n = clean(form.nafName);
  const id = form.nafId.trim();
  return {
    displayName: !d ? "" : d.length < 2 ? "At least 2 characters." : d.length > DISPLAY_NAME_MAX ? `At most ${DISPLAY_NAME_MAX} characters.` : DISPLAY_NAME.test(d) ? "" : "Letters, digits, spaces and . _ ' - only.",
    fumbblName: !f ? "" : f.length > FUMBBL_NAME_MAX ? `At most ${FUMBBL_NAME_MAX} characters.` : FUMBBL_NAME.test(f) ? "" : "Letters, digits, spaces and . _ - only.",
    nafName: !n ? "" : n.length > NAF_NAME_MAX ? `At most ${NAF_NAME_MAX} characters.` : DISPLAY_NAME.test(n) ? "" : "Letters, digits, spaces and . _ ' - only.",
    nafId: !id || /^\d{1,10}$/.test(id) ? "" : "1 to 10 digits.",
  };
}

export interface ProfileState {
  view: ProfileView | null;
  form: ProfileForm;
  problems: ProfileForm;
  loaded: boolean;
  loadFailed: boolean;
  saving: boolean;
  error: string;
  notice: string;
}

const formOf = (v: ProfileView): ProfileForm => ({ displayName: v.displayName, fumbblName: v.fumbblName, nafName: v.nafName, nafId: v.nafId });
const blank = (): ProfileForm => ({ displayName: "", fumbblName: "", nafName: "", nafId: "" });

export function createProfileEditor(deps: { api: Fetcher }) {
  const state = reactive<ProfileState>({ view: null, form: blank(), problems: blank(), loaded: false, loadFailed: false, saving: false, error: "", notice: "" });

  async function load(): Promise<void> {
    state.loadFailed = false;
    try {
      const v = await deps.api<ProfileView>("/api/me/profile");
      state.view = v;
      state.form = formOf(v);
      state.problems = blank();
      state.error = "";
      state.loaded = true;
    } catch (e) {
      state.loaded = false;
      state.loadFailed = true;
      state.error = `Can't load your profile: ${e instanceof Error ? e.message : "try again."}`;
    }
  }

  /** Fields whose value differs from the saved one (a linked FUMBBL name is never sent). */
  function changes(): Partial<ProfileForm> {
    const v = state.view;
    if (!v) return {};
    const out: Partial<ProfileForm> = {};
    for (const k of ["displayName", "fumbblName", "nafName", "nafId"] as const) {
      if (k === "fumbblName" && v.fumbblLinked) continue;
      const next = k === "nafId" ? state.form[k].trim() : clean(state.form[k]);
      if (next !== v[k]) out[k] = next;
    }
    return out;
  }

  return {
    state,
    load,
    changes,
    dirty: () => Object.keys(changes()).length > 0,
    edit(field: ProfileField, value: string): void { state.form[field] = value; state.notice = ""; state.problems[field] = ""; },
    async save(): Promise<boolean> {
      if (!state.loaded || state.saving) return false;
      state.problems = profileProblems(state.form);
      if (Object.values(state.problems).some(Boolean)) { state.error = "Fix the marked fields."; state.notice = ""; return false; }
      const patch = changes();
      if (!Object.keys(patch).length) { state.error = ""; state.notice = "Nothing to save."; return true; }
      state.saving = true;
      try {
        const v = await deps.api<ProfileView>("/api/me/profile", { method: "PATCH", body: patch });
        state.view = v;
        state.form = formOf(v);
        state.error = "";
        state.notice = "Profile saved.";
        return true;
      } catch (e) {
        state.error = e instanceof Error ? e.message : "Can't save your profile.";
        state.notice = "";
        return false;
      } finally {
        state.saving = false;
      }
    },
  };
}

export type ProfileEditor = ReturnType<typeof createProfileEditor>;
