/**
 * Effective roster limits for one race under one package: what a Roster Builder needs to drive its controls (player count,
 * the Sevens non-Lineman cap and Veteran picker, staff prices and caps, the inducement list, the skill allowance) without
 * re-deriving the validator's rules. Every value comes from the same resolution validate() uses (loadPackage + the Sevens
 * profile, resolveTeamConfig, the staff pricer, the package's inducement catalog), so the builder and the validator agree.
 * Works for standard packages too (format "standard", maxPlayers 16, standard staff prices). Pure.
 */

import { costGold } from "../cost/costGold";
import { effectiveStaffPrices, STANDARD_STAFF_PRICES } from "../cost/staff";
import { hasLinemanKeyword, SEVENS_VETERAN_MA_DELTA } from "../dataset/bb2025/sevens";
import { inducementCatalog, inducementReducedFor, usesSevensInducements } from "../dataset/inducements";
import { findRoster, normName } from "../dataset/lookup";
import type { Dataset } from "../dataset/types";
import { resolveTeamConfig } from "./resolveConfig";
import type { InducementSet, PackageFormat, TournamentPackage } from "./types";

export interface RosterLimitsStaffRow {
  /** Gold per unit (rerolls: the package's flat price, or the roster's own when the package keeps roster prices). */
  price: number;
  /** Most the team may buy (package cap, and for rerolls also the roster's own maximum); null = no cap. */
  max: number | null;
}

export interface RosterLimitsInducement {
  id: string;
  name: string;
  /** Price for THIS team (the reduced price when its special rules or roster unlock one); null = not fixed. */
  price: number | null;
  /** Cap for this team (package cap, else the list's; the reduced cap when unlocked); null = no cap. */
  max: number | null;
  /** The package allows it (inducements.allowed). */
  allowed: boolean;
  /** This team may buy it (roster restriction, required special rule, apothecary); false comes with a plain `reason`. */
  available: boolean;
  reason?: string;
}

export interface RosterLimits {
  format: PackageFormat;
  /** Canonical race name (dataset spelling). */
  race: string;
  /** Gold cap for this race (tier / team rule aware); null = no cap. */
  budget: number | null;
  minPlayers: number;
  maxPlayers: number;
  /** Most players without the Lineman keyword; null = no such cap (standard). */
  maxNonLineman: number | null;
  /** The race's positions WITHOUT the Lineman keyword (what counts toward maxNonLineman); [] when there is no cap. */
  nonLinemanPositions: string[];
  /** Sevens Veteran: required, the positions that may be it (Lineman keyword), and the printed MA change; null = no Veteran. */
  veteran: { required: true; eligiblePositions: string[]; maDelta: number } | null;
  /** True when the validator recomputes staff gold from counts at these prices (the package sets staffPrices). */
  staffPriced: boolean;
  staff: {
    reRolls: RosterLimitsStaffRow;
    assistantCoaches: RosterLimitsStaffRow;
    cheerleaders: RosterLimitsStaffRow;
    /** max 0 when the roster can't hire an Apothecary. */
    apothecary: RosterLimitsStaffRow;
    /** `start` = Dedicated Fans the team gets free (priced beyond these); `min` = fewest the team may have (the start,
     *  when the package prices staff: Sevens Free Create 1, Matched Play 0). */
    dedicatedFans: RosterLimitsStaffRow & { start: number; min: number };
  };
  starPlayersAllowed: boolean;
  inducementSet: InducementSet;
  inducements: RosterLimitsInducement[];
  skills: {
    tier: number | null;
    /** COUNT mode (both null = the SP budget applies instead). */
    maxPrimary: number | null;
    maxSecondary: number | null;
    secondarySwap: boolean;
    secondarySwapRatio: number;
    secondarySwapMax: number | null;
    skillPointBudget: number;
    maxPerPlayer: number | null;
    eliteMaxTotal: number | null;
    /** Gold an added skill adds to team value (Sevens: 0 by default). */
    gold: { primary: number; secondary: number; elitePrimary: number; eliteSecondary: number };
  };
}

const minCap = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a == null ? (b ?? null) : b == null ? a : Math.min(a, b);

/**
 * The effective limits for `race` under `pkg` (a RESOLVED package, i.e. loadPackage output). `specialRules` = the team's
 * special rules for inducement prices / availability (default: the dataset roster's own). Undefined when the race isn't
 * in the dataset.
 */
