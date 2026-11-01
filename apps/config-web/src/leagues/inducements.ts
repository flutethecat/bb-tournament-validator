/**
 * League inducement table (spec-main-landing-nav-2026-10-29 §2 item 7; owner 10-29: "Admins can edit inducements and
 * add their own inducement types to the panel").
 *
 * The standard table is the shared BB2025 inducement dataset (@bb/validator, aligned to the bloodbowlbase.ru
 * inducements page): the same rows the tabletop recorder's pre-game picker and the Roster Builder use. Per season the
 * league's organisers (and site admins) may
 *   - enable / disable each standard inducement (a commissioner opt-in such as the Canopic Jar is off until enabled),
 *   - change its cap (0..16; the cap applies to every team, including teams that would get a reduced cap) and its price
 *     (5,000-gold steps; a team that pays a reduced price pays the lower of the two),
 *   - add custom inducement types { id, name, price, cap, icon, effectText, category }.
 * Stored on the season as season.rules.inducements (overrides + customs + its own revision), never on a shared package
 * file. A new season copies the previous season's table (api.ts createSeason), like the Team building rules.
 *
 *   GET /api/leagues/:id/seasons/:seasonId/inducements   public (game rules): the effective table + revision
 *   PUT /api/leagues/:id/seasons/:seasonId/inducements   { revision, standard: { [id]: { enabled?, cap?, price? } }, custom: [...] }
 *       organisers of the league + site admins; the whole table is replaced. A custom type without an id is new (the
 *       server gives it one); an id names an existing custom type, which keeps it. 428 no revision, 409 stale.
 *
 * CSRF and the onboarding gate (428) run in front of every /api write (server.ts). The GET is public on both gate paths
 * (requireSession.ts: every /api/leagues/ read; server.ts authorized(): leaguePath).
 */
import { randomBytes } from "node:crypto";
import { inducementEnabled } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { readJsonObject, requestRevision } from "./http.js";
import {
  capProblem, CUSTOM_INDUCEMENT_ID, CUSTOM_INDUCEMENTS_MAX, customProblem, INDUCEMENT_ICONS, plainText, priceProblem,
  STANDARD_INDUCEMENT_CATEGORY, STANDARD_INDUCEMENT_ICON,
  type CustomInducement, type EffectiveInducement, type InducementCategory, type InducementOverride, type InducementTableView, type SeasonInducements,
} from "./inducementRules.js";
import { isLeagueOrganiser } from "./store.js";
import type { LeagueRecord, SeasonRecord } from "./types.js";
import { inducementOffersFor, type InducementOffers } from "../tabletop/pregame.js";

export const INDUCEMENTS_MAX_BYTES = 32 * 1024;
const NO_STORE = { "cache-control": "no-store" };

export class InducementError extends Error {
  constructor(readonly status: number, message: string, readonly field?: string) { super(message); }
}

type DatasetRow = (typeof bb2025.inducements)[string];
const datasetRows = (): Array<[string, DatasetRow]> => Object.entries(bb2025.inducements);

/** The dataset's restriction / pricing note for a standard row, in plain words ("" when none). */
function standardNote(row: DatasetRow): string {
  const parts: string[] = [];
  if (row.requiresSpecialRule) parts.push(`Only teams with ${row.requiresSpecialRule}.`);
  if (row.requiresApothecary) parts.push("Only teams that may hire an Apothecary.");
  if (typeof row.reducedCost === "number" && (row.reducedSpecialRule || row.reducedRoster))
    parts.push(`${row.reducedSpecialRule ? `Teams with ${row.reducedSpecialRule}` : `${row.reducedRoster} teams`} pay ${row.reducedCost / 1000}k${row.reducedMax && row.reducedMax !== row.max ? ` (up to ${row.reducedMax})` : ""}.`);
  if (row.cost === null) parts.push("Hired at each star's own cost.");
  else if (!row.wireName) parts.push("Extra cost over the player's own cost.");
  if (row.optIn) parts.push("Off unless the league enables it.");
  return parts.join(" ");
}

const emptyConfig = (): SeasonInducements => ({ standard: {}, custom: [], revision: 0 });
export const inducementConfigOf = (season: Pick<SeasonRecord, "rules"> | undefined): SeasonInducements => {
  const c = season?.rules?.inducements;
  return c ? { standard: c.standard ?? {}, custom: c.custom ?? [], revision: c.revision ?? 0, ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}), ...(c.updatedBy ? { updatedBy: c.updatedBy } : {}) } : emptyConfig();
};

/**
 * THE effective table: the standard dataset with the season's overrides applied, then the custom types. Every row is
 * listed (disabled ones too, so coaches see what the league turned off); readers that sell inducements skip the
 * disabled rows and rows capped at 0.
 */
