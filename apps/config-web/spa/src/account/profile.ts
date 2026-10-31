// Account page IDENTITY panel: GET/PATCH /api/me/profile (display name, FUMBBL name, NAF name and number; Discord
// read-only) and the coach's own avatar (PUT/DELETE /api/me/avatar, src/coachAvatars.ts: upload > admin-set > Discord). The checks mirror the server's (src/accountProfile.ts), which stays the authority. No DOM;
// rendered by AccountIdentity.vue.

import { reactive } from "vue";
import type { Fetcher } from "../session";
import { createConnectionsController, type ConnectionView } from "./connections";

export interface ProfileView {
  coach: string;
  displayName: string;
  fumbblName: string;
  fumbblLinked: boolean;
  nafName: string;
  nafId: string;
  avatar: string | null;
  /** upload (the coach's own) > profile (admin-set) > discord > none. */
  avatarSource: "upload" | "profile" | "discord" | "none";
  discord: { linked: boolean; username: string };
  /** The Connections table (Discord, NAF, FUMBBL); absent from an older server. */
  connections?: ConnectionView[];
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

/** The coach's own avatar route (PUT a raw image, DELETE to fall back). */
export const OWN_AVATAR_PATH = "/api/me/avatar";

/** What the avatar PUT answers. */
export interface OwnAvatarResult { ok: boolean; status: number; profile?: ProfileView; error?: string }
/** Sends one raw image body (the JSON Fetcher cannot). Replaceable so tests need no network. */
export type OwnAvatarUploader = (body: Blob) => Promise<OwnAvatarResult>;

const defaultUploader: OwnAvatarUploader = async (body) => {
  const res = await fetch(OWN_AVATAR_PATH, { method: "PUT", credentials: "same-origin", headers: { "x-cw-auth": "1", "content-type": body.type }, body });
  const data = (await res.json().catch(() => null)) as { profile?: ProfileView; error?: string } | null;
  return { ok: res.ok, status: res.status, profile: data?.profile, error: data?.error };
};

export interface ProfileState {
  view: ProfileView | null;
  form: ProfileForm;
  problems: ProfileForm;
  loaded: boolean;
  loadFailed: boolean;
  saving: boolean;
  error: string;
  notice: string;
  /** The avatar control: a request in flight, and its last error ("" = none). */
  avatar: { busy: boolean; error: string };
}

const formOf = (v: ProfileView): ProfileForm => ({ displayName: v.displayName, fumbblName: v.fumbblName, nafName: v.nafName, nafId: v.nafId });
const blank = (): ProfileForm => ({ displayName: "", fumbblName: "", nafName: "", nafId: "" });

const sameCoach = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * One editor per signed-in coach. `coach` tags every request; `currentCoach` is the live session coach: a response that
 * lands after the session switched (or that answers for a different coach) is dropped, and a save is refused once the
 * session is no longer the editor's coach. The page recreates the editor on a coach switch.
 */
export function createProfileEditor(deps: { api: Fetcher; coach?: string; currentCoach?: () => string; uploadAvatar?: OwnAvatarUploader }) {
  const state = reactive<ProfileState>({ view: null, form: blank(), problems: blank(), loaded: false, loadFailed: false, saving: false, error: "", notice: "", avatar: { busy: false, error: "" } });
  const uploader = deps.uploadAvatar ?? defaultUploader;
  const tag = deps.coach ?? "";
  /** True when the session moved on from the coach this editor was made for. */
  const stale = () => Boolean(tag && deps.currentCoach && !sameCoach(deps.currentCoach(), tag));
  const foreign = (v: ProfileView | undefined) => Boolean(tag && v && typeof v.coach === "string" && !sameCoach(v.coach, tag));

  async function load(): Promise<void> {
    state.loadFailed = false;
    try {
      const v = await deps.api<ProfileView>("/api/me/profile");
      if (stale() || foreign(v)) return;
      state.view = v;
      state.form = formOf(v);
      state.problems = blank();
      state.error = "";
      state.loaded = true;
    } catch (e) {
      if (stale()) return;
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

  /** A fresh view from a Connections action: the saved values move; a field the coach is editing keeps its text. */
  function adopt(v: ProfileView): boolean {
    if (stale() || foreign(v) || !state.view) return false;
    const before = formOf(state.view);
    const next = formOf(v);
    for (const k of Object.keys(next) as ProfileField[]) if (state.form[k] === before[k]) state.form[k] = next[k];
    state.view = v;
    return true;
  }

  const connections = createConnectionsController<ProfileView>({ api: deps.api, adopt, stale });

  /** The server's view after an avatar change: only the avatar fields move (form edits in progress are kept). */
  function adoptAvatar(v: ProfileView | undefined): void {
    if (!v || stale() || foreign(v) || !state.view) return;
    state.view = { ...state.view, avatar: v.avatar, avatarSource: v.avatarSource };
  }

  async function uploadAvatar(blob: Blob): Promise<boolean> {
    const a = state.avatar;
    if (!state.view || a.busy) return false;
    if (stale()) { a.error = "You are signed in as another coach now. Reload the page."; return false; }
    a.busy = true;
    a.error = "";
    try {
      const res = await uploader(blob);
      if (!res.ok) { a.error = res.error || `Upload failed (${res.status}).`; return false; }
      adoptAvatar(res.profile);
      return true;
    } catch {
      a.error = "Can't reach the server. Check your connection.";
      return false;
    } finally {
      a.busy = false;
    }
  }

  async function removeAvatar(): Promise<boolean> {
    const a = state.avatar;
    if (!state.view || a.busy || state.view.avatarSource !== "upload") return false;
    if (stale()) { a.error = "You are signed in as another coach now. Reload the page."; return false; }
    a.busy = true;
    a.error = "";
    try {
      const res = await deps.api<{ profile?: ProfileView }>(OWN_AVATAR_PATH, { method: "DELETE" });
      adoptAvatar(res?.profile);
      return true;
    } catch (e) {
      a.error = e instanceof Error ? e.message : "Could not remove your avatar.";
      return false;
    } finally {
      a.busy = false;
    }
  }

  return {
    state,
    load,
    changes,
    connections,
    uploadAvatar,
    removeAvatar,
    /** True when the NAF record is Verified and the form changes its name or number (saving clears the check). */
    nafEditClearsVerified(): boolean {
      const c = changes();
      return Boolean(state.view?.connections?.some((r) => r.id === "naf" && r.status === "verified") && (c.nafName !== undefined || c.nafId !== undefined));
    },
    dirty: () => Object.keys(changes()).length > 0,
    edit(field: ProfileField, value: string): void { state.form[field] = value; state.notice = ""; state.problems[field] = ""; },
    async save(): Promise<boolean> {
      if (!state.loaded || state.saving) return false;
      if (stale()) { state.error = "You are signed in as another coach now. Reload the page."; state.notice = ""; return false; }
      state.problems = profileProblems(state.form);
      if (Object.values(state.problems).some(Boolean)) { state.error = "Fix the marked fields."; state.notice = ""; return false; }
      const patch = changes();
      if (!Object.keys(patch).length) { state.error = ""; state.notice = "Nothing to save."; return true; }
      state.saving = true;
      // What the inputs held when the request left: a field edited while it is in flight keeps the newer text.
      const submitted: ProfileForm = { ...state.form };
      try {
        const v = await deps.api<ProfileView>("/api/me/profile", { method: "PATCH", body: patch });
        if (stale() || foreign(v)) return false;
        state.view = v;
        const saved = formOf(v);
        for (const k of Object.keys(saved) as ProfileField[]) if (state.form[k] === submitted[k]) state.form[k] = saved[k];
        state.error = "";
        state.notice = Object.keys(changes()).length ? "Profile saved. Newer changes are not saved yet." : "Profile saved.";
        return true;
      } catch (e) {
        if (stale()) return false;
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
