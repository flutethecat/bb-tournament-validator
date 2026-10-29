// League settings (/app/leagues/:id/settings?tab=): organisers and site admins. A controller over the organiser API
// (GET/PATCH /api/leagues/:id/settings, seasons, Discord test, export.zip) and the pure helpers the tabs use. No DOM;
// rendered by LeagueSettingsView and the LeagueSettings* tab components.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import type { LeagueCountry, LeagueSettingsView, LeagueSummary, SeasonSummary, TeamBuildingRosterRule } from "./types";

export type SettingsTab = "administration" | "information" | "registrations" | "team-building" | "connections";
export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "administration", label: "Administration" },
  { id: "information", label: "Information" },
  { id: "registrations", label: "Registrations" },
  { id: "team-building", label: "Team building" },
  { id: "connections", label: "External connections" },
];
export const isSettingsTab = (v: unknown): v is SettingsTab => typeof v === "string" && SETTINGS_TABS.some((t) => t.id === v);

/** The PATCH sections; each tab saves its own. */
export type SettingsSection = "administration" | "information" | "registrations" | "teamBuilding" | "connections";

export const COUNTRY_LABEL: Record<LeagueCountry, string> = { US: "United States", CA: "Canada" };
export const REGION_LABEL: Record<LeagueCountry, string> = { US: "State", CA: "Province or territory" };
export const POSTCODE_LABEL: Record<LeagueCountry, string> = { US: "ZIP code", CA: "Postal code" };

const US_ZIP = /^\d{5}(?:-\d{4})?$/;
const CA_POSTAL = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\s?\d[ABCEGHJ-NPRSTV-Z]\d$/;

/** The inline postcode message ("" = fine or empty). The server checks the same rule. */
export function postcodeError(country: LeagueCountry, value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (country === "US") return US_ZIP.test(v) ? "" : "ZIP code must be 5 digits or 5+4 (12345 or 12345-6789).";
  return CA_POSTAL.test(v.toUpperCase()) ? "" : "Postal code must look like A1A 1A1.";
}

/** Discord webhook URL shape (the server is the authority). */
export const isWebhookUrl = (v: string): boolean =>
  /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/.test(v.trim());

export const DISCORD_EVENT_LABEL: Record<string, string> = {
  news: "League news",
  fixtureCreated: "Fixture created",
  matchStarted: "Match started",
  matchResult: "Match result",
  milestones: "Redraft and season milestones",
};

/** "" for an integer in range, else the message. */
export function rangeError(v: unknown, min: number, max: number, label: string): string {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? "" : `${label}: ${min} to ${max}.`;
}

/** The first problem in a team building table ("" when every row is in range). */
export function teamBuildingError(rows: TeamBuildingRosterRule[]): string {
  for (const r of rows) {
    const e = rangeError(r.tier, 1, 6, `${r.roster} tier`) || rangeError(r.treasury, 0, 5000, `${r.roster} treasury`)
      || rangeError(r.startingSkills.primary, 0, 6, `${r.roster} primary`) || rangeError(r.startingSkills.secondary, 0, 6, `${r.roster} secondary`)
      || rangeError(r.startingSkills.elite, 0, 6, `${r.roster} elite`);
    if (e) return e;
  }
  return "";
}

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);
/** The HTTP status of an API failure (ApiError, or any error carrying a numeric status). */
const statusOf = (err: unknown): number | undefined =>
  err instanceof ApiError ? err.status : typeof (err as { status?: unknown } | null)?.status === "number" ? (err as { status: number }).status : undefined;

export interface LeagueSettingsState {
  id: string;
  league: LeagueSummary | null;
  seasons: SeasonSummary[];
  view: LeagueSettingsView | null;
  loaded: boolean;
  /** "signin" (401) | "forbidden" (403) | "" */
  denied: "" | "signin" | "forbidden";
  error: string;
  /** The section (or action) in flight. */
  busy: string;
  errors: Record<string, string>;
  notices: Record<string, string>;
}

