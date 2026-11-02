// "Get started" panel on the coach page (spec-registration-creation-flows 11-02 §3 step 5). GET /api/me/get-started says
// which of the four next steps are done (derived on the server, never stored) and whether the coach hid the panel; Hide
// POSTs { hidden: true } so the choice follows the coach to every device. If that write fails (offline, 428), the choice
// is kept in this browser's localStorage instead (wrapped: storage may be blocked). No DOM: HomeGetStarted.vue renders it.

import { reactive } from "vue";
import type { Fetcher } from "../session";

export type GetStartedStep = "league" | "tournament" | "team" | "organiser";
export interface GetStartedView {
  done: Record<GetStartedStep, boolean>;
  doneCount: number;
  total: number;
  hidden: boolean;
  show: boolean;
}

export interface GetStartedCard {
  id: GetStartedStep;
  icon: string;
  title: string;
  line: string;
  /** Router path; null = no page to open (the card is information only). */
  to: string | null;
}

/** The organiser-request page (lane L2: Account -> "Organiser"). Linked only once the server answers its read. */
export const ORGANISER_REQUEST_TO = "/account#organiser";
export const ORGANISER_REQUEST_PROBE = "/api/me/organiser-request";
export const GET_STARTED_HIDDEN_STORAGE = "cw.getStartedHidden";

export function getStartedCards(organiserRequests: boolean): GetStartedCard[] {
  return [
    { id: "league", icon: "leagues", title: "Join a league", line: "Find a league that's taking new coaches.", to: "/leagues?registration=open" },
    { id: "tournament", icon: "tournaments", title: "Enter a tournament", line: "Sign up for a tournament that's open.", to: "/tournaments?registration=open" },
    { id: "team", icon: "tools", title: "Build a team", line: "Pick a ruleset and a race in the Roster Builder.", to: "/tournament-team-builder" },
    organiserRequests
      ? { id: "organiser", icon: "leaderboards", title: "Run your own league or tournament", line: "Ask to become an organiser.", to: ORGANISER_REQUEST_TO }
      : { id: "organiser", icon: "leaderboards", title: "Run your own league or tournament", line: "A site admin can make you an organiser.", to: null },
  ];
}

const storageKey = (coach: string) => `${GET_STARTED_HIDDEN_STORAGE}:${coach.trim().toLowerCase()}`;
function readLocal(coach: string): boolean {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(storageKey(coach)) === "1"; } catch { return false; }
}
function writeLocal(coach: string): void {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(storageKey(coach), "1"); } catch { /* storage blocked: hidden for this visit only */ }
}

export interface GetStartedState {
  coach: string;
  view: GetStartedView | null;
  /** Hidden in this browser (the fallback, or a Hide pressed this visit). */
  hiddenHere: boolean;
  /** The organiser-request page exists (its read answered). */
  organiserRequests: boolean;
  busy: boolean;
}

export function createGetStarted(deps: { api: Fetcher }) {
  const state = reactive<GetStartedState>({ coach: "", view: null, hiddenHere: false, organiserRequests: false, busy: false });

  async function load(coach: string): Promise<void> {
    state.coach = coach;
    state.view = null;
    state.hiddenHere = coach ? readLocal(coach) : false;
    state.organiserRequests = false;
    if (!coach) return;
    try {
      const view = await deps.api<GetStartedView>("/api/me/get-started");
      if (state.coach !== coach) return;
      state.view = view;
    } catch { return; /* no panel on a failed read */ }
    // Feature check: link the organiser request only when its route answers (lane L2), so the card never 404s.
    if (state.view?.show && !state.view.done.organiser) {
      try { await deps.api<unknown>(ORGANISER_REQUEST_PROBE); if (state.coach === coach) state.organiserRequests = true; } catch { /* not there yet */ }
    }
  }

  return {
    state,
    load,
    visible: (): boolean => Boolean(state.view?.show) && !state.hiddenHere,
    cards: (): GetStartedCard[] => getStartedCards(state.organiserRequests),
    async hide(): Promise<void> {
      if (!state.coach || state.busy) return;
      const coach = state.coach;
      state.hiddenHere = true;
      state.busy = true;
      try {
        const view = await deps.api<GetStartedView>("/api/me/get-started", { method: "POST", body: { hidden: true } });
        if (state.coach === coach) state.view = view;
      } catch {
        writeLocal(coach); // the server could not keep it: remember it in this browser
      } finally {
        state.busy = false;
      }
    },
  };
}

export type GetStarted = ReturnType<typeof createGetStarted>;
