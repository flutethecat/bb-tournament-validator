// Competition filters (global site search, owner 11-04): ruleset, region, format (season / ladder / tournament), played on
// (tabletop / Super FUMBBL) and open for registration. ONE implementation, shared by the server's GET /api/search and the
// SPA (the Search page and Browse leagues' Played on / Registration open chips), so the two never drift apart. Pure.

import { countryByCode } from "../auth/countries.js";
import { foldQuery, foldText } from "./text.js";

export type CompetitionFormat = "season" | "ladder" | "tournament";
export const COMPETITION_FORMATS: readonly CompetitionFormat[] = ["season", "ladder", "tournament"];
export const FORMAT_LABEL: Readonly<Record<CompetitionFormat, string>> = { season: "Season", ladder: "Ladder", tournament: "Tournament" };

export type PlayedOn = "tabletop" | "fork";
export const PLAYED_ON: readonly PlayedOn[] = ["tabletop", "fork"];
export const PLAYED_ON_LABEL: Readonly<Record<PlayedOn, string>> = { tabletop: "Tabletop", fork: "Super FUMBBL" };

/** What a league, ladder or tournament offers to the filters. */
export interface CompetitionFacets {
  /** Ruleset names: the ruleset card (a package name) and the base edition ("BB2025"). */
  rulesets: string[];
  /** ISO country code of its region. */
  country?: string;
  /** Free region text (its region text, plus a league's town / state). */
  regionText?: string;
  formats: CompetitionFormat[];
  playedOn: PlayedOn;
  registrationOpen: boolean;
}

export interface CompetitionFilters {
  rulesets: string[];
  countries: string[];
  /** Free text matched (folded, anywhere) against the region text and the country's name. */
  region: string;
  formats: CompetitionFormat[];
  playedOn: PlayedOn[];
  registrationOpen: boolean;
}

export const RULESET_FILTER_MAX = 120;
export const REGION_FILTER_MAX = 80;
const LIST_MAX = 10;

export const emptyCompetitionFilters = (): CompetitionFilters => ({ rulesets: [], countries: [], region: "", formats: [], playedOn: [], registrationOpen: false });

export const competitionFiltersActive = (f: CompetitionFilters): boolean =>
  f.rulesets.length > 0 || f.countries.length > 0 || f.region.trim() !== "" || f.formats.length > 0 || f.playedOn.length > 0 || f.registrationOpen;

export function passesCompetitionFilters(c: CompetitionFacets, f: CompetitionFilters): boolean {
  if (f.rulesets.length) {
    const have = new Set(c.rulesets.map((r) => foldText(r)));
    if (!f.rulesets.some((r) => have.has(foldText(r)))) return false;
  }
  if (f.countries.length && !(c.country && f.countries.includes(c.country))) return false;
  const region = foldQuery(f.region);
  if (region) {
    const hay = foldText([c.regionText ?? "", c.country ? countryByCode(c.country)?.name ?? "" : "", c.country ?? ""].join(" | "));
    if (!hay.includes(region)) return false;
  }
  if (f.formats.length && !c.formats.some((x) => f.formats.includes(x))) return false;
  if (f.playedOn.length && !f.playedOn.includes(c.playedOn)) return false;
  if (f.registrationOpen && !c.registrationOpen) return false;
  return true;
}

/** Repeated and comma-joined values (rulesets only repeat: a package name may hold a comma). */
const listParam = (params: URLSearchParams, key: string, max: number, split = true): string[] =>
  [...new Set(params.getAll(key).flatMap((v) => (split ? v.split(",") : [v])).map((v) => v.trim()).filter(Boolean).map((v) => v.slice(0, max)))].slice(0, LIST_MAX);

/** The filters of a query string (?ruleset=&country=&region=&format=&playedOn=&open=1); unknown values are dropped. */
export function parseCompetitionFilters(params: URLSearchParams): CompetitionFilters {
  return {
    rulesets: listParam(params, "ruleset", RULESET_FILTER_MAX, false),
    countries: listParam(params, "country", 2).map((c) => c.toUpperCase()).filter((c) => countryByCode(c)),
    region: (params.get("region") ?? "").trim().slice(0, REGION_FILTER_MAX),
    formats: listParam(params, "format", 12).filter((x): x is CompetitionFormat => (COMPETITION_FORMATS as readonly string[]).includes(x)),
    playedOn: listParam(params, "playedOn", 12).filter((x): x is PlayedOn => (PLAYED_ON as readonly string[]).includes(x)),
    registrationOpen: params.get("open") === "1" || params.get("open") === "true",
  };
}

/** The query-string pairs for the filters (only the active ones), in a stable order. */
export function competitionFilterParams(f: CompetitionFilters): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const r of f.rulesets) out.push(["ruleset", r]);
  if (f.countries.length) out.push(["country", f.countries.join(",")]);
  if (f.region.trim()) out.push(["region", f.region.trim()]);
  if (f.formats.length) out.push(["format", f.formats.join(",")]);
  if (f.playedOn.length) out.push(["playedOn", f.playedOn.join(",")]);
  if (f.registrationOpen) out.push(["open", "1"]);
  return out;
}