export function createLeagueSettings(deps: { api: Fetcher }) {
  const state = reactive<LeagueSettingsState>({
    id: "", league: null, seasons: [], view: null, loaded: false, denied: "", error: "", busy: "", errors: {}, notices: {},
  });
  const base = (): string => `/api/leagues/${encodeURIComponent(state.id)}`;
  const say = (key: string, error: string, notice = ""): void => { state.errors[key] = error; state.notices[key] = notice; };

  async function loadLeague(): Promise<void> {
    const res = await deps.api<{ league: LeagueSummary; seasons: SeasonSummary[] }>(base());
    state.league = res.league;
    state.seasons = [...(res.seasons ?? [])].sort((a, b) => b.number - a.number);
  }

  async function load(id: string, seasonId?: string): Promise<void> {
    state.id = id;
    state.denied = "";
    state.error = "";
    try {
      await loadLeague();
      const q = seasonId ? `?season=${encodeURIComponent(seasonId)}` : "";
      state.view = (await deps.api<{ settings: LeagueSettingsView }>(`${base()}/settings${q}`)).settings;
    } catch (err) {
      state.view = null;
      const status = statusOf(err);
      if (status === 401) state.denied = "signin";
      else if (status === 403) state.denied = "forbidden";
      else state.error = status === 404 ? "League not found." : errorText(err, "Can't load the league settings.");
    } finally {
      state.loaded = true;
    }
  }

  /** PATCH one section (with the revision the page was opened at); the server answers the fresh read model. */
  async function save(section: SettingsSection, payload: unknown, key: string = section, notice = "Saved."): Promise<boolean> {
    if (!state.view) return false;
    state.busy = key;
    say(key, "");
    try {
      const res = await deps.api<{ settings: LeagueSettingsView }>(`${base()}/settings`, { method: "PATCH", body: { revision: state.view.revision, [section]: payload } });
      state.view = res.settings;
      say(key, "", notice);
      if (section === "information" || section === "administration" || section === "connections") await loadLeague().catch(() => undefined);
      return true;
    } catch (err) {
      say(key, errorText(err, "That did not save."));
      return false;
    } finally {
      state.busy = "";
    }
  }

  async function action(key: string, task: () => Promise<unknown>, notice: string, reload = true): Promise<boolean> {
    state.busy = key;
    say(key, "");
    try {
      await task();
      if (reload) await load(state.id, state.view?.teamBuilding?.seasonId);
      say(key, "", notice);
      return true;
    } catch (err) {
      say(key, errorText(err, "That did not work."));
      return false;
    } finally {
      state.busy = "";
    }
  }

  return {
    state, load, save,
    /** Team building table of another season. */
    loadSeasonRules: (seasonId: string) => load(state.id, seasonId),
    startSeason: (input: { name: string; ruleset: string }) =>
      action("season", async () => {
        await deps.api(`${base()}/seasons`, { method: "POST", body: input });
        // The new season becomes the team building season.
        if (state.view) state.view.teamBuilding = null;
      }, "New season started."),
    finishSeason: (seasonId: string) =>
      action("finish", () => deps.api(`${base()}/seasons/${encodeURIComponent(seasonId)}/finish`, { method: "POST", body: {} }), "Season finished."),
    testDiscord: () => action("discord-test", () => deps.api(`${base()}/discord/test`, { method: "POST", body: {} }), "Test post sent. Check the channel.", false),
    async lookupCoaches(q: string): Promise<string[]> {
      if (q.trim().length < 2) return [];
      try { return (await deps.api<{ coaches: string[] }>(`${base()}/coaches?q=${encodeURIComponent(q.trim())}`)).coaches ?? []; } catch { return []; }
    },
    exportUrl: (seasonId?: string) => `${base()}/export.zip${seasonId ? `?season=${encodeURIComponent(seasonId)}` : ""}`,
  };
}
export type LeagueSettings = ReturnType<typeof createLeagueSettings>;
export const LEAGUE_SETTINGS_KEY: InjectionKey<LeagueSettings> = Symbol("league-settings");

/** The season the season actions act on: the open one, else none. */
export const openSeason = (seasons: SeasonSummary[]): SeasonSummary | undefined => seasons.find((s) => s.status === "active");

/** Next season defaults for the Start a new season dialog. */
export function nextSeasonDefaults(seasons: SeasonSummary[], leagueRuleset: string): { number: number; name: string; ruleset: string } {
  const number = (seasons.reduce((m, s) => Math.max(m, s.number), 0)) + 1;
  return { number, name: `Season ${number}`, ruleset: leagueRuleset || "BB2025" };
}
