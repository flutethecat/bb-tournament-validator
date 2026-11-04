// Badges and achievements (badges lane, 11-04): the SPA side. Read models from the public badge routes
// (src/badges/api.ts), the catalog (names, "coming soon" placeholders) and the league badges controller (organisers
// create, award and revoke). Icons are our own glyphs (src/badges/icons.ts), never image files.

import { reactive, type InjectionKey } from "vue";
import type { Fetcher } from "../session";
import { BADGE_CATALOG, type BadgeDefinition } from "../../../src/badges/catalog";
import { BADGE_ICONS, badgeGlyph } from "../../../src/badges/icons";

export { BADGE_ICONS, badgeGlyph };

export interface BadgeView {
  id: string;
  badgeId: string;
  source: "site" | "league";
  name: string;
  description: string;
  icon: string;
  glyph: string;
  kind: "badge" | "achievement" | "custom";
  tier?: string;
  at: string;
  label?: string;
  link?: string;
  leagueId?: string;
  leagueName?: string;
  by?: string;
  note?: string;
}

/** Catalog entries the recorder can't feed yet: shown greyed with "coming soon", never earned. */
export const comingSoon = (catalog: readonly BadgeDefinition[] = BADGE_CATALOG): BadgeDefinition[] => catalog.filter((d) => d.status === "needs-recorder-data");

/** Live catalog entries the coach has not earned yet (by badge id; race badges count once earned for any race). */
export function notYetEarned(badges: readonly BadgeView[], catalog: readonly BadgeDefinition[] = BADGE_CATALOG): BadgeDefinition[] {
  const have = new Set(badges.filter((b) => b.source === "site").map((b) => b.badgeId));
  return catalog.filter((d) => d.status === "live" && d.scope !== "team" && !have.has(d.id) && d.variant !== "race");
}

/** "Badge" / "Achievement" / "League badge". */
export const KIND_LABEL: Readonly<Record<BadgeView["kind"], string>> = { badge: "Badge", achievement: "Achievement", custom: "League badge" };

/** The tooltip / accessible line of a badge. */
export function badgeLine(b: Pick<BadgeView, "name" | "description" | "label" | "at" | "kind">): string {
  const when = b.at ? new Date(b.at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
  return [`${KIND_LABEL[b.kind]}: ${b.name}`, b.description, [b.label, when].filter(Boolean).join(", ")].filter(Boolean).join(". ");
}

export const coachBadgesPath = (coach: string): string => `/api/badges/coach/${encodeURIComponent(coach.normalize("NFC").trim())}`;
export const teamBadgesPath = (leagueId: string, seasonId: string, teamId: string): string =>
  `/api/badges/team/${encodeURIComponent(leagueId)}/${encodeURIComponent(seasonId)}/${encodeURIComponent(teamId)}`;

// ---- league badges (Awards tab panel) -----------------------------------------------------------------------------------

export interface CustomBadgeRow { id: string; name: string; description: string; icon: string; glyph: string; scope: "coach" | "team" | "both"; archivedAt?: string; awards: number; createdBy: string }
export interface LeagueBadgeAward extends BadgeView { to: { kind: "coach" | "team"; name: string } }
export interface LeagueBadgesView {
  revision: number;
  manage: boolean;
  badges: CustomBadgeRow[];
  recent: LeagueBadgeAward[];
  log?: Array<{ id: string; at: string; action: string; badgeId: string; subject?: { kind: string; name: string }; by: string; reason?: string }>;
  members?: { coaches: string[]; teams: Array<{ seasonId: string; seasonName: string; teamId: string; team: string; coach?: string }> };
  icons?: Array<{ key: string; glyph: string; label: string }>;
}

export function createLeagueBadges(api: Fetcher) {
  const state = reactive({ id: "", view: null as LeagueBadgesView | null, error: "", busy: "", notice: "", writeError: "" });
  const base = () => `/api/badges/league/${encodeURIComponent(state.id)}`;
  async function load(id: string): Promise<void> {
    state.id = id;
    state.error = "";
    try { state.view = await api<LeagueBadgesView>(base()); } catch (e) { state.error = (e as Error).message || "Can't load the badges."; }
  }
  async function write(busy: string, path: string, method: string, body: Record<string, unknown>, notice: string): Promise<boolean> {
    if (!state.view) return false;
    state.busy = busy;
    state.writeError = "";
    state.notice = "";
    try {
      await api(`${base()}${path}`, { method, body: { ...body, revision: state.view.revision } });
      state.notice = notice;
      await load(state.id);
      return true;
    } catch (e) {
      state.writeError = (e as Error).message || "That didn't work.";
      if ((e as { status?: number }).status === 409) await load(state.id);
      return false;
    } finally { state.busy = ""; }
  }
  const create = (input: { name: string; description: string; icon: string; scope: string }) => write("create", "/badges", "POST", input, `Badge "${input.name}" created.`);
  const archive = (id: string, archived: boolean) => write(`archive:${id}`, `/badges/${encodeURIComponent(id)}`, "PATCH", { archived }, archived ? "Badge archived." : "Badge restored.");
  const award = (id: string, to: { coach: string } | { seasonId: string; teamId: string }, note: string) =>
    write(`award:${id}`, `/badges/${encodeURIComponent(id)}/award`, "POST", { ...to, ...(note ? { note } : {}) }, "Badge awarded.");
  const revoke = (awardId: string) => write(`revoke:${awardId}`, `/awards/${encodeURIComponent(awardId)}/revoke`, "POST", {}, "Award revoked.");
  return { state, load, create, archive, award, revoke };
}
export type LeagueBadges = ReturnType<typeof createLeagueBadges>;
export const LEAGUE_BADGES_KEY: InjectionKey<LeagueBadges> = Symbol("league-badges");
