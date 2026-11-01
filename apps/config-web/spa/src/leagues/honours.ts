// League awards and Hall of Fame (League page, Honours tab; coach page Honours panel): the controller over
// GET /api/leagues/:id/honours and its organiser writes (src/leagues/awards.ts), plus pure display helpers. No DOM.

import { reactive, type InjectionKey } from "vue";
import type { ApiError } from "../shared/api";
import type { Fetcher } from "../session";

/** Our own icon set only (public/icons). Same keys as the server's table (src/leagues/awards.ts AWARD_ICONS). */
export const AWARD_ICONS: Readonly<Record<string, { label: string; src: string }>> = {
  legend: { label: "Legend", src: "/icons/coach-badges/legend-retro.png" },
  "mega-star": { label: "Mega star", src: "/icons/coach-badges/mega-star-retro.png" },
  "super-star": { label: "Super star", src: "/icons/coach-badges/super-star-retro.png" },
  star: { label: "Star", src: "/icons/coach-badges/star-retro.png" },
  "emerging-star": { label: "Emerging star", src: "/icons/coach-badges/emerging-star-retro.png" },
  veteran: { label: "Veteran", src: "/icons/coach-badges/veteran-retro.png" },
  experienced: { label: "Experienced", src: "/icons/coach-badges/experienced-retro.png" },
  rookie: { label: "Rookie", src: "/icons/coach-badges/rookie-retro.png" },
  captain: { label: "Captain", src: "/icons/builder/team-captain-gold-48.png" },
  fans: { label: "Fans", src: "/icons/ui/dedicated_fans.png" },
  helmet: { label: "Helmet", src: "/icons/ui/football-helmet.png" },
  apothecary: { label: "Apothecary", src: "/icons/ui/apothecary.png" },
  foul: { label: "Foul", src: "/icons/ui/action-foul.png" },
  pass: { label: "Pass", src: "/icons/skills/pass.png" },
  catch: { label: "Catch", src: "/icons/skills/catch.png" },
  block: { label: "Block", src: "/icons/skills/block.png" },
  "mighty-blow": { label: "Mighty blow", src: "/icons/skills/mightyblow.png" },
  dodge: { label: "Dodge", src: "/icons/skills/dodge.png" },
  guard: { label: "Guard", src: "/icons/skills/guard.png" },
  leader: { label: "Leader", src: "/icons/skills/leader.png" },
};
export const AWARD_TITLE_MAX = 60;
export const AWARD_NOTE_MAX = 280;
export const RECORD_TEXT_MAX = 120;
export const awardIcon = (key: string | undefined): string => AWARD_ICONS[key ?? ""]?.src ?? AWARD_ICONS.star!.src;

export type AwardSource = "podium" | "imported" | "custom";

export interface AwardView {
  id: string;
  source: AwardSource;
  title: string;
  icon: string;
  toCoach?: string;
  toTeam?: string;
  teamId?: string;
  race?: string;
  seasonId?: string;
  seasonName?: string;
  note: string;
  by?: string;
  at?: string;
  star: boolean;
}

export interface MyAward extends AwardView { leagueId: string; leagueName: string }

export interface HallPlace { team: string; coach: string; race: string; teamId?: string }

export interface HallSeason {
  seasonId: string;
  number: number;
  name: string;
  ruleset: string;
  startedAt?: string;
  endedAt?: string;
  champion?: HallPlace;
  runnerUp?: HallPlace;
  consolation?: HallPlace;
  source: "podium" | "imported" | "none";
}

export interface HallPin {
  id: string;
  kind: "champion" | "award" | "record";
  seasonId?: string;
  awardId?: string;
  text?: string;
  note: string;
  by: string;
  at: string;
  resolved?: { title: string; team?: string; coach?: string; race?: string; seasonName?: string; icon?: string };
}

export interface HonoursRecipients {
  seasons: Array<{ id: string; name: string; number: number }>;
  teams: Array<{ seasonId: string; id: string; name: string; race: string; coach: string }>;
  coaches: Array<{ name: string; seasonIds: string[] }>;
}

export interface HonoursView {
  revision: number;
  hallOfFame: HallSeason[];
  pins: HallPin[];
  awards: AwardView[];
  recipients?: HonoursRecipients;
}

export type Recipient = { kind: "team"; seasonId: string; teamId: string } | { kind: "coach"; coach: string };
export interface GiveAwardInput { title: string; icon: string; recipient: Recipient; seasonId?: string; note: string }
export type PinInput = { kind: "champion"; seasonId: string; note: string } | { kind: "award"; awardId: string; note: string } | { kind: "record"; text: string; note: string };

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

/** The awards list filtered by season ("" = every season; "league" = league-wide awards only). Already newest first. */
export function awardsFor(awards: readonly AwardView[], season: string): AwardView[] {
  if (!season) return [...awards];
  if (season === "league") return awards.filter((a) => !a.seasonId);
  return awards.filter((a) => a.seasonId === season);
}

