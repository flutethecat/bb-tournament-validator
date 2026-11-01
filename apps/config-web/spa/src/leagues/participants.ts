// League Participants tab (organisers and site admins): the season's teams with the five participant flags, per-row
// toggles and bulk "Mark all" actions over GET/PATCH/POST /api/leagues/:id/seasons/:seasonId/participants
// (src/leagues/participants.ts). No DOM; rendered by LeagueParticipants.vue.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";

export const PARTICIPANT_FLAGS = ["paid", "rosterVerified", "frozen", "checkedIn", "active"] as const;
export type ParticipantFlag = (typeof PARTICIPANT_FLAGS)[number];
export type ParticipantFlags = Record<ParticipantFlag, boolean>;

export const FLAG_LABEL: Record<ParticipantFlag, string> = {
  paid: "Paid", rosterVerified: "Verified", frozen: "Frozen", checkedIn: "Checked in", active: "Active",
};

export interface ParticipantRow {
  teamId: string;
  team: string;
  race: string;
  coach: string;
  coachId?: string;
  flags: ParticipantFlags;
  updated?: { by: string; at: string };
  /** Only what the coach shared with this league (server-filtered). */
  contact?: { preferredName?: string; email?: string; phones?: Array<{ number: string; label?: string }> };
}

export const PARTICIPANT_FILTERS = [
  { id: "all", label: "All" },
  { id: "unpaid", label: "Unpaid" },
  { id: "unverified", label: "Not verified" },
  { id: "absent", label: "Not checked in" },
  { id: "standby", label: "Standby" },
] as const;
export type ParticipantFilter = (typeof PARTICIPANT_FILTERS)[number]["id"];

export function keepRow(r: ParticipantRow, f: ParticipantFilter): boolean {
  switch (f) {
    case "unpaid": return !r.flags.paid;
    case "unverified": return !r.flags.rosterVerified;
    case "absent": return !r.flags.checkedIn;
    case "standby": return !r.flags.active;
    default: return true;
  }
}

/** The lines of a coach's shared contact ("" when nothing is shared). */
export function contactLines(r: Pick<ParticipantRow, "contact">): string[] {
  const c = r.contact;
  if (!c) return [];
  return [...(c.preferredName ? [c.preferredName] : []), ...(c.email ? [c.email] : []), ...(c.phones ?? []).map((p) => (p.label ? `${p.number} (${p.label})` : p.number))];
}

/** "3 / 28" of the rows with a flag on. */
export const flagCount = (rows: readonly ParticipantRow[], f: ParticipantFlag): number => rows.filter((r) => r.flags[f]).length;

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

export interface ParticipantsDeps {
  api: Fetcher;
  /** The season revision the page holds (other league writes bump it); the newer of it and ours is sent. */
  revision?: () => number | undefined;
  /** Called with the new season revision after a write. */
  onRevision?: (revision: number) => void;
}

export function createLeagueParticipants(deps: ParticipantsDeps) {
  const state = reactive({
    key: "", leagueId: "", seasonId: "", rows: [] as ParticipantRow[], revision: 0, loaded: false, loading: false,
    error: "", busy: "", writeError: "", notice: "",
  });
  const path = (): string => `/api/leagues/${encodeURIComponent(state.leagueId)}/seasons/${encodeURIComponent(state.seasonId)}/participants`;
  async function load(leagueId: string, seasonId: string, force = false): Promise<void> {
    const key = `${leagueId}/${seasonId}`;
    if (!force && state.key === key && state.loaded) return;
    if (state.key !== key) { state.rows = []; state.loaded = false; state.writeError = ""; state.notice = ""; }
    state.key = key; state.leagueId = leagueId; state.seasonId = seasonId; state.loading = true;
    try {
      const res = await deps.api<{ participants?: ParticipantRow[]; revision?: number }>(path());
      if (state.key !== key) return;
      state.rows = Array.isArray(res?.participants) ? res.participants : [];
      if (typeof res?.revision === "number") state.revision = res.revision;
      state.error = "";
    } catch (err) {
      if (state.key !== key) return;
      state.error = err instanceof ApiError && err.status === 403 ? "Only this league's organisers and site admins can see its participants." : errorText(err, "Can't load the participants.");
    } finally {
      if (state.key === key) { state.loaded = true; state.loading = false; }
    }
  }
  async function write(busy: string, task: (revision: number) => Promise<{ participants?: ParticipantRow[]; revision?: number; changed?: number }>, notice: (changed: number) => string): Promise<boolean> {
    const key = state.key;
    state.busy = busy; state.writeError = ""; state.notice = "";
    try {
      const res = await task(Math.max(state.revision, deps.revision?.() ?? 0));
      if (state.key !== key) return false;
      if (Array.isArray(res?.participants)) state.rows = res.participants;
      if (typeof res?.revision === "number") { state.revision = res.revision; deps.onRevision?.(res.revision); }
      state.notice = notice(typeof res?.changed === "number" ? res.changed : 0);
      return true;
    } catch (err) {
      if (state.key !== key) return false;
      state.writeError = errorText(err, "That did not save.");
      // Stale: re-read so the next change sends the current revision and the table shows what is stored.
      if (err instanceof ApiError && (err.status === 409 || err.status === 428)) await load(state.leagueId, state.seasonId, true);
      return false;
    } finally {
      if (state.key === key) state.busy = "";
    }
  }
  return {
    state, load,
    setFlag: (teamId: string, flag: ParticipantFlag, value: boolean) =>
      write(`row:${teamId}`, (revision) => deps.api(`${path()}/${encodeURIComponent(teamId)}`, { method: "PATCH", body: { revision, [flag]: value } }), () => ""),
    /** Every team (teamIds empty) or the picked ones. */
    bulk: (flag: ParticipantFlag, value: boolean, teamIds: string[] = []) =>
      write(`bulk:${flag}`, (revision) => deps.api(path(), { method: "POST", body: { revision, ...(teamIds.length ? { teamIds } : {}), set: { [flag]: value } } }),
        (changed) => (changed ? `${FLAG_LABEL[flag]}: ${changed} ${changed === 1 ? "team" : "teams"} updated.` : "Nothing to change.")),
  };
}
export type LeagueParticipantsCtl = ReturnType<typeof createLeagueParticipants>;
export const LEAGUE_PARTICIPANTS_KEY: InjectionKey<LeagueParticipantsCtl> = Symbol("league-participants");
