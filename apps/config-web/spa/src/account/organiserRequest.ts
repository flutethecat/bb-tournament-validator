// "Become an organiser" (registration spec 2026-11-02 §3, Q1): the coach's request page (/app/organiser/request) and the
// site admin queue (/app/admin/organiser-requests). Server: src/organiserRequests.ts. Everything shown is what the server
// sent; the limits below mirror the server's (it re-checks every one).

import { reactive } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";

export type OrganiserRunKind = "league" | "tournament" | "both";
export type OrganiserRequestStatus = "pending" | "approved" | "declined" | "withdrawn";

export interface OrganiserRequestRow {
  id: string;
  coach: string;
  run: OrganiserRunKind;
  competition: string;
  region: string;
  note: string;
  links: string[];
  status: OrganiserRequestStatus;
  createdAt: string;
  closedAt?: string;
  decidedBy?: string;
  reason?: string;
}

export const NOTE_MAX = 500;
export const COMPETITION_MAX = 80;
export const REGION_MAX = 60;
export const LINKS_MAX = 3;
export const REASON_MAX = 300;
export const REQUEST_ROUTE = "/organiser/request";
export const ADMIN_QUEUE_ROUTE = "/admin/organiser-requests";

export const RUN_OPTIONS: ReadonlyArray<{ id: OrganiserRunKind; label: string; line: string; icon: string }> = [
  { id: "league", label: "A league", line: "Seasons, fixtures and standings.", icon: "/icons/panel/leagues.png" },
  { id: "tournament", label: "A tournament", line: "Rounds, pairings and a winner.", icon: "/icons/panel/tournaments.png" },
  { id: "both", label: "Both", line: "Leagues and tournaments.", icon: "/icons/skills/leader.png" },
];
export const RUN_LABEL: Record<OrganiserRunKind, string> = { league: "League", tournament: "Tournament", both: "League and tournament" };
export const STATUS_LABEL: Record<OrganiserRequestStatus, string> = { pending: "Waiting", approved: "Approved", declined: "Declined", withdrawn: "Withdrawn" };
export const STATUS_TONE: Record<OrganiserRequestStatus, string> = { pending: "soon", approved: "ok", declined: "urgent", withdrawn: "muted" };