/** The awards a league team holds in a season: its season awards, and custom awards to it (league-wide ones included). */
export function teamAwards(awards: readonly AwardView[], seasonId: string, team: { id: string; name: string }): AwardView[] {
  return awards.filter((a) => (a.teamId ? a.teamId === team.id && (!a.seasonId || a.seasonId === seasonId) : a.seasonId === seasonId && a.toTeam === team.name));
}

/** "Team · Coach · Race" (parts that are set). */
export const recipientLine = (a: Pick<AwardView, "toTeam" | "toCoach" | "race">): string => [a.toTeam, a.toCoach, a.race].filter(Boolean).join(" · ");

export const SOURCE_LABEL: Record<AwardSource, string> = { podium: "Podium", imported: "Imported", custom: "Given" };

const day = (iso: string | undefined): string => {
  if (!iso || Number.isNaN(Date.parse(iso))) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
export const awardDate = (a: Pick<AwardView, "at">): string => day(a.at);
export function hallDates(h: Pick<HallSeason, "startedAt" | "endedAt">): string {
  const a = day(h.startedAt);
  const b = day(h.endedAt);
  return a && b ? `${a} – ${b}` : b ? `Finished ${b}` : a ? `Started ${a}` : "Dates not recorded";
}

/** Order after moving one pin up (-1) or down (+1); unchanged at the ends. */
export function movedOrder(ids: readonly string[], id: string, by: -1 | 1): string[] {
  const out = [...ids];
  const i = out.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

export function createHonours(deps: { api: Fetcher }) {
  const state = reactive({
    leagueId: "", loaded: false, loading: false, error: "",
    view: null as HonoursView | null,
    /** Write in flight ("award", "award:<id>", "pin", "pin:<id>", "order") and its outcome. */
    busy: "", writeError: "", notice: "",
  });
  async function load(leagueId: string, force = false): Promise<void> {
    if (!force && state.leagueId === leagueId && (state.loaded || state.loading)) return;
    if (state.leagueId !== leagueId) { state.view = null; state.loaded = false; }
    state.leagueId = leagueId;
    state.loading = true;
    try {
      state.view = await deps.api<HonoursView>(`/api/leagues/${encodeURIComponent(leagueId)}/honours`);
      state.error = "";
    } catch (err) {
      state.error = errorText(err, "Can't load the awards.");
    } finally {
      state.loaded = true;
      state.loading = false;
    }
  }
  /** One organiser write; a stale revision (409) reloads so the next try names the current one. */
  async function write(tag: string, path: string, method: string, body: Record<string, unknown>, notice: string): Promise<boolean> {
    if (state.busy || !state.view) return false;
    state.busy = tag;
    state.writeError = "";
    state.notice = "";
    try {
      const res = await deps.api<{ honours?: HonoursView }>(`/api/leagues/${encodeURIComponent(state.leagueId)}${path}`, { method, body: { ...body, revision: state.view.revision } });
      if (res?.honours) state.view = res.honours;
      state.notice = notice;
      return true;
    } catch (err) {
      state.writeError = errorText(err, "Could not save that.");
      if ((err as Partial<ApiError> | null)?.status === 409) { state.busy = ""; await load(state.leagueId, true); }
      return false;
    } finally {
      state.busy = "";
    }
  }
  const give = (input: GiveAwardInput): Promise<boolean> =>
    write("award", "/awards", "POST", { ...input, ...(input.seasonId ? {} : { seasonId: null }) }, `Award "${input.title}" given.`);
  const removeAward = (id: string): Promise<boolean> => write(`award:${id}`, `/awards/${encodeURIComponent(id)}`, "DELETE", {}, "Award removed.");
  const pin = (input: PinInput): Promise<boolean> => write("pin", "/hall-of-fame/pins", "POST", { ...input }, "Pinned to the Hall of Fame.");
  const unpin = (id: string): Promise<boolean> => write(`pin:${id}`, `/hall-of-fame/pins/${encodeURIComponent(id)}`, "DELETE", {}, "Removed from the Hall of Fame.");
  const move = (id: string, by: -1 | 1): Promise<boolean> => {
    const ids = (state.view?.pins ?? []).map((p) => p.id);
    const order = movedOrder(ids, id, by);
    if (order.join() === ids.join()) return Promise.resolve(false);
    return write("order", "/hall-of-fame/order", "PUT", { order }, "Hall of Fame order saved.");
  };
  return { state, load, give, removeAward, pin, unpin, move };
}
export type LeagueHonours = ReturnType<typeof createHonours>;
export const LEAGUE_HONOURS_KEY: InjectionKey<LeagueHonours> = Symbol("league-honours");
