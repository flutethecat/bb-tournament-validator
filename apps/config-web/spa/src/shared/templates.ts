// Competition templates in the SPA (creation wizards v2): the shapes and relative-time helpers come from the server's
// pure module (src/competition/templates.ts); this file adds the /api/templates client used by the Templates list
// (League settings, tournament Manage), the save and share dialogs, New season "From template" and the tournament
// wizard's "Start from template". Rows are what the server sent: a shared template carries no payment links.

import { reactive } from "vue";
import { ApiError } from "./api";
import type { Fetcher } from "../session";
import type { TemplateKind } from "../../../src/competition/templates";

export * from "../../../src/competition/templates";

export interface TemplateShareRow { coach: string; name: string; at: string }
export interface TemplateView {
  id: string;
  kind: TemplateKind;
  name: string;
  description: string;
  /** The caller owns it (may edit, share, delete). */
  mine: boolean;
  /** The owner's account (own) or display name (shared). */
  owner: string;
  /** Owner only. */
  sharedWith?: TemplateShareRow[];
  hasPayLinks?: boolean;
  content: Record<string, any> | null;
  problem?: string;
  summary: Array<{ k: string; v: string }>;
  copiedFrom?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface OrganiserHit { coach: string; name: string }

export interface SaveTemplateInput {
  name: string;
  description?: string;
  includePayLinks?: boolean;
  from?: { leagueId: string; seasonId: string } | { tournamentId: string };
  content?: Record<string, unknown>;
}

export const errorText = (err: unknown, fallback: string): string => (err instanceof ApiError || err instanceof Error ? err.message || fallback : fallback);

/** The Templates controller for one kind: the list, and every action on it. */
export function createTemplates(api: Fetcher, kind: TemplateKind) {
  const state = reactive({ list: [] as TemplateView[], loaded: false, busy: "", error: "", notice: "" });
  const replace = (t: TemplateView): void => {
    const i = state.list.findIndex((x) => x.id === t.id);
    if (i >= 0) state.list.splice(i, 1, t); else state.list.push(t);
  };
  async function run<T>(key: string, task: () => Promise<T>, notice: string): Promise<T | undefined> {
    state.busy = key;
    state.error = "";
    state.notice = "";
    try {
      const out = await task();
      state.notice = notice;
      return out;
    } catch (err) {
      state.error = errorText(err, "That did not work.");
      return undefined;
    } finally {
      state.busy = "";
    }
  }
  return {
    state,
    async load(): Promise<void> {
      try {
        const res = await api<{ templates: TemplateView[] }>(`/api/templates?kind=${kind}`);
        state.list = res.templates ?? [];
        state.error = "";
      } catch (err) {
        state.error = errorText(err, "Can't load the templates.");
      } finally {
        state.loaded = true;
      }
    },
    save: (input: SaveTemplateInput) => run("save", async () => {
      const res = await api<{ template: TemplateView }>("/api/templates", { method: "POST", body: { kind, ...input } });
      replace(res.template);
      return res.template;
    }, "Template saved."),
    rename: (t: TemplateView, name: string, description: string) => run(`rename:${t.id}`, async () => {
      const res = await api<{ template: TemplateView }>(`/api/templates/${t.id}`, { method: "PATCH", body: { revision: t.revision, name, description } });
      replace(res.template);
      return res.template;
    }, "Template renamed."),
    copy: (t: TemplateView) => run(`copy:${t.id}`, async () => {
      const res = await api<{ template: TemplateView }>(`/api/templates/${t.id}/copy`, { method: "POST", body: {} });
      replace(res.template);
      return res.template;
    }, "Copy made. It is yours to change."),
    remove: (t: TemplateView) => run(`remove:${t.id}`, async () => {
      await api(`/api/templates/${t.id}`, { method: "DELETE" });
      state.list = state.list.filter((x) => x.id !== t.id);
      return true;
    }, "Template deleted. Competitions made from it keep their settings."),
    share: (t: TemplateView, coach: string) => run(`share:${t.id}`, async () => {
      const res = await api<{ template: TemplateView }>(`/api/templates/${t.id}/share`, { method: "POST", body: { coach } });
      replace(res.template);
      return res.template;
    }, "Shared. They can use it and make a copy."),
    unshare: (t: TemplateView, coach: string) => run(`share:${t.id}`, async () => {
      const res = await api<{ template: TemplateView }>(`/api/templates/${t.id}/unshare`, { method: "POST", body: { coach } });
      replace(res.template);
      return res.template;
    }, "Stopped sharing. What they already made keeps its settings."),
    async searchOrganisers(q: string): Promise<OrganiserHit[]> {
      if (q.trim().length < 2) return [];
      try { return (await api<{ organisers: OrganiserHit[] }>(`/api/templates/organisers?q=${encodeURIComponent(q.trim())}`)).organisers ?? []; } catch { return []; }
    },
  };
}
export type TemplatesController = ReturnType<typeof createTemplates>;

/** "Yours" or "Shared by <name>". */
export const ownerLine = (t: Pick<TemplateView, "mine" | "owner">): string => (t.mine ? "Yours" : `Shared by ${t.owner}`);