export function effectiveInducements(config: SeasonInducements | undefined): EffectiveInducement[] {
  const c = config ?? emptyConfig();
  const standard = datasetRows().map(([id, row]): EffectiveInducement => {
    const def = { enabled: !row.optIn, cap: row.max ?? 0, price: row.cost };
    const o = c.standard[id] ?? {};
    const icon = STANDARD_INDUCEMENT_ICON[id] ?? "star";
    return {
      id, name: row.name, source: "standard", category: STANDARD_INDUCEMENT_CATEGORY[id] ?? "special",
      icon, iconSrc: INDUCEMENT_ICONS[icon]?.src ?? "",
      enabled: o.enabled ?? def.enabled,
      cap: o.cap ?? def.cap,
      price: def.price === null ? null : (o.price ?? def.price),
      effectText: standardNote(row),
      default: def,
      ...(def.price === null ? { priceFixed: true } : {}),
    };
  });
  const custom = c.custom.map((x): EffectiveInducement => ({
    id: x.id, name: x.name, source: "custom", category: x.category, icon: x.icon, iconSrc: INDUCEMENT_ICONS[x.icon]?.src ?? "",
    enabled: x.cap > 0, cap: x.cap, price: x.price, effectText: x.effectText,
  }));
  return [...standard, ...custom];
}

export function inducementTableView(league: LeagueRecord, season: SeasonRecord, auth: LeagueApiIdentity | undefined): InducementTableView {
  const c = inducementConfigOf(season);
  return {
    leagueId: league.id, seasonId: season.id, seasonName: season.name, ruleset: season.ruleset, revision: c.revision,
    ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}), ...(c.updatedBy ? { updatedBy: c.updatedBy } : {}),
    table: effectiveInducements(c),
    canEdit: Boolean(auth && (auth.admin || isLeagueOrganiser(league, auth.coach))),
  };
}

/**
 * Validates a whole table from the editor against the stored one. Overrides equal to the dataset value are dropped, so
 * the stored file holds only real changes; custom ids stay as they were and new ones are made here. Throws InducementError.
 */
export function parseInducementConfig(input: Record<string, unknown>, current: SeasonInducements, makeId: () => string = newCustomId): Pick<SeasonInducements, "standard" | "custom"> {
  const rawStandard = input.standard ?? {};
  if (!rawStandard || typeof rawStandard !== "object" || Array.isArray(rawStandard)) throw new InducementError(400, "standard must be an object keyed by inducement id.", "standard");
  const standard: Record<string, InducementOverride> = {};
  for (const [id, raw] of Object.entries(rawStandard as Record<string, unknown>)) {
    const row = Object.prototype.hasOwnProperty.call(bb2025.inducements, id) ? bb2025.inducements[id] : undefined;
    if (!row) throw new InducementError(400, `Unknown inducement "${id.slice(0, 40)}".`, "standard");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InducementError(400, `${row.name}: send { enabled, cap, price }.`, "standard");
    const { enabled, cap, price, ...extra } = raw as Record<string, unknown>;
    if (Object.keys(extra).length) throw new InducementError(400, `${row.name}: only enabled, cap and price can change.`, "standard");
    const o: InducementOverride = {};
    if (enabled !== undefined) {
      if (typeof enabled !== "boolean") throw new InducementError(400, `${row.name}: enabled must be true or false.`, "standard");
      if (enabled !== !row.optIn) o.enabled = enabled;
    }
    if (cap !== undefined) {
      const p = capProblem(cap, row.name);
      if (p) throw new InducementError(400, p, "standard");
      if (cap !== row.max) o.cap = cap as number;
    }
    if (price !== undefined) {
      if (row.cost === null) throw new InducementError(400, `${row.name} has no single price to change.`, "standard");
      const p = priceProblem(price, row.name);
      if (p) throw new InducementError(400, p, "standard");
      if (price !== row.cost) o.price = price as number;
    }
    if (Object.keys(o).length) standard[id] = o;
  }

  const rawCustom = input.custom ?? [];
  if (!Array.isArray(rawCustom)) throw new InducementError(400, "custom must be a list.", "custom");
  if (rawCustom.length > CUSTOM_INDUCEMENTS_MAX) throw new InducementError(400, `At most ${CUSTOM_INDUCEMENTS_MAX} custom inducements.`, "custom");
  const known = new Set(current.custom.map((c) => c.id));
  const ids = new Set<string>();
  const names = new Set(datasetRows().map(([, r]) => r.name.toLowerCase()));
  const custom: CustomInducement[] = [];
  for (const raw of rawCustom) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InducementError(400, "Each custom inducement must be an object.", "custom");
    const r = raw as Record<string, unknown>;
    const problem = customProblem(r);
    if (problem) throw new InducementError(400, problem, "custom");
    const name = plainText(r.name, false)!;
    let id: string;
    if (r.id === undefined || r.id === null || r.id === "") id = makeId();
    else if (typeof r.id === "string" && CUSTOM_INDUCEMENT_ID.test(r.id) && known.has(r.id)) id = r.id;
    else throw new InducementError(400, `${name}: that custom inducement no longer exists. Reload and try again.`, "custom");
    if (ids.has(id)) throw new InducementError(400, `${name} is listed twice.`, "custom");
    ids.add(id);
    if (names.has(name.toLowerCase())) throw new InducementError(400, `There is already an inducement called ${name}.`, "custom");
    names.add(name.toLowerCase());
    custom.push({
      id, name, price: r.price as number, cap: r.cap as number, icon: r.icon as string,
      effectText: plainText(r.effectText ?? "", true)!, category: r.category as InducementCategory,
    });
  }
  return { standard, custom };
}

