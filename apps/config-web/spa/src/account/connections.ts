// Account page CONNECTIONS table (inside the Identity panel): one row per provider, rendered from the server's
// ConnectionView list (GET /api/me/profile .connections, src/auth/connections.ts), so a new provider (a real NAF OAuth
// one day) needs no change here. This controller runs the row actions: the inline link form (POST to the row's
// endpoint), Re-verify (POST with the saved values) and Unlink (DELETE). No DOM; AccountIdentity.vue renders it.
//
// The NAF has no sign-in or OAuth: "Verified" means the public NAF coach page exists and matches, not ownership.

import { reactive } from "vue";
import type { Fetcher } from "../session";

export type ConnectionStatus = "linked" | "not_linked" | "verified";
export type ConnectionAction = "link" | "unlink" | "reverify";
export interface ConnectionField { name: string; label: string; inputmode: "text" | "numeric"; maxlength: number; value: string }
export type ConnectionLinkVia =
  | { mode: "form"; endpoint: string; fields: ConnectionField[] }
  | { mode: "redirect"; href: string }
  | { mode: "field"; field: "fumbblName" };

export interface ConnectionView {
  id: string;
  label: string;
  kind: "oauth" | "lookup" | "claim";
  icon: string;
  status: ConnectionStatus;
  identity: string;
  note: string;
  actions: ConnectionAction[];
  linkVia?: ConnectionLinkVia;
  locked?: boolean;
  verifiedAt?: string;
}

export const STATUS_LABEL: Record<ConnectionStatus, string> = { linked: "Linked", not_linked: "Not linked", verified: "Verified" };
export const STATUS_TONE: Record<ConnectionStatus, string> = { linked: "hm-chip-ok", not_linked: "hm-chip-overdue", verified: "hm-chip-ok" };

/** The button text of a row action. */
export function actionLabel(row: ConnectionView, action: ConnectionAction): string {
  if (action === "unlink") return "Unlink";
  if (action === "reverify") return "Re-verify";
  if (row.linkVia?.mode === "field") return row.identity ? "Edit" : "Link";
  return `Link ${row.label} account`;
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;
const DIGITS = /^\d{1,10}$/;

/** Local checks for a link form (the server stays the authority). */
export function linkProblems(fields: ConnectionField[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = (values[f.name] ?? "").trim();
    if (!v) out[f.name] = `Enter your ${f.label}.`;
    else if (v.length > f.maxlength) out[f.name] = `At most ${f.maxlength} characters.`;
    else if (f.inputmode === "numeric" ? !DIGITS.test(v) : !NAME.test(v)) out[f.name] = f.inputmode === "numeric" ? "1 to 10 digits." : "Letters, digits, spaces and . _ ' - only.";
  }
  return out;
}

export interface ConnectionsState {
  /** The row whose inline link form is open ("" = none). */
  open: string;
  values: Record<string, string>;
  problems: Record<string, string>;
  busy: string;
  error: string;
  notice: string;
}

export function createConnectionsController<V>(deps: {
  api: Fetcher;
  /** Takes the server's fresh profile view; false when it was dropped (session moved on). */
  adopt: (view: V) => boolean;
  /** True when the session is no longer the editor's coach. */
  stale: () => boolean;
  /** Focus the profile field a "field" row links through (FUMBBL name). */
  focusField?: (field: string) => void;
}) {
  const state = reactive<ConnectionsState>({ open: "", values: {}, problems: {}, busy: "", error: "", notice: "" });

  const formOf = (row: ConnectionView) => (row.linkVia?.mode === "form" ? row.linkVia : undefined);

  async function send(row: ConnectionView, method: "POST" | "DELETE", body: Record<string, string> | undefined, done: string): Promise<boolean> {
    const form = formOf(row);
    if (!form || state.busy) return false;
    if (deps.stale()) { state.error = "You are signed in as another coach now. Reload the page."; state.notice = ""; return false; }
    state.busy = row.id;
    state.error = "";
    state.notice = "";
    try {
      const v = await deps.api<V>(form.endpoint, { method, ...(body ? { body } : {}) });
      if (!deps.adopt(v)) return false;
      state.open = "";
      state.problems = {};
      state.notice = done;
      return true;
    } catch (e) {
      if (deps.stale()) return false;
      state.error = e instanceof Error ? e.message : "Something went wrong. Try again.";
      return false;
    } finally {
      state.busy = "";
    }
  }

  return {
    state,
    /** Link: open the inline form (prefilled with the saved values), follow a redirect provider, or focus the profile field. */
    link(row: ConnectionView): void {
      const via = row.linkVia;
      if (!via) return;
      state.error = "";
      state.notice = "";
      if (via.mode === "field") { deps.focusField?.(via.field); return; }
      if (via.mode === "redirect") { if (typeof window !== "undefined") window.location.assign(via.href); return; }
      state.open = row.id;
      state.values = Object.fromEntries(via.fields.map((f) => [f.name, f.value]));
      state.problems = {};
    },
    cancel(): void { state.open = ""; state.problems = {}; state.error = ""; },
    set(name: string, value: string): void { state.values[name] = value; delete state.problems[name]; state.notice = ""; },
    /** Submits the open link form after the local checks. */
    async submit(row: ConnectionView): Promise<boolean> {
      const form = formOf(row);
      if (!form || state.open !== row.id) return false;
      state.problems = linkProblems(form.fields, state.values);
      if (Object.keys(state.problems).length) { state.error = "Fix the marked fields."; state.notice = ""; return false; }
      const body = Object.fromEntries(form.fields.map((f) => [f.name, (state.values[f.name] ?? "").trim()]));
      return send(row, "POST", body, `${row.label} record checked: it exists and matches.`);
    },
    /** Re-verify with the saved values. */
    reverify(row: ConnectionView): Promise<boolean> {
      const form = formOf(row);
      if (!form) return Promise.resolve(false);
      return send(row, "POST", Object.fromEntries(form.fields.map((f) => [f.name, f.value])), `${row.label} record checked again: it still matches.`);
    },
    unlink(row: ConnectionView): Promise<boolean> {
      return send(row, "DELETE", undefined, `${row.label} record unlinked.`);
    },
  };
}

export type ConnectionsController = ReturnType<typeof createConnectionsController>;