export function effectiveRosterLimits(
  pkg: TournamentPackage,
  race: string,
  data: Dataset,
  opts: { specialRules?: readonly string[] } = {},
): RosterLimits | undefined {
  const roster = findRoster(data, race);
  if (!roster) return undefined;
  const cfg = resolveTeamConfig(pkg, roster.name);
  const format: PackageFormat = pkg.format === "sevens" ? "sevens" : "standard";
  const specialRules = opts.specialRules ?? roster.specialRules;
  const rules = new Set(specialRules.map(normName));
  const maxNonLineman = pkg.special.maxNonLineman ?? null;
  const fansStart = pkg.sideline.dedicatedFansStart ?? 1;
  const priced = effectiveStaffPrices(pkg);
  const prices = priced ?? STANDARD_STAFF_PRICES;
  const catalog = inducementCatalog(pkg, data);
  const allAllowed = pkg.inducements.allowed.includes("*");
  const inducements: RosterLimitsInducement[] = Object.entries(catalog)
    .filter(([, row]) => usesSevensInducements(pkg) || !row.optIn)
    .map(([id, row]) => {
      const reduced = inducementReducedFor(row, specialRules, roster.name);
      const onlyFor = pkg.inducements.rosterOnly?.[id];
      const reason =
        onlyFor && !onlyFor.some((r) => normName(r) === normName(roster.name))
          ? `Only for ${onlyFor.join(" / ")} teams.`
          : row.requiresSpecialRule && !rules.has(normName(row.requiresSpecialRule))
            ? `Only for teams with ${row.requiresSpecialRule}.`
            : row.requiresApothecary && !roster.apothecaryAllowed
              ? "Only for teams that can hire an Apothecary."
              : undefined;
      return {
        id,
        name: row.name,
        price: reduced && row.reducedCost != null ? row.reducedCost : row.cost,
        max: pkg.inducements.caps[id] ?? (reduced ? row.reducedMax ?? row.max : row.max) ?? null,
        allowed: allAllowed || pkg.inducements.allowed.includes(id),
        available: reason === undefined,
        ...(reason ? { reason } : {}),
      };
    });
  const sa = pkg.skillAllotment;
  const plain = { ...sa, eliteSkills: [], skillCostGold: {} };
  const elite = { ...sa, eliteSkills: ["__elite__"], skillCostGold: {} };
  return {
    format,
    race: roster.name,
    budget: cfg.gold,
    minPlayers: pkg.special.minPlayers,
    maxPlayers: pkg.special.maxPlayers ?? 16,
    maxNonLineman,
    nonLinemanPositions: maxNonLineman == null ? [] : roster.positions.filter((p) => !hasLinemanKeyword(p)).map((p) => p.name),
    veteran:
      pkg.special.veteran === true
        ? { required: true, eligiblePositions: roster.positions.filter((p) => hasLinemanKeyword(p)).map((p) => p.name), maDelta: SEVENS_VETERAN_MA_DELTA }
        : null,
    staffPriced: priced !== null,
    staff: {
      reRolls: { price: prices.reRoll ?? roster.reRollCost, max: minCap(pkg.sideline.maxReRolls, roster.maxReRolls) },
      assistantCoaches: { price: prices.assistantCoach, max: pkg.sideline.maxAssistantCoaches },
      cheerleaders: { price: prices.cheerleader, max: pkg.sideline.maxCheerleaders },
      apothecary: { price: prices.apothecary, max: roster.apothecaryAllowed ? minCap(pkg.sideline.maxApothecary, 1) : 0 },
      dedicatedFans: { price: prices.dedicatedFan, max: pkg.sideline.maxDedicatedFans, start: fansStart, min: priced ? fansStart : 0 },
    },
    starPlayersAllowed: cfg.starPlayersAllowed,
    inducementSet: usesSevensInducements(pkg) ? "sevens" : "core",
    inducements,
    skills: {
      tier: cfg.tierNumber ?? null,
      maxPrimary: cfg.maxPrimary,
      maxSecondary: cfg.maxSecondary,
      secondarySwap: cfg.secondarySwap,
      secondarySwapRatio: cfg.secondarySwapRatio,
      secondarySwapMax: cfg.secondarySwapMax,
      skillPointBudget: cfg.skillPointBudget,
      maxPerPlayer: sa.maxPerPlayer,
      eliteMaxTotal: cfg.eliteMaxTotal,
      gold: {
        primary: costGold("__plain__", "primary", plain),
        secondary: costGold("__plain__", "secondary", plain),
        elitePrimary: costGold("__elite__", "primary", elite),
        eliteSecondary: costGold("__elite__", "secondary", elite),
      },
    },
  };
}
