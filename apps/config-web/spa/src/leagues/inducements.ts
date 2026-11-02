// League inducement table (League settings, Inducements tab; the league page's Inducements panel): a small controller
// over GET / PUT /api/leagues/:id/seasons/:seasonId/inducements (src/leagues/inducements.ts) and the pure helpers the
// editor uses. The limits, categories and icon set are the server's own module (src/leagues/inducementRules.ts). No DOM.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import {
  capProblem, customProblem, INDUCEMENT_CAP_MAX, INDUCEMENT_CATEGORIES, INDUCEMENT_CATEGORY_LABEL, INDUCEMENT_EFFECT_MAX, INDUCEMENT_ICONS,
  INDUCEMENT_NAME_MAX, INDUCEMENT_PRICE_MAX, INDUCEMENT_PRICE_STEP, priceProblem, shortGold,
  type EffectiveInducement, type InducementCategory, type InducementTableView, type InducementUsageRow, type InducementUsageScope, type InducementUsageView,
} from "../../../src/leagues/inducementRules";

export {
  INDUCEMENT_CAP_MAX, INDUCEMENT_CATEGORIES, INDUCEMENT_CATEGORY_LABEL, INDUCEMENT_EFFECT_MAX, INDUCEMENT_ICONS, INDUCEMENT_NAME_MAX,
  INDUCEMENT_PRICE_MAX, INDUCEMENT_PRICE_STEP, shortGold,
};
export type { EffectiveInducement, InducementCategory, InducementTableView, InducementUsageRow, InducementUsageScope, InducementUsageView };

/** One standard row in the editor (the dataset defaults ride along for Reset and the "changed" mark). */
export interface StandardDraft { id: string; name: string; category: InducementCategory; iconSrc: string; note: string; enabled: boolean; cap: number; price: number | null; priceFixed: boolean; default: { enabled: boolean; cap: number; price: number | null } }
/** One custom type in the editor; id "" = new (the server gives it one on Save). */
export interface CustomDraft { id: string; name: string; price: number; cap: number; icon: string; effectText: string; category: InducementCategory }
export interface InducementDraft { standard: StandardDraft[]; custom: CustomDraft[] }

export function draftFromTable(table: readonly EffectiveInducement[]): InducementDraft {
  return {
    standard: table.filter((r) => r.source === "standard").map((r) => ({
      id: r.id, name: r.name, category: r.category, iconSrc: r.iconSrc, note: r.effectText, enabled: r.enabled, cap: r.cap, price: r.price,
      priceFixed: Boolean(r.priceFixed), default: r.default ?? { enabled: r.enabled, cap: r.cap, price: r.price },
    })),
    custom: table.filter((r) => r.source === "custom").map((r) => ({ id: r.id, name: r.name, price: r.price ?? 0, cap: r.cap, icon: r.icon, effectText: r.effectText, category: r.category })),
  };
}

export const isChanged = (r: StandardDraft): boolean => r.enabled !== r.default.enabled || r.cap !== r.default.cap || (!r.priceFixed && r.price !== r.default.price);

/** The PUT body (without the revision): only rows that differ from the dataset, and the custom types in order. */
export function payloadFromDraft(d: InducementDraft): { standard: Record<string, { enabled?: boolean; cap?: number; price?: number }>; custom: Array<Omit<CustomDraft, "id"> & { id?: string }> } {
  const standard: Record<string, { enabled?: boolean; cap?: number; price?: number }> = {};
  for (const r of d.standard) {
    if (!isChanged(r)) continue;
    standard[r.id] = {
      ...(r.enabled !== r.default.enabled ? { enabled: r.enabled } : {}),
      ...(r.cap !== r.default.cap ? { cap: r.cap } : {}),
      ...(!r.priceFixed && r.price !== r.default.price && r.price !== null ? { price: r.price } : {}),
    };
  }
  return { standard, custom: d.custom.map(({ id, ...rest }) => ({ ...(id ? { id } : {}), ...rest, name: rest.name.trim(), effectText: rest.effectText.trim() })) };
}

/** The first problem in the draft ("" = fine); the server checks the same rules. */
export function draftProblem(d: InducementDraft): string {
  for (const r of d.standard) {
    const p = capProblem(r.cap, r.name) || (!r.priceFixed ? priceProblem(r.price, r.name) : "");
    if (p) return p;
  }
  const names = new Set(d.standard.map((r) => r.name.toLowerCase()));
  for (const c of d.custom) {
    const p = customProblem(c);
    if (p) return p;
    const n = c.name.trim().toLowerCase();
    if (names.has(n)) return `There is already an inducement called ${c.name.trim()}.`;
    names.add(n);
  }
  return "";
}

/** Reset to defaults: every standard row back to the dataset values (custom types stay; remove them one by one). */
export function resetStandard(d: InducementDraft): void {
  for (const r of d.standard) { r.enabled = r.default.enabled; r.cap = r.default.cap; r.price = r.default.price; }
}

export const blankCustom = (): CustomDraft => ({ id: "", name: "", price: 50_000, cap: 1, icon: "star", effectText: "", category: "special" });

/** The rows coaches see: offered ones (enabled, cap above 0), grouped by category in the fixed category order. */
export function offeredByCategory(table: readonly EffectiveInducement[]): Array<{ category: InducementCategory; label: string; rows: EffectiveInducement[] }> {
  return INDUCEMENT_CATEGORIES.map((category) => ({ category, label: INDUCEMENT_CATEGORY_LABEL[category], rows: table.filter((r) => r.category === category && r.enabled && r.cap > 0) }))
    .filter((g) => g.rows.length > 0);
}

