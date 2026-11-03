// League fixture summary (/app/leagues/:id?tab=fixtures&fixture=<id>): controller over the fixture summary route and the
// Play on Super FUMBBL actions (server: src/leagues/forkPlay.ts). No DOM except the launch-file download.

import { reactive, type InjectionKey } from "vue";
import type { Fetcher } from "../session";
import type { FixtureForkView, FixtureSummary, ForkSide, LeagueFixture } from "./types";

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

function defaultDownload(href: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.setAttribute("download", "");
  document.body.append(a);
  a.click();
  a.remove();
}

export interface FixtureSummaryState {
  key: string;
  summary: FixtureSummary | null;
  loaded: boolean;
  error: string;
  /** The action in flight ("generate", "start", "reset", "late", "cancel", "allow", "sync") and the last outcome. */
  busy: string;
  actionError: string;
  notice: string;
}

export function createFixtureSummary(deps: { api: Fetcher; download?: (href: string) => void }) {
  const state = reactive<FixtureSummaryState>({ key: "", summary: null, loaded: false, error: "", busy: "", actionError: "", notice: "" });
  let ids = { league: "", season: "", fixture: "" };
  const base = (): string => `/api/leagues/${encodeURIComponent(ids.league)}/seasons/${encodeURIComponent(ids.season)}/fixtures/${encodeURIComponent(ids.fixture)}`;

  async function load(leagueId: string, seasonId: string, fixtureId: string): Promise<void> {
    ids = { league: leagueId, season: seasonId, fixture: fixtureId };
    state.key = `${leagueId}/${seasonId}/${fixtureId}`;
    try {
      state.summary = await deps.api<FixtureSummary>(base());
      state.error = "";
    } catch (err) {
      state.summary = null;
      state.error = errorText(err, "Can't load this fixture.");
    } finally {
      state.loaded = true;
    }
  }
  const reload = (): Promise<void> => load(ids.league, ids.season, ids.fixture);

  async function act(name: string, task: () => Promise<unknown>, done = ""): Promise<boolean> {
    state.busy = name;
    state.actionError = "";
    state.notice = "";
    try {
      const out = await task();
      const fork = (out as { fork?: FixtureForkView } | null)?.fork;
      if (fork && state.summary) state.summary.fork = fork;
      else await reload();
      state.notice = done;
      return true;
    } catch (err) {
      state.actionError = errorText(err, "That did not work.");
      await reload();
      return false;
    } finally {
      state.busy = "";
    }
  }

  async function patch(name: string, body: Record<string, boolean>, done: string): Promise<boolean> {
    return act(name, async () => {
      const res = await deps.api<{ fixture: LeagueFixture }>(base(), { method: "PATCH", body });
      if (state.summary) state.summary.fixture = { ...state.summary.fixture, ...res.fixture };
      await reload();
      return null;
    }, done);
  }

  return {
    state, load, reload,
    generate: () => act("generate", () => deps.api(`${base()}/fork/generate`, { method: "POST", body: {} }), "The game is ready on Super FUMBBL."),
    /** The seated coach: record the launch, then download the launch file. */
    start: () => act("start", async () => {
      const res = await deps.api<{ jnlpUrl: string }>(`${base()}/fork/launch`, { method: "POST", body: {} });
      (deps.download ?? defaultDownload)(res.jnlpUrl);
      await reload();
      return null;
    }, "Your launch file is downloading."),
    reset: (reason: string) => act("reset", () => deps.api(`${base()}/fork/reset`, { method: "POST", body: { reason } }), "The game was reset."),
    sync: () => act("sync", () => deps.api(`${base()}/fork/sync`, { method: "POST", body: {} }), "Checked for a result."),
    setAllowed: (on: boolean) => patch("allow", { forkEnabled: on }, on ? "Super FUMBBL allowed for this fixture." : "Super FUMBBL no longer allowed."),
    setLate: (on: boolean) => patch("late", { forkAllowLate: on }, on ? "Late launch allowed." : "Late launch turned off."),
    /** The game's admin toggle: roll defections in the forfeit dialog (src/leagues/forfeit.ts). */
    setDefections: (on: boolean) => act("defections", async () => {
      await deps.api(`${base()}/forfeit/settings`, { method: "POST", body: { defectionRolls: on } });
      await reload();
      return null;
    }, on ? "Defection rolls on for this game." : "Defection rolls off for this game."),
    setCancelled: (on: boolean) => patch("cancel", { forkCancelled: on }, on ? "Super FUMBBL play cancelled." : "Super FUMBBL play allowed again."),
  };
}
export type FixtureSummaryController = ReturnType<typeof createFixtureSummary>;
export const FIXTURE_SUMMARY_KEY: InjectionKey<FixtureSummaryController> = Symbol("league-fixture-summary");

/** Status chip tone. */
export const FORK_STATUS_TONE: Record<FixtureForkView["status"], string> = {
  none: "muted", teams_built: "info", scheduled: "soon", in_progress: "info", finished: "ok", launch_failed: "urgent", cancelled: "muted",
};

/** The steps the summary lists, done or not. */
export function forkSteps(v: FixtureForkView): Array<{ label: string; done: boolean }> {
  const built = Boolean(v.teams.home && v.teams.away);
  const scheduled = Boolean(v.gameId) && v.status !== "launch_failed";
  return [
    { label: "Teams built on Super FUMBBL", done: built },
    { label: v.gameId ? `Game ${v.gameId} scheduled` : "Game scheduled", done: scheduled },
    { label: "In progress", done: v.status === "in_progress" || v.status === "finished" },
    { label: "Result recorded", done: v.status === "finished" },
  ];
}

export const sideLabel = (s: ForkSide): string => (s === "home" ? "Home" : "Away");

/** Link from the fixtures list to a fixture's summary. */
export function fixtureQuery(seasonId: string | undefined, fixtureId: string): Record<string, string> {
  return { ...(seasonId ? { season: seasonId } : {}), tab: "fixtures", fixture: fixtureId };
}
