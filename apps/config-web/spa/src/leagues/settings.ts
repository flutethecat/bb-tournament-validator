// League settings (/app/leagues/:id/settings?tab=): organisers and site admins. A controller over the organiser API
// (GET/PATCH /api/leagues/:id/settings, seasons, Discord test, export.zip) and the pure helpers the tabs use. No DOM;
// rendered by LeagueSettingsView and the LeagueSettings* tab components.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import type { LeagueCountry, LeagueSettingsView, LeagueSummary, PodiumProposal, PodiumSlot, SeasonSummary, TeamBuildingRosterRule } from "./types";

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
      if (statusOf(err) === 409) {
        // Someone else saved first: take the fresh settings, then say so (the reload resets the form).
        await load(state.id, state.view?.teamBuilding?.seasonId);
        say(key, "Another organiser changed these settings, so the page reloaded them. Check and save again.");
      } else say(key, errorText(err, "That did not save."));
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
    /** Finish a season; `podium` = the organiser's picks by team ref ("" = leave the place empty), omitted = the proposal. */
    finishSeason: (seasonId: string, podium?: Partial<Record<PodiumSlot, string>>) =>
      action("finish", () => deps.api(`${base()}/seasons/${encodeURIComponent(seasonId)}/finish`, { method: "POST", body: podium ? { podium } : {} }), "Season finished."),
    /** The podium Finish season proposes (null when it cannot be read; the error shows under the season actions). */
    async podiumProposal(seasonId: string): Promise<PodiumProposal | null> {
      say("finish", "");
      try {
        return (await deps.api<{ proposal: PodiumProposal }>(`${base()}/seasons/${encodeURIComponent(seasonId)}/podium`)).proposal;
      } catch (err) {
        say("finish", errorText(err, "Can't work out the podium right now."));
        return null;
      }
    },
    reopenSeason: (seasonId: string) =>
      action("finish", () => deps.api(`${base()}/seasons/${encodeURIComponent(seasonId)}/reopen`, { method: "POST", body: {} }), "Season reopened. Its podium was cleared."),
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

/** The newest season in progress (seasons may overlap: owner 10-30), else none. */
export const openSeason = (seasons: SeasonSummary[]): SeasonSummary | undefined => openSeasons(seasons)[0];

/** The podium picks the dialog starts from: the proposal's team refs ("" = empty). */
export function podiumPicks(p: PodiumProposal | null): Record<PodiumSlot, string> {
  return { champion: p?.champion?.ref ?? "", runnerUp: p?.runnerUp?.ref ?? "", consolation: p?.consolation?.ref ?? "" };
}

/** "" when the picks are fine; otherwise why Confirm is disabled (one team in two places). */
export function podiumPickError(picks: Record<PodiumSlot, string>): string {
  const refs = Object.values(picks).filter(Boolean);
  return new Set(refs).size === refs.length ? "" : "A team can take only one podium place.";
}

/** Every season in progress, newest first (Finish season picks one of them). */
export const openSeasons = (seasons: SeasonSummary[]): SeasonSummary[] => [...seasons].filter((s) => s.status === "active").sort((a, b) => b.number - a.number);

export const DEFAULT_TREASURY_K = 1000;

/** True when the row still has the defaults (1,000k treasury, no starting skills). */
export const isDefaultRule = (r: TeamBuildingRosterRule): boolean =>
  r.treasury === DEFAULT_TREASURY_K && r.startingSkills.primary === 0 && r.startingSkills.secondary === 0 && r.startingSkills.elite === 0;

const sameRule = (a: TeamBuildingRosterRule, b: TeamBuildingRosterRule): boolean =>
  a.treasury === b.treasury && a.startingSkills.primary === b.startingSkills.primary && a.startingSkills.secondary === b.startingSkills.secondary && a.startingSkills.elite === b.startingSkills.elite;

/**
 * "Apply to all rosters in this tier": the other rosters of the source row's tier that would change, and those of them
 * holding non-default values (the page asks before overwriting those).
 */
export function tierFillPlan(rows: TeamBuildingRosterRule[], roster: string): { targets: string[]; overwrites: string[] } {
  const src = rows.find((r) => r.roster === roster);
  if (!src) return { targets: [], overwrites: [] };
  const others = rows.filter((r) => r.roster !== roster && r.tier === src.tier && !sameRule(r, src));
  return { targets: others.map((r) => r.roster), overwrites: others.filter((r) => !isDefaultRule(r)).map((r) => r.roster) };
}

/** Copies the source row's treasury and Primary / Secondary / Elite starting skills onto every roster of its tier (in place). */
export function applyTierFill(rows: TeamBuildingRosterRule[], roster: string): number {
  const src = rows.find((r) => r.roster === roster);
  if (!src) return 0;
  let n = 0;
  for (const r of rows) {
    if (r === src || r.tier !== src.tier || sameRule(r, src)) continue;
    r.treasury = src.treasury;
    r.startingSkills = { ...src.startingSkills };
    n++;
  }
  return n;
}

/** Next season defaults for the Start a new season dialog. */
export function nextSeasonDefaults(seasons: SeasonSummary[], leagueRuleset: string): { number: number; name: string; ruleset: string } {
  const number = (seasons.reduce((m, s) => Math.max(m, s.number), 0)) + 1;
  return { number, name: `Season ${number}`, ruleset: leagueRuleset || "BB2025" };
}