/** "2 Nov 2026" in the viewer's locale. */
export function shortDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Only http(s) links are rendered as links (the server stores nothing else; this is the second check). */
export const safeHref = (link: string): string | undefined => (/^https?:\/\//i.test(link) ? link : undefined);

const message = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

export interface OrganiserRequestForm { run: OrganiserRunKind | ""; competition: string; region: string; note: string; links: string[] }

export function createOrganiserRequest(deps: { api: Fetcher; onSignedOut?: () => void }) {
  const state = reactive({
    loaded: false, loading: false, error: "", busy: false, formError: "", notice: "",
    organizer: false, request: null as OrganiserRequestRow | null,
    form: { run: "", competition: "", region: "", note: "", links: ["", "", ""] } as OrganiserRequestForm,
  });
  const signedOut = (err: unknown): boolean => {
    if (err instanceof ApiError && err.status === 401) { deps.onSignedOut?.(); return true; }
    return false;
  };

  async function load(): Promise<void> {
    state.loading = true;
    try {
      const res = await deps.api<{ organizer: boolean; request: OrganiserRequestRow | null }>("/api/me/organiser-request");
      state.organizer = res.organizer === true;
      state.request = res.request ?? null;
      state.error = "";
    } catch (err) {
      if (!signedOut(err)) state.error = message(err, "Can't load your request.");
    } finally {
      state.loading = false;
      state.loaded = true;
    }
  }

  /** Client checks that save a round trip; the server repeats them. */
  function problem(): string {
    const f = state.form;
    if (!f.run) return "Choose what you want to run.";
    if (!f.note.trim()) return "Tell the admins a little about what you want to run.";
    if (f.note.length > NOTE_MAX) return `The note must be at most ${NOTE_MAX} characters.`;
    for (const l of f.links.map((x) => x.trim()).filter(Boolean)) if (!/^https?:\/\/\S+$/i.test(l)) return `"${l.slice(0, 40)}" is not a link. Links start with https://.`;
    return "";
  }

  async function submit(): Promise<boolean> {
    if (state.busy) return false;
    state.formError = problem();
    state.notice = "";
    if (state.formError) return false;
    state.busy = true;
    try {
      const f = state.form;
      const res = await deps.api<{ request: OrganiserRequestRow }>("/api/me/organiser-request", {
        method: "POST",
        body: { run: f.run, competition: f.competition, region: f.region, note: f.note, links: f.links.map((x) => x.trim()).filter(Boolean) },
      });
      state.request = res.request;
      state.notice = "Request sent. The admins will look at it soon.";
      state.form = { run: "", competition: "", region: "", note: "", links: ["", "", ""] };
      return true;
    } catch (err) {
      if (!signedOut(err)) state.formError = message(err, "Your request could not be sent.");
      return false;
    } finally {
      state.busy = false;
    }
  }

  async function withdraw(): Promise<boolean> {
    if (state.busy) return false;
    state.busy = true;
    state.formError = "";
    try {
      const res = await deps.api<{ request: OrganiserRequestRow }>("/api/me/organiser-request", { method: "DELETE" });
      state.request = res.request;
      state.notice = "Request withdrawn.";
      return true;
    } catch (err) {
      if (!signedOut(err)) state.formError = message(err, "Your request could not be withdrawn.");
      return false;
    } finally {
      state.busy = false;
    }
  }

  return { state, load, submit, withdraw, problem };
}

export type OrganiserRequestPage = ReturnType<typeof createOrganiserRequest>;

export type QueueView = "pending" | "closed";

export function createOrganiserQueue(deps: { api: Fetcher; onSignedOut?: () => void }) {
  const state = reactive({
    view: "pending" as QueueView, loaded: false, loading: false, error: "", pending: 0,
    requests: [] as OrganiserRequestRow[], busy: "", reason: {} as Record<string, string>, rowError: {} as Record<string, string>, notice: "",
  });
  let gen = 0;
  const signedOut = (err: unknown): boolean => {
    if (err instanceof ApiError && err.status === 401) { deps.onSignedOut?.(); return true; }
    return false;
  };

  async function load(view: QueueView = state.view): Promise<void> {
    const mine = ++gen;
    state.view = view;
    state.loading = true;
    try {
      const res = await deps.api<{ requests: OrganiserRequestRow[]; pending: number }>(`/api/admin/organiser-requests?status=${view}`);
      if (mine !== gen) return;
      state.requests = res.requests ?? [];
      state.pending = res.pending ?? 0;
      state.error = "";
    } catch (err) {
      if (mine !== gen) return;
      state.requests = [];
      if (!signedOut(err)) state.error = message(err, "Can't load organiser requests.");
    } finally {
      if (mine === gen) { state.loading = false; state.loaded = true; }
    }
  }

  async function decide(row: OrganiserRequestRow, decision: "approve" | "decline"): Promise<boolean> {
    if (state.busy) return false;
    const reason = (state.reason[row.id] ?? "").trim();
    if (reason.length > REASON_MAX) { state.rowError = { ...state.rowError, [row.id]: `The reason must be at most ${REASON_MAX} characters.` }; return false; }
    state.busy = row.id;
    state.rowError = { ...state.rowError, [row.id]: "" };
    state.notice = "";
    try {
      await deps.api(`/api/admin/organiser-requests/${encodeURIComponent(row.id)}/${decision}`, { method: "POST", body: reason ? { reason } : {} });
      state.notice = decision === "approve" ? `${row.coach} is now an organiser.` : `Declined ${row.coach}'s request.`;
      delete state.reason[row.id];
      await load();
      return true;
    } catch (err) {
      if (!signedOut(err)) state.rowError = { ...state.rowError, [row.id]: message(err, "That did not work.") };
      return false;
    } finally {
      state.busy = "";
    }
  }

  return { state, load, decide };
}

export type OrganiserQueue = ReturnType<typeof createOrganiserQueue>;
