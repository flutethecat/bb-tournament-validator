// Per-organiser sharing (owner 10-31): GET /api/me/sharing lists the leagues the coach has joined and the tournaments
// they are entered in, with what each one's organisers can see (preferred name / email / phone); saving a row is
// PUT /api/me/sharing/<scope> { fields }. Default = nothing. The Account page's Sharing panel (AccountSharing.vue) and the
// tournament registration picker (TournamentMyEntry.vue) use it. No DOM.

import { reactive } from "vue";
import type { Fetcher } from "../session";
import { ApiError } from "../shared/api";
import { SHARE_FIELDS, type ShareField } from "../../../src/auth/contactSchema";

export { SHARE_FIELDS };
export type { ShareField };

export const SHARING_PATH = "/api/me/sharing";
export const SHARE_LABEL: Record<ShareField, string> = { preferredName: "Preferred name", email: "Email", phone: "Phone" };
export const NO_PHONE_NOTE = "No phone on file";
export const NO_EMAIL_NOTE = "No email on file";

export interface SharingRow {
  scope: string;
  kind: "league" | "tournament";
  id: string;
  name: string;
  fields: ShareField[];
  previous?: ShareField[];
  at?: string;
}

export interface SharingInfo {
  version: string;
  text: string;
  phoneOnFile: boolean;
  emailOnFile: boolean;
  /** The NAF details on the coach's profile (shared with organisers of NAF-sanctioned tournaments they enter). */
  nafNumber?: string;
  nafName?: string;
  nafChecked?: boolean;
  scopes: SharingRow[];
}

export interface SharingState {
  info: SharingInfo | null;
  /** Scope -> the boxes as ticked (starts from the saved fields, or the earlier choice to confirm). */
  draft: Record<string, ShareField[]>;
  loaded: boolean;
  loadFailed: boolean;
  busy: string;
  error: string;
  notice: string;
}

/** The boxes a row starts with: what is shared now, else the earlier choice (pre-ticked; the coach confirms it). */
export const startingFields = (row: SharingRow): ShareField[] => (row.fields.length ? [...row.fields] : [...(row.previous ?? [])]);

/** Toggle one field, keeping SHARE_FIELDS order. */
export function toggleField(fields: readonly ShareField[], field: ShareField, on: boolean): ShareField[] {
  const set = new Set(fields);
  if (on) set.add(field); else set.delete(field);
  return SHARE_FIELDS.filter((f) => set.has(f));
}

export const sameFields = (a: readonly ShareField[], b: readonly ShareField[]): boolean => a.join(",") === b.join(",");

/** A box the coach cannot tick: nothing on file to share. */
export function fieldDisabled(info: Pick<SharingInfo, "phoneOnFile" | "emailOnFile"> | null, field: ShareField): boolean {
  if (!info) return false;
  return (field === "phone" && !info.phoneOnFile) || (field === "email" && !info.emailOnFile);
}

export function createSharing(deps: { api: Fetcher }) {
  const state = reactive<SharingState>({ info: null, draft: {}, loaded: false, loadFailed: false, busy: "", error: "", notice: "" });
  const adopt = (info: SharingInfo) => {
    state.info = info;
    state.draft = Object.fromEntries((info.scopes ?? []).map((r) => [r.scope, startingFields(r)]));
  };
  return {
    state,
    async load(): Promise<void> {
      try {
        adopt(await deps.api<SharingInfo>(SHARING_PATH));
        state.loaded = true;
        state.loadFailed = false;
        state.error = "";
      } catch (e) {
        state.loadFailed = true;
        state.error = (e as Error).message || "Can't load your sharing choices.";
      }
    },
    set(scope: string, field: ShareField, on: boolean): void {
      state.draft[scope] = toggleField(state.draft[scope] ?? [], field, on);
      state.notice = "";
    },
    /** The row differs from what organisers see now (an unconfirmed earlier choice counts as a change). */
    dirty(row: SharingRow): boolean { return !sameFields(state.draft[row.scope] ?? [], row.fields) || Boolean(row.previous && !row.fields.length); },
    async save(row: SharingRow): Promise<boolean> {
      if (state.busy) return false;
      state.busy = row.scope;
      state.error = "";
      state.notice = "";
      try {
        adopt(await deps.api<SharingInfo>(`${SHARING_PATH}/${encodeURIComponent(row.scope)}`, { method: "PUT", body: { fields: state.draft[row.scope] ?? [] } }));
        state.notice = `Saved for ${row.name}.`;
        return true;
      } catch (e) {
        state.error = e instanceof ApiError && e.status === 428 ? "Complete the welcome form first." : (e as Error).message || "Could not save. Try again.";
        return false;
      } finally {
        state.busy = "";
      }
    },
  };
}

export type Sharing = ReturnType<typeof createSharing>;