/** What changed from the standard table, for the coaches' panel caption ("" when nothing). */
export function changeSummary(table: readonly EffectiveInducement[]): string {
  const changed = table.filter((r) => r.source === "standard" && r.default && (r.enabled !== r.default.enabled || r.cap !== r.default.cap || r.price !== r.default.price)).length;
  const custom = table.filter((r) => r.source === "custom").length;
  const parts = [changed ? `${changed} changed` : "", custom ? `${custom} custom` : ""].filter(Boolean);
  return parts.join(" · ");
}

const statusOf = (err: unknown): number | undefined => (err instanceof ApiError ? err.status : undefined);

export function createInducementTable(deps: { api: Fetcher }) {
  const state = reactive({ view: null as InducementTableView | null, loading: false, error: "", saving: false, saveError: "", notice: "" });
  const path = (leagueId: string, seasonId: string): string => `/api/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/inducements`;

  // Each load is tagged: an answer for a season that is no longer the one asked for last is dropped, so a slow
  // response never overwrites the selected season's table.
  let latest = 0;
  async function load(leagueId: string, seasonId: string): Promise<void> {
    const ticket = ++latest;
    state.loading = true;
    state.error = "";
    try {
      const view = await deps.api<InducementTableView>(path(leagueId, seasonId));
      if (ticket === latest) state.view = view;
    } catch (err) {
      if (ticket !== latest) return;
      state.view = null;
      state.error = statusOf(err) === 404 ? "Season not found." : err instanceof Error && err.message ? err.message : "Can't load the inducements.";
    } finally {
      if (ticket === latest) state.loading = false;
    }
  }

  /** Saves the whole table at the revision it was loaded at; a 409 reloads it and says so. */
  async function save(d: InducementDraft): Promise<boolean> {
    const v = state.view;
    if (!v || state.saving || state.loading) return false;
    const ticket = latest;
    state.saving = true;
    state.saveError = "";
    state.notice = "";
    try {
      const saved = await deps.api<InducementTableView>(path(v.leagueId, v.seasonId), { method: "PUT", body: { revision: v.revision, ...payloadFromDraft(d) } });
      if (ticket === latest) { state.view = saved; state.notice = "Inducements saved."; }
      return true;
    } catch (err) {
      if (statusOf(err) === 409 && ticket === latest) {
        await load(v.leagueId, v.seasonId);
        state.saveError = "Another organiser changed this table, so the page reloaded it. Check and save again.";
      } else state.saveError = err instanceof Error && err.message ? err.message : "That did not save.";
      return false;
    } finally {
      state.saving = false;
    }
  }

  return { state, load, save };
}
export type InducementTable = ReturnType<typeof createInducementTable>;
/** A pre-loaded table (tests and server rendering); the components make their own otherwise. */
export const INDUCEMENT_TABLE_KEY: InjectionKey<InducementTable> = Symbol("inducement-table");

// ---- usage (the league page's "Inducements taken" panel) ------------------------------------------------------------

/** "40%" for a 0..1 share (whole percent; "<1%" for a share that rounds to 0 but is above it). */
export const sharePercent = (share: number): string => (share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`);

/** The panel footnote: "Counted from N recorded games" (+ the games without data); "" when nothing was played. */
export function usageFootnote(v: Pick<InducementUsageView, "gamesCounted" | "gamesWithoutData">): string {
  const games = (n: number): string => `${n} ${n === 1 ? "game" : "games"}`;
  const parts: string[] = [];
  if (v.gamesCounted || v.gamesWithoutData) parts.push(`Counted from ${v.gamesCounted} recorded ${v.gamesCounted === 1 ? "game" : "games"}.`);
  if (v.gamesWithoutData) parts.push(`${games(v.gamesWithoutData)} had no inducement data.`);
  return parts.join(" ");
}

/** GET .../seasons/:seasonId/inducements/usage[?scope=league]; the last asked-for load wins (season and scope switches). */
export function createInducementUsage(deps: { api: Fetcher }) {
  const state = reactive({ view: null as InducementUsageView | null, scope: "season" as InducementUsageScope, loading: false, error: "" });
  let latest = 0;
  async function load(leagueId: string, seasonId: string, scope: InducementUsageScope = state.scope): Promise<void> {
    const ticket = ++latest;
    state.scope = scope;
    state.loading = true;
    state.error = "";
    try {
      const view = await deps.api<InducementUsageView>(`/api/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/inducements/usage${scope === "league" ? "?scope=league" : ""}`);
      if (ticket === latest) state.view = view;
    } catch (err) {
      if (ticket !== latest) return;
      state.view = null;
      state.error = statusOf(err) === 404 ? "Season not found." : err instanceof Error && err.message ? err.message : "Can't load the inducement statistics.";
    } finally {
      if (ticket === latest) state.loading = false;
    }
  }
  return { state, load };
}
export type InducementUsage = ReturnType<typeof createInducementUsage>;
/** A pre-loaded usage controller (tests and server rendering); the panel makes its own otherwise. */
export const INDUCEMENT_USAGE_KEY: InjectionKey<InducementUsage> = Symbol("inducement-usage");