const newCustomId = (): string => `c-${randomBytes(4).toString("hex")}`;

// ---- the recorder's offers ---------------------------------------------------------------------------------------

/**
 * The tabletop recorder's price source for a match played in a league season: every standard id plus the custom ids,
 * judged by the season's table. Standard rows keep the dataset's restrictions (special rules, Apothecary) and the
 * reduced price (never above the league's price); a disabled row, or one capped at 0, is not offered.
 */
export function seasonInducementOffers(config: SeasonInducements | undefined, optIns: readonly string[] = []): { offers: InducementOffers; ids: string[] } {
  const c = config ?? emptyConfig();
  const enabledOptIns = [...optIns, ...Object.entries(c.standard).filter(([, o]) => o.enabled === true).map(([id]) => id)];
  const base = inducementOffersFor(enabledOptIns);
  const customs = new Map(c.custom.map((x) => [x.id, x]));
  const offers: InducementOffers = (file, id) => {
    const custom = customs.get(id);
    if (custom) return custom.cap > 0 ? { name: custom.name, price: custom.price, max: custom.cap } : { error: `${custom.name} is not offered in this league season.` };
    const row = Object.prototype.hasOwnProperty.call(bb2025.inducements, id) ? bb2025.inducements[id] : undefined;
    const o = c.standard[id] ?? {};
    if (row && (o.enabled === false || !inducementEnabled(row, id, enabledOptIns) || o.cap === 0)) return { error: `${row.name} is not offered in this league season.` };
    const offer = base(file, id);
    if ("error" in offer || !row) return offer;
    const reduced = offer.price !== row.cost;
    return {
      name: offer.name,
      price: o.price === undefined ? offer.price : reduced ? Math.min(offer.price, o.price) : o.price,
      max: o.cap ?? offer.max,
    };
  };
  return { offers, ids: [...Object.keys(bb2025.inducements), ...c.custom.map((x) => x.id)] };
}

/** Display extras for the picker (custom rows only: their icon and effect text). */
export function customOptionExtras(config: SeasonInducements | undefined): Record<string, { icon: string; effectText: string; custom: true }> {
  return Object.fromEntries((config?.custom ?? []).map((x) => [x.id, { icon: INDUCEMENT_ICONS[x.icon]?.src ?? "", effectText: x.effectText, custom: true as const }]));
}

// ---- routes ------------------------------------------------------------------------------------------------------

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => ({ status, headers: NO_STORE, body: { error, ...extra } });

export async function leagueInducementRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, seasonId, third, ...more] = rest;
  if (first !== "seasons" || !seasonId || third !== "inducements" || more.length) return undefined;
  if (method === "GET" || method === "HEAD") {
    if (!league) return fail(404, "League not found.");
    const season = deps.store.season(league.id, seasonId);
    if (!season) return fail(404, "Season not found.");
    return { status: 200, headers: NO_STORE, body: inducementTableView(league, season, auth) };
  }
  if (method !== "PUT") return fail(405, "Use GET or PUT.");
  const early = gate(league, auth);
  if (early) return early;
  const body = await readJsonObject(deps, INDUCEMENTS_MAX_BYTES);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const input = body.value;
  // Judged against the league and season as they are now (after the body arrived); synchronous from here to the write.
  const lg = deps.store.league(league!.id);
  const refused = gate(lg, auth);
  if (refused || !lg) return refused ?? fail(404, "League not found.");
  const season = deps.store.season(lg.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  const current = inducementConfigOf(season);
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return fail(428, "Send the inducement table revision you loaded (revision or If-Match).", { revision: current.revision });
  if (asked === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  if (asked !== current.revision) return fail(409, "The inducement table changed since you opened it. Reload to see the latest.", { revision: current.revision });
  let parsed: Pick<SeasonInducements, "standard" | "custom">;
  try {
    parsed = parseInducementConfig(input, current);
  } catch (e) {
    if (e instanceof InducementError) return fail(e.status, e.message, e.field ? { field: e.field } : {});
    return fail(500, "Could not save the inducement table right now.");
  }
  const who = auth!;
  const now = (deps.now?.() ?? new Date()).toISOString();
  season.rules = { ...(season.rules ?? {}), inducements: { ...parsed, revision: current.revision + 1, updatedAt: now, updatedBy: who.coach } };
  try {
    deps.store.putSeason(season);
  } catch {
    return fail(500, "Could not save the inducement table right now.");
  }
  return { status: 200, headers: NO_STORE, body: { ok: true, ...inducementTableView(lg, season, who) } };
}

function gate(league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined): LeagueApiResult | undefined {
  if (!auth) return fail(401, "Sign in to change the inducement table.");
  if (!league) return fail(404, "League not found.");
  if (!auth.admin && !isLeagueOrganiser(league, auth.coach)) return fail(403, "Only this league's organisers and site admins can change its inducements.");
  return undefined;
}
