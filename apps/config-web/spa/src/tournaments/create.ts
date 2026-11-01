// Create Tournament (owner 10-30): the dialog's controller, shared by the Tournaments page CREATE button and the
// account menu's "Create tournament" item. One POST /api/tournaments (the same route and body the old
// tournaments.html "Create Draft" form sends); the new draft opens on its Manage tab with a one-time notice.

import { reactive, type InjectionKey } from "vue";
import { ApiError, type TournamentSummary } from "../shared/api";
import { writesAllowed, type Fetcher, type SessionStore } from "../session";
import type { TournamentPrimaryTiebreaker } from "./detail";

export type TournamentFormat = TournamentSummary["format"];
export const FORMAT_OPTIONS: ReadonlyArray<{ id: TournamentFormat; label: string }> = [
  { id: "swiss", label: "Swiss" }, { id: "roundRobin", label: "Round-Robin" }, { id: "knockout", label: "Knockout" },
];
export const CREATED_NOTICE = "Tournament created as a draft.";

/**
 * Who may create: exactly the server's gate for POST /api/tournaments (src/tournaments/api.ts: `identity.organizer`,
 * the session's organizer flag), on a Discord session the SPA counts as signed in, and never a test sign-in session
 * (the server refuses every tournament write from one).
 */
export function canCreateTournament(session: SessionStore): boolean {
  return session.signedIn() && session.state.info?.organizer === true && writesAllowed(session);
}

export interface CreateTournamentForm {
  name: string;
  packageName: string;
  maxPlayers: number | "";
  format: TournamentFormat;
  /** Swiss only; blank = Auto (the server works it out from the field). */
  roundCount: number | "";
  primaryTiebreaker: TournamentPrimaryTiebreaker;
  /** NAF sanctioned (owner 10-31): registration then needs a NAF number or "I am not a NAF member". */
  nafSanctioned?: boolean;
}

/** The POST /api/tournaments body: name, packageName, maxPlayers, format, primaryTiebreaker, and roundCount for Swiss when set. */
export interface CreateTournamentBody {
  name: string;
  packageName: string;
  maxPlayers: number;
  format: TournamentFormat;
  primaryTiebreaker: TournamentPrimaryTiebreaker;
  roundCount?: number;
  nafSanctioned?: true;
}

const blankForm = (): CreateTournamentForm => ({ name: "", packageName: "", maxPlayers: 8, format: "swiss", roundCount: "", primaryTiebreaker: "buchholz", nafSanctioned: false });

export function createBody(form: CreateTournamentForm): CreateTournamentBody {
  const body: CreateTournamentBody = {
    name: form.name.trim(),
    packageName: form.packageName,
    maxPlayers: Number(form.maxPlayers),
    format: form.format,
    primaryTiebreaker: form.primaryTiebreaker,
  };
  if (form.format === "swiss" && form.roundCount !== "" && form.roundCount !== null && form.roundCount !== undefined) body.roundCount = Number(form.roundCount);
  if (form.nafSanctioned) body.nafSanctioned = true;
  return body;
}

/** The same checks the server makes, before sending; the server's own message wins when it still refuses. */
export function formProblem(form: CreateTournamentForm): string {
  const name = form.name.trim();
  if (!name) return "Enter a name.";
  if (name.length > 100) return "The name can be at most 100 characters.";
  if (!form.packageName) return "Choose a ruleset.";
  const max = Number(form.maxPlayers);
  if (form.maxPlayers === "" || !Number.isSafeInteger(max) || max < 2) return "Max players must be a whole number of at least 2.";
  if (form.format === "swiss" && form.roundCount !== "") {
    const rounds = Number(form.roundCount);
    if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 50) return "Rounds must be a whole number from 1 to 50 (or blank for Auto).";
  }
  return "";
}

export interface CreateTournamentState {
  open: boolean;
  form: CreateTournamentForm;
  packages: string[];
  packagesStatus: "idle" | "loading" | "ready" | "error";
  busy: boolean;
  error: string;
  /** The last submit came back 401: the dialog offers the sign-in link next to the error. */
  signedOut: boolean;
  /** One-time notice for the tournament just created; the detail page shows it, then clears it. */
  created: { id: string; notice: string } | null;
}

export function createTournamentCreator(deps: { api: Fetcher; onSignedOut?: () => void; onCreated?: () => void }) {
  const state = reactive<CreateTournamentState>({
    open: false, form: blankForm(), packages: [], packagesStatus: "idle", busy: false, error: "", signedOut: false, created: null,
  });

  // Refetched on every open (a ruleset saved in another tab shows up); the last list stays on screen while it loads.
  let inflight: Promise<void> | undefined;
  function loadPackages(): Promise<void> {
    inflight ??= fetchPackages().finally(() => { inflight = undefined; });
    return inflight;
  }
  async function fetchPackages(): Promise<void> {
    state.packagesStatus = "loading";
    try {
      const list = await deps.api<unknown>("/api/packages");
      state.packages = (Array.isArray(list) ? list : [])
        .map((entry) => (entry && typeof entry === "object" ? String((entry as { name?: unknown }).name ?? "") : ""))
        .filter(Boolean);
      state.packagesStatus = "ready";
      if (!state.packages.includes(state.form.packageName)) state.form.packageName = state.packages[0] ?? "";
    } catch {
      state.packagesStatus = state.packages.length ? "ready" : "error";
    }
  }

  return {
    state,
    show(): void {
      state.form = blankForm();
      state.form.packageName = state.packages[0] ?? "";
      state.error = "";
      state.signedOut = false;
      state.open = true;
      void loadPackages();
    },
    close(): void { if (!state.busy) state.open = false; },
    loadPackages,
    /** POST /api/tournaments. Resolves to the new id (the dialog closes), or undefined with `error` set (the dialog stays). */
    async submit(): Promise<string | undefined> {
      if (state.busy) return undefined;
      const problem = formProblem(state.form);
      if (problem) { state.error = problem; return undefined; }
      state.busy = true;
      state.error = "";
      state.signedOut = false;
      try {
        const res = await deps.api<{ tournament?: { id?: unknown } }>("/api/tournaments", { method: "POST", body: createBody(state.form) });
        const id = typeof res?.tournament?.id === "string" ? res.tournament.id : "";
        if (!id) { state.error = "The server did not return the new tournament."; return undefined; }
        state.created = { id, notice: CREATED_NOTICE };
        state.open = false;
        deps.onCreated?.();
        return id;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          deps.onSignedOut?.();
          state.signedOut = true;
          state.error = "Signed out. Sign in and try again.";
        } else {
          state.error = err instanceof Error ? err.message : "Can't create the tournament.";
        }
        return undefined;
      } finally {
        state.busy = false;
      }
    },
    /** The notice for `id` once (the detail page reads it on arrival). */
    takeNotice(id: string): string {
      if (!state.created || state.created.id !== id) return "";
      const { notice } = state.created;
      state.created = null;
      return notice;
    },
  };
}

export type TournamentCreator = ReturnType<typeof createTournamentCreator>;
export const TOURNAMENT_CREATOR_KEY: InjectionKey<TournamentCreator> = Symbol("tournament-creator");

/** Where the new draft opens: its Manage tab. */
export const createdLocation = (id: string) => ({ name: "tournament-detail", params: { id }, query: { tab: "manage" } });
