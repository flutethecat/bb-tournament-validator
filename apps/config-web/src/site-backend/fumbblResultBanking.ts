/**
 * Builds the per-team `TeamBankTask`s (banking.ts) from a `ParsedGameResult` — i.e. the `applyFn` that
 * mutates a persisted team XML with the server-computed post-game numbers. This is the greenfield writer
 * the hub/portal spec calls out (spec-team-portal §3, C-2 CE-1). Shapes ruled by Meero SR-185.
 *
 * ⚖ SERVER-DERIVED LAW / CE-1: every field written here is a number the GAME SERVER computed and put in
 * the `FumbblResult` upload — we SET or BANK it, we NEVER recompute a rules outcome, and we NEVER silently
 * coerce (Meero SR-185 general form: reject or quarantine, never silently clamp). Concretely:
 *   • `currentSpps` — verify persisted spendable SPP equals `<starPlayerPoints @current>`, the pre-game
 *     baseline seeded by `GameCache`, then SET to baseline + server-computed `@earned`.
 *   • lifetime stat counters — INCREMENTED by this game's explicit `<statistics>` values
 *     (`FumbblResult.java:399-417`) and `<playerAwards>`→mvps (`:387`). old+thisGame is banking a
 *     server-computed delta, not deriving one.
 *   • serious injuries → `<injuryList>` (SR-185 ruling ②) — APPEND the canonical fork-team injury per the FORK's
 *     OWN team parser schema `RosterPlayer.java:471-477/505-506` (`<injuryList>` of `<injury
 *     [recovering="true"]>NAME</injury>`), NEVER the FUMBBLUI render shape. NAME = the SeriousInjury enum
 *     name the result already carries (`FumbblResult.java:421-427`, serious + decay). A fresh post-game
 *     injury carries `recovering="true"` for its miss-next-game cycle. At the next banking transition,
 *     SeriouslyHurt is removed and other injuries become lasting. Death removes the player from the
 *     playable roster. One authority per dialect; result-schema ⇄ team-schema relate through THIS apply.
 *   • `dedicatedFans` (SR-185 ruling ③) — BANK VERBATIM: `df_new = df_old + dedicatedFansModifier`
 *     (`StepDedicatedFans.modifier()` is the server's delta), then VALIDATE against the BB2025 range and
 *     QUARANTINE (throw ⇒ banking.ts restores the .bak) if out of range. A CLAMP would be a recompute and
 *     would hide corruption at the cheapest catch point — so we do not clamp. The rare legitimate
 *     over-range case (a natural-6 win already at max fans) that quarantines is DATA that the cap is
 *     website-side (owner-class, same family as treasury ①) — surfaced, not silently absorbed.
 *
 *   • BB2025 treasury — BANK the two server-owned components with no rules recomputation:
 *     `treasury_new = treasury_old - treasurySpentOnInducements + winnings`. The BB2025 start sequence
 *     explicitly records the part paid from roster treasury in `treasurySpentOnInducements`; its
 *     `pettyCashUsed` is TV-difference allowance usage and therefore does not touch stored treasury.
 *     `StepWinnings` has already folded stalling and concession into `<winnings>`; `stalled` is
 *     display/audit state here and MUST NOT cause another subtraction.
 *     Legacy-only `fanFactorModifier` / `pettyCashTransferred` / `spirallingExpenses` payloads are
 *     rejected before any team task is built because their website-side composition is not BB2025.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bb2025 } from "@bb/validator/dataset";
import type { TeamBankTask } from "./banking.js";
import type { ParsedGameResult, ParsedPlayerResult, ParsedTeamResult } from "./fumbblResult.js";

/**
 * BB2025 dedicated-fans valid range used by Team Builder and league management: 0..7.
 * NOT a fork constant (the fork's `Team.dedicatedFans` is an unbounded int; the cap is a rules bound
 * applied website-side). Used ONLY as a QUARANTINE bound per SR-185 ③ — never as a clamp.
 */
const DF_MIN = 0;
const DF_MAX = 7;

/** Lifetime per-player counters in the FUMBBL team XML, mapped to the result's this-game field. */
const STAT_INCREMENTS: ReadonlyArray<{ teamTag: string; from: (p: ParsedPlayerResult) => number }> = [
  { teamTag: "completions", from: (p) => p.completions },
  { teamTag: "touchdowns", from: (p) => p.touchdowns },
  { teamTag: "interceptions", from: (p) => p.interceptions },
  { teamTag: "casualties", from: (p) => p.casualties },
  { teamTag: "mvps", from: (p) => p.playerAwards },
  { teamTag: "passing", from: (p) => p.passing },
  { teamTag: "rushing", from: (p) => p.rushing },
  { teamTag: "blocks", from: (p) => p.blocks },
  { teamTag: "fouls", from: (p) => p.fouls },
];

const escXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function insertPlayerStatistics(playerBlock: string, content: string, attributes = ""): string {
  if (/<playerStatistics\b/i.test(playerBlock)) throw new Error("persistent playerStatistics is malformed or duplicated");
  const element = `<playerStatistics${attributes ? ` ${attributes}` : ""}>${content}</playerStatistics>`;
  const boundary = playerBlock.search(/<(?:skillList|injuryList|advancementList|pendingAdvancement)\b/i);
  return boundary < 0 ? `${playerBlock}${element}` : `${playerBlock.slice(0, boundary)}${element}${playerBlock.slice(boundary)}`;
}

function assertStatisticsOpening(opening: string): void {
  if (opening.slice(1).includes("<")) throw new Error("persistent playerStatistics is malformed");
}

/** Set an attribute on a specific `<playerStatistics ...>` opening tag inside a player block. */
function setCurrentSpps(playerBlock: string, current: number): string {
  if (!Number.isSafeInteger(current) || current < 0) throw new Error("currentSpps is not a safe nonnegative integer");
  const openings = [...playerBlock.matchAll(/<playerStatistics\b[^>]*>/gi)];
  if (openings.length === 0) return insertPlayerStatistics(playerBlock, "", `currentSpps="${current}"`);
  if (openings.length !== 1) throw new Error("persistent player must contain at most one playerStatistics element");
  const opening = openings[0]![0];
  assertStatisticsOpening(opening);
  const assignments = [...opening.matchAll(/\bcurrentSpps\s*=/gi)];
  if (assignments.length > 1) throw new Error("playerStatistics has duplicate currentSpps attributes");
  if (assignments.length === 1) {
    const exact = opening.match(/\bcurrentSpps="(\d+)"/i);
    if (!exact || !Number.isSafeInteger(Number(exact[1]))) throw new Error("playerStatistics has malformed currentSpps");
    return playerBlock.replace(opening, opening.replace(/\bcurrentSpps="\d+"/i, `currentSpps="${current}"`));
  }
  return playerBlock.replace(opening, opening.replace(/<playerStatistics\b/i, `<playerStatistics currentSpps="${current}"`));
}

/** Lifetime earned SPP is distinct from the spendable current balance. The result carries this-game
 *  earned as a server-derived delta, so bank it onto the team XML for Team Library progression display. */
function addEarnedSpps(playerBlock: string, earned: number | undefined): string {
  if (earned === undefined || earned === 0) return playerBlock;
  if (!Number.isSafeInteger(earned) || earned < 0) throw new Error("earned SPP delta is not a safe nonnegative integer");
  let openings = [...playerBlock.matchAll(/<playerStatistics\b[^>]*>/gi)];
  if (openings.length === 0) {
    playerBlock = insertPlayerStatistics(playerBlock, "");
    openings = [...playerBlock.matchAll(/<playerStatistics\b[^>]*>/gi)];
  }
  if (openings.length !== 1) throw new Error("earned SPP requires at most one playerStatistics element");
  const opening = openings[0]![0];
  assertStatisticsOpening(opening);
  const readAttribute = (name: "earnedSpps" | "trackedSpps"): number | undefined => {
    const assignments = [...opening.matchAll(new RegExp(`\\b${name}\\s*=`, "gi"))];
    if (assignments.length > 1) throw new Error(`playerStatistics has duplicate ${name} attributes`);
    if (!assignments.length) return undefined;
    const exact = opening.match(new RegExp(`\\b${name}="(\\d+)"`, "i"));
    const value = exact ? Number(exact[1]) : Number.NaN;
    if (!Number.isSafeInteger(value)) throw new Error(`playerStatistics has malformed ${name}`);
    return value;
  };
  const lifetime = readAttribute("earnedSpps");
  const tracked = readAttribute("trackedSpps");
  if (lifetime !== undefined && tracked !== undefined) throw new Error("playerStatistics mixes lifetime and tracked SPP provenance");

  let attribute: "earnedSpps" | "trackedSpps";
  let next: number;
  if (lifetime !== undefined) {
    attribute = "earnedSpps";
    next = lifetime + earned;
  } else if (tracked !== undefined || /<skill\b[^>]*>[^<]+<\/skill>/i.test(playerBlock)) {
    // An imported player with unaudited acquired skills has no provable lifetime baseline.
    attribute = "trackedSpps";
    next = (tracked ?? 0) + earned;
  } else {
    // No acquired advancement means post-match current SPP is the exact lifetime total when present.
    const current = opening.match(/\bcurrentSpps="(\d+)"/i);
    attribute = current ? "earnedSpps" : "trackedSpps";
    next = current ? Number(current[1]) : earned;
  }
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${attribute} would overflow or become invalid`);
  if (new RegExp(`\\b${attribute}="\\d+"`, "i").test(opening)) {
    return playerBlock.replace(opening, opening.replace(new RegExp(`\\b${attribute}="\\d+"`, "i"), `${attribute}="${next}"`));
  }
  return playerBlock.replace(opening, opening.replace(/<playerStatistics\b/i, `<playerStatistics ${attribute}="${next}"`));
}

/** Increment a represented lifetime counter; authoritative nonzero deltas must never disappear. */
function bumpCounter(scope: string, tag: string, delta: number): string {
  if (delta === 0) return scope;
  if (!Number.isSafeInteger(delta)) throw new Error(`${tag} delta is not a safe integer`);
  let stats = [...scope.matchAll(/<playerStatistics\b[^>]*>[\s\S]*?<\/playerStatistics>/gi)];
  const selfClosing = [...scope.matchAll(/<playerStatistics\b[^>]*\/>/gi)];
  if (stats.length + selfClosing.length === 0) {
    return insertPlayerStatistics(scope, `<${tag}>${delta}</${tag}>`);
  }
  if (stats.length + selfClosing.length !== 1) throw new Error(`nonzero ${tag} delta requires at most one playerStatistics element`);
  if (selfClosing.length === 1) {
    const expanded = selfClosing[0]![0].replace(/\s*\/>$/, `><${tag}>${delta}</${tag}></playerStatistics>`);
    return scope.replace(selfClosing[0]![0], expanded);
  }
  const statsElement = stats[0]![0];
  assertStatisticsOpening(statsElement.match(/^<playerStatistics\b[^>]*>/i)?.[0] ?? statsElement);
  const occurrences = [...statsElement.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"))];
  if (occurrences.length === 0) {
    return scope.replace(statsElement, statsElement.replace(/<\/playerStatistics>$/i, `<${tag}>${delta}</${tag}></playerStatistics>`));
  }
  if (occurrences.length !== 1) throw new Error(`stored playerStatistics has duplicate ${tag} counters`);
  const element = occurrences[0]![0];
  const exact = element.match(new RegExp(`^<${tag}\\b[^>]*>\\s*(-?\\d+)\\s*</${tag}>$`, "i"));
  if (!exact) throw new Error(`stored ${tag} counter is malformed`);
  const prior = Number(exact[1]);
  const next = prior + delta;
  const signed = tag === "passing" || tag === "rushing";
  if (!Number.isSafeInteger(prior) || !Number.isSafeInteger(next) || (!signed && (prior < 0 || next < 0))) {
    throw new Error(`stored ${tag} counter cannot be updated safely`);
  }
  return scope.replace(element, element.replace(exact[1]!, String(next)));
}

/**
 * Append serious injuries to a player block's `<injuryList>` (SR-185 ②, fork-parser schema). Handles the
 * empty self-closing `<injuryList/>` and the populated `<injuryList>…</injuryList>` forms. A block with no
 * injuryList at all is left untouched (defensive — composed teams always carry the element).
 */
function appendInjuries(playerBlock: string, injuries: string[]): string {
  if (injuries.length === 0) return playerBlock;
  const entries = injuries.map((name) => `<injury recovering="true">${escXml(name)}</injury>`).join("");
  const selfClosing = [...playerBlock.matchAll(/<injuryList\b[^>]*\/>/gi)];
  const populated = [...playerBlock.matchAll(/<injuryList\b[^>]*>[\s\S]*?<\/injuryList>/gi)];
  const tokens = [...playerBlock.matchAll(/<injuryList\b/gi)];
  if (tokens.length !== selfClosing.length + populated.length) throw new Error("persistent player injuryList is malformed or duplicated");
  if (selfClosing.length + populated.length > 1) throw new Error("persistent player injuryList is malformed or duplicated");
  if (selfClosing.length === 1) return playerBlock.replace(selfClosing[0]![0], `<injuryList>${entries}</injuryList>`);
  if (populated.length === 1) return playerBlock.replace(populated[0]![0], populated[0]![0].replace(/<\/injuryList>$/i, `${entries}</injuryList>`));
  if (/<injuryList\b/i.test(playerBlock)) throw new Error("persistent player injuryList is malformed or duplicated");
  return `${playerBlock}<injuryList>${entries}</injuryList>`;
}

function appendGainedHatred(playerBlock: string, keywords: string[]): string {
  const additions = [...new Set(keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))];
  if (!additions.length) return playerBlock;
  const hatred = playerBlock.match(/<skill\b([^>]*)>\s*Hatred\s*<\/skill>/i);
  if (hatred) {
    const current = hatred[1]!.match(/\bvalue="([^"]*)"/i)?.[1]?.split(";").map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [];
    const value = [...new Set([...current, ...additions])].join(";");
    const replacement = /\bvalue="[^"]*"/i.test(hatred[1]!)
      ? hatred[0].replace(/\bvalue="[^"]*"/i, `value="${escXml(value)}"`)
      : hatred[0].replace(/<skill\b/i, `<skill value="${escXml(value)}"`);
    return playerBlock.replace(hatred[0], replacement);
  }
  const entry = `<skill value="${escXml(additions.join(";"))}">Hatred</skill>`;
  if (/<skillList\s*\/>/i.test(playerBlock)) return playerBlock.replace(/<skillList\s*\/>/i, `<skillList>${entry}</skillList>`);
  if (/<\/skillList>/i.test(playerBlock)) return playerBlock.replace(/<\/skillList>/i, `${entry}</skillList>`);
  throw new Error("gained Hatred cannot be represented because skillList is missing");
}

const injuryKey = (name: string): string => name.replace(/[^a-z]/gi, "").toLowerCase();
const isDeadInjury = (name: string): boolean => ["dead", "deadrip", "rip", "death"].includes(injuryKey(name));
const hasRecoveringInjury = (player: string): boolean => /<injury\b[^>]*\brecovering="true"/i.test(player);

const elementText = (scope: string, tag: string): string | undefined =>
  scope.match(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`, "i"))?.[1]?.trim();

const positionForPlayer = (roster: string, player: string): string | undefined => {
  const positionId = elementText(player, "positionId") ?? player.match(/<player\b[^>]*\bpositionId="([^"]+)"/i)?.[1];
  if (!positionId) return undefined;
  const escaped = escapeRe(positionId);
  return roster.match(new RegExp(`<position\\b[^>]*\\bid="${escaped}"[^>]*>[\\s\\S]*?</position>`, "i"))?.[0];
};

const skillNames = (scope: string): string[] =>
  [...scope.matchAll(/<skill\b[^>]*>([^<]*)<\/skill>/gi)].map((match) => match[1]!.trim()).filter(Boolean);

function playerRuntimeValue(player: string, roster: string): number {
  const position = positionForPlayer(roster, player);
  if (!position) throw new Error("post-match TV cannot resolve a player's roster position");
  const base = Number(elementText(position, "cost"));
  if (!Number.isSafeInteger(base) || base < 0) throw new Error("post-match TV found an invalid roster position cost");
  const characteristicScopeEnd = player.search(/<(?:playerStatistics|skillList|injuryList|advancementList|pendingAdvancement)\b/i);
  const characteristicScope = characteristicScopeEnd < 0 ? player : player.slice(0, characteristicScopeEnd);
  for (const tag of ["movement", "strength", "agility", "passing", "armour"] as const) {
    const overrides = [...characteristicScope.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"))];
    if (overrides.length > 1) throw new Error(`post-match TV found duplicate player ${tag} overrides`);
    if (!overrides.length) continue;
    const exact = overrides[0]![0].match(new RegExp(`^<${tag}\\b[^>]*>\\s*(\\d+)\\s*</${tag}>$`, "i"));
    const positionValue = Number(elementText(position, tag));
    const playerValue = exact ? Number(exact[1]) : Number.NaN;
    if (!Number.isSafeInteger(positionValue) || !Number.isSafeInteger(playerValue)) {
      throw new Error(`post-match TV found a malformed player ${tag} override`);
    }
    if (playerValue !== positionValue) {
      throw new Error(`post-match TV cannot safely price unexplained player ${tag} override ${playerValue} from roster ${positionValue}`);
    }
  }
  const intrinsic = new Set(skillNames(position).map((name) => name.toLowerCase()));
  const doubleCategories = new Set(
    [...position.matchAll(/<double>([^<]*)<\/double>/gi)].map((match) => match[1]!.trim()),
  );
  let value = base;
  for (const name of skillNames(player)) {
    if (intrinsic.has(name.toLowerCase())) continue;
    const characteristic = name.toUpperCase().match(/^\+(MA|ST|AG|PA|AV)$/)?.[1] as "MA" | "ST" | "AG" | "PA" | "AV" | undefined;
    if (characteristic) {
      if (characteristic === "MA") {
        throw new Error("post-match TV cannot safely price +MA across the sanctioned API and fork runtime dialects");
      }
      value += ({ ST: 60_000, AG: 30_000, PA: 20_000, AV: 10_000 } as const)[characteristic];
      continue;
    }
    const entry = Object.entries(bb2025.skills).find(([skill]) => skill.toLowerCase() === name.toLowerCase());
    if (entry?.[1].trait) continue;
    if (!entry?.[1].category) throw new Error(`post-match TV cannot price unknown skill ${name}`);
    if (entry[1].elite) throw new Error(`post-match TV cannot safely price Elite skill ${name}`);
    if (doubleCategories.has(entry[1].category)) {
      throw new Error(`post-match TV cannot safely price unaudited Secondary skill ${name}`);
    }
    value += 20_000;
  }
  return value;
}

function adjustAggregateValues(xml: string, totalDeltaGold: number, currentDeltaGold: number): string {
  if (totalDeltaGold === 0 && currentDeltaGold === 0) return xml;
  const playerAt = xml.search(/<player\b/i);
  const header = playerAt < 0 ? xml : xml.slice(0, playerAt);
  const tail = playerAt < 0 ? "" : xml.slice(playerAt);
  const builder = /<(?:teamRating|teamStrength)>/i.test(header);
  const updates: Array<[string, number, "gold" | "units"]> = [
    ["teamValue", totalDeltaGold, "gold"],
    ["tournamentWeight", totalDeltaGold, "gold"],
    ["currentTeamValue", currentDeltaGold, builder ? "units" : "gold"],
    ["teamRating", totalDeltaGold, "units"],
    ["teamStrength", currentDeltaGold, "units"],
    ["rating", totalDeltaGold, "units"],
    ["strength", currentDeltaGold, "units"],
  ];
  let nextHeader = header;
  for (const [tag, delta, dialect] of updates) {
    if (delta === 0) continue;
    const amount = dialect === "units" ? delta / 10_000 : delta;
    if (!Number.isSafeInteger(amount)) throw new Error(`post-match TV delta for ${tag} is not representable`);
    const anyTag = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi");
    const occurrences = [...nextHeader.matchAll(anyTag)];
    if (occurrences.length === 0) continue;
    if (occurrences.length !== 1) throw new Error(`post-match TV found duplicate ${tag} aggregates`);
    const exact = occurrences[0]![0].match(new RegExp(`^<${tag}\\b[^>]*>\\s*(-?\\d+)\\s*</${tag}>$`, "i"));
    if (!exact) throw new Error(`post-match TV found a malformed ${tag} aggregate`);
    const current = Number(exact[1]);
    const next = current + amount;
    if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(next) || next < 0) {
      throw new Error(`post-match TV cannot safely update ${tag}`);
    }
    nextHeader = nextHeader.replace(occurrences[0]![0], occurrences[0]![0].replace(exact[1]!, String(next)));
  }
  return nextHeader + tail;
}

function rosterForTeam(teamsDir: string | undefined, teamId: string): string | undefined {
  if (!teamsDir) return undefined;
  const safeId = teamId.replace(/[^\w.-]+/g, "_");
  const path = join(dirname(teamsDir), "rosters", `roster_team_${safeId}.xml`);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** A team match advances the prior MNG slot before applying this game's new casualties. */
function recoverPriorInjuries(xml: string): string {
  return xml.replace(/<injury\b([^>]*)\brecovering="true"([^>]*)>([^<]*)<\/injury>/gi, (_match, before: string, after: string, name: string) => {
    if (["seriouslyhurt", "seriouslyhurtmng"].includes(injuryKey(name))) return "";
    const attrs = `${before}${after}`.trim();
    return `<injury${attrs ? ` ${attrs}` : ""}>${name}</injury>`;
  });
}

/** Apply this game's numbers to ONE `<player ... id="PLAYERID">…</player>` block. Server-derived only. */
function applyToPlayerBlock(block: string, pr: ParsedPlayerResult): string {
  let out = bankCurrentSpps(block, pr.currentSpps, pr.earnedSpps);
  out = addEarnedSpps(out, pr.earnedSpps);
  for (const s of STAT_INCREMENTS) out = bumpCounter(out, s.teamTag, s.from(pr));
  out = appendGainedHatred(out, pr.gainedHatred);
  out = appendInjuries(out, pr.injuries);
  return out;
}

/**
 * Apply the team-level dedicated-fans delta (SR-185 ③). BANK VERBATIM `df + modifier`; THROW (⇒ the whole
 * team apply quarantines, banking.ts restores the .bak) if the result is out of the BB2025 range — never
 * clamp. No-op only when the result carries no modifier (serializer omits it at 0).
 */
function applyDedicatedFans(teamXml: string, modifier: number | undefined): string {
  if (modifier === undefined || modifier === 0) return teamXml;
  const occurrences = [
    ...teamXml.matchAll(/<dedicatedFans\b[^>]*>[\s\S]*?<\/dedicatedFans>/gi),
    ...teamXml.matchAll(/<fanFactor\b[^>]*>[\s\S]*?<\/fanFactor>/gi),
  ];
  if (occurrences.length !== 1) throw new Error("nonzero dedicatedFans modifier requires exactly one stored dedicatedFans/fanFactor value");
  const element = occurrences[0]![0];
  const tag = /^<fanFactor\b/i.test(element) ? "fanFactor" : "dedicatedFans";
  const m = element.match(new RegExp(`^<${tag}\\b[^>]*>\\s*(\\d+)\\s*</${tag}>$`, "i"));
  if (!m) throw new Error("stored dedicatedFans value is malformed");
  const prior = Number(m[1]);
  const next = prior + modifier;
  if (!Number.isSafeInteger(prior) || !Number.isSafeInteger(next)) throw new Error("dedicatedFans cannot be updated safely");
  if (next < DF_MIN || next > DF_MAX) {
    throw new Error(
      `dedicatedFans ${m[1]} + modifier ${modifier} = ${next} is outside BB2025 range [${DF_MIN},${DF_MAX}] ` +
        `— banking verbatim would corrupt; quarantining (SR-185 ③: never silently clamp). If this is a ` +
        `legitimate at-cap result, the cap is website-side (owner-class, escalate like treasury).`,
    );
  }
  return teamXml.replace(element, element.replace(m[1]!, String(next)));
}

/** Read the fork roster player's spendable SPP baseline. Missing statistics/currentSpps is canonical 0. */
function readCurrentSpps(playerBlock: string): number {
  const openings = [...playerBlock.matchAll(/<playerStatistics\b[^>]*>/gi)];
  if (openings.length === 0) {
    if (/<playerStatistics\b/i.test(playerBlock)) throw new Error("persistent playerStatistics is malformed");
    return 0;
  }
  if (openings.length !== 1) throw new Error("persistent player must contain at most one playerStatistics element");
  const opening = openings[0]![0];
  assertStatisticsOpening(opening);
  const assignments = [...opening.matchAll(/\bcurrentSpps\s*=/gi)];
  if (assignments.length > 1) throw new Error("playerStatistics has duplicate currentSpps attributes");
  if (!assignments.length) return 0;
  const exact = opening.match(/\bcurrentSpps="(\d+)"/i);
  const current = exact ? Number(exact[1]) : Number.NaN;
  if (!Number.isSafeInteger(current) || current < 0) throw new Error("playerStatistics has malformed currentSpps");
  return current;
}

function bankCurrentSpps(playerBlock: string, baseline: number | undefined, earned: number | undefined): string {
  if (baseline === undefined && earned === undefined) return playerBlock;
  if (baseline === undefined || earned === undefined) throw new Error("server SPP result is missing its baseline or earned delta");
  const persisted = readCurrentSpps(playerBlock);
  if (persisted !== baseline) {
    throw new Error(`server SPP baseline ${baseline} does not match persisted currentSpps ${persisted}`);
  }
  const next = baseline + earned;
  if (!Number.isSafeInteger(next) || next < 0) throw new Error("currentSpps result would overflow or become invalid");
  return setCurrentSpps(playerBlock, next);
}

/**
 * Apply the BB2025 server-owned treasury components exactly once inside the normal per-team ledger.
 * `winnings` and `treasurySpentOnInducements` are omitted by the serializer when zero, so absence is
 * the exact zero delta. `pettyCashUsed` is deliberately not part of this equation: in the BB2025
 * inducement step it is the TV-difference allowance consumed after the treasury contribution has
 * already been split into `treasurySpentOnInducements`.
 */
function applyBb2025Treasury(teamXml: string, team: ParsedTeamResult): string {
  const winnings = team.winnings ?? 0;
  const spent = team.treasurySpentOnInducements ?? 0;

  // Team-level state must live before the first player. Do not accept a nested/player treasury tag.
  const playerAt = teamXml.search(/<player\b/i);
  const header = playerAt < 0 ? teamXml : teamXml.slice(0, playerAt);
  const tail = playerAt < 0 ? "" : teamXml.slice(playerAt);
  const occurrences = [...header.matchAll(/<treasury\b[^>]*>[\s\S]*?<\/treasury>/gi)];
  if (occurrences.length !== 1) {
    throw new Error("BB2025 banking requires exactly one stored treasury value");
  }
  const element = occurrences[0]![0];
  const exact = element.match(/^<treasury>\s*(\d+)\s*<\/treasury>$/i);
  if (!exact) throw new Error("stored treasury value is malformed");
  const prior = Number(exact[1]);
  if (!Number.isSafeInteger(prior) || prior < 0 || spent > prior) {
    throw new Error(`stored treasury ${exact[1]} cannot fund server-recorded inducement spend ${spent}`);
  }
  const next = prior - spent + winnings;
  if (!Number.isSafeInteger(next) || next < 0) throw new Error("BB2025 treasury update would overflow or become negative");
  return header.replace(element, element.replace(exact[1]!, String(next))) + tail;
}

/** Reject fields whose only step-owned producers belong to pre-BB2020/BB2025 banking contracts. */
function assertBb2025ResultContract(team: ParsedTeamResult): void {
  if (team.fanFactorModifier !== undefined) {
    throw new Error(`team ${team.teamId} carries legacy fanFactorModifier; BB2025 banking refuses it`);
  }
  if (team.spirallingExpenses !== undefined) {
    throw new Error(`team ${team.teamId} carries legacy spirallingExpenses; BB2025 banking refuses it`);
  }
  if (team.pettyCashTransferred !== undefined) {
    throw new Error(`team ${team.teamId} carries legacy pettyCashTransferred; BB2025 banking refuses it`);
  }
  if (team.conceded && team.players.some((player) => player.currentSpps !== undefined || player.earnedSpps !== undefined)) {
    throw new Error(`team ${team.teamId} conceded but carries starPlayerPoints cleared by canonical BB2025 end-game`);
  }
  if (team.players.some((player) => player.defecting) && (!team.conceded || team.concededLegally !== false)) {
    throw new Error(`team ${team.teamId} carries server defection outside an illegal concession`);
  }
}

/**
 * Build the applyFn for one team: apply the team-level df delta, then for each player result find its
 * `<player id="…">` block and apply the server numbers. Unknown playerIds are skipped (a star/merc in the
 * result that isn't a persisted roster player has no lifetime record to bank). A thrown df-range violation
 * propagates ⇒ banking.ts quarantines this team without a partial write.
 */
function makeApplyFn(team: ParsedTeamResult, roster: string | undefined): (xml: string) => string {
  return (xml: string): string => {
    const persistedIds = [...xml.matchAll(/<player\b([^>]*)>/gi)].map((match) => {
      const id = match[1]!.match(/\bid="([^"]+)"/i)?.[1];
      if (!id) throw new Error("persistent team XML contains a player without an id");
      return id;
    });
    if (new Set(persistedIds).size !== persistedIds.length) throw new Error("persistent team XML contains duplicate player ids");
    const resultIds = new Set(team.players.map((player) => player.playerId).filter((id): id is string => Boolean(id)));
    const omitted = persistedIds.find((id) => !resultIds.has(id));
    if (omitted) throw new Error(`server result omitted persistent player ${omitted}; recovery and counters cannot be banked safely`);
    const header = xml.slice(0, Math.max(0, xml.search(/<player\b/i)) || xml.length);
    const tracksTotalValue = /<(?:teamValue|tournamentWeight|teamRating|rating)>/i.test(header);
    const tracksCurrentValue = /<(?:currentTeamValue|teamStrength|strength)>/i.test(header);
    let out = applyBb2025Treasury(
      applyDedicatedFans(recoverPriorInjuries(xml), team.dedicatedFansModifier),
      team,
    );
    let totalDelta = 0;
    let currentDelta = 0;
    for (const pr of team.players) {
      if (!pr.playerId) continue;
      const re = new RegExp(`(<player\\b[^>]*\\bid="${escapeRe(pr.playerId)}"[^>]*>)([\\s\\S]*?)(</player>)`);
      const before = xml.match(re)?.[0];
      if (!before) {
        const transient = new Set(["star", "mercenary", "riotousrookie", "infamousstaff"]);
        const normalizedType = pr.playerType?.replace(/[^a-z]/gi, "").toLowerCase();
        if (normalizedType === "raisedfromdead" || normalizedType === "plagueridden") {
          throw new Error(`server-created ${pr.playerType} player ${pr.playerId} requires an unsupported roster insertion contract`);
        }
        if (!normalizedType || !transient.has(normalizedType)) {
          throw new Error(`persistent ${pr.playerType ?? "unknown"} player ${pr.playerId} is missing from team XML`);
        }
        continue;
      }
      out = out.replace(re, (_m, open: string, inner: string, close: string) => {
        if (pr.defecting || pr.injuries.some(isDeadInjury)) return "";
        const living = { ...pr, injuries: pr.injuries.filter((injury) => !isDeadInjury(injury)) };
        const postConcession = team.conceded ? setCurrentSpps(inner, 0) : inner;
        return `${open}${applyToPlayerBlock(postConcession, living)}${close}`;
      });
      const after = out.match(re)?.[0];
      const died = after === undefined;
      const beforeEligible = !hasRecoveringInjury(before);
      const afterEligible = after !== undefined && !hasRecoveringInjury(after);
      const needsValue = (died && (tracksTotalValue || (beforeEligible && tracksCurrentValue))) ||
        (tracksCurrentValue && beforeEligible !== afterEligible);
      if (needsValue) {
        if (!roster) throw new Error("post-match TV transition cannot be represented without the authoritative roster XML");
        const value = playerRuntimeValue(before, roster);
        if (died) {
          totalDelta -= value;
          if (beforeEligible) currentDelta -= value;
        } else if (beforeEligible && !afterEligible) currentDelta -= value;
        else if (!beforeEligible && afterEligible) currentDelta += value;
      }
    }
    return adjustAggregateValues(out, totalDelta, currentDelta);
  };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One `TeamBankTask` per team in the result. Feed straight into `bankGameResult`. */
export function buildBankTasks(result: ParsedGameResult, teamsDir?: string): TeamBankTask[] {
  // Validate the whole upload before returning any mutable task. A mixed legacy/BB2025 payload must
  // not apply one team and fail on the other.
  if (result.teams.length !== 2) throw new Error(`BB2025 result requires exactly two teamResult elements; found ${result.teams.length}`);
  for (const team of result.teams) assertBb2025ResultContract(team);
  return result.teams.map((team) => ({
    teamId: team.teamId,
    applyFn: makeApplyFn(team, rosterForTeam(teamsDir, team.teamId)),
  }));
}

/** Unsupported legacy treasury components. Clean BB2025 results have no residuals. */
export interface UnbankedResidual {
  teamId: string;
  fanFactorModifier?: number;
  spirallingExpenses?: number;
  pettyCashTransferred?: number;
}

export function unbankedResidual(result: ParsedGameResult): UnbankedResidual[] {
  return result.teams.flatMap((team) => {
    return team.fanFactorModifier !== undefined || team.spirallingExpenses !== undefined || team.pettyCashTransferred !== undefined
      ? [{ teamId: team.teamId, fanFactorModifier: team.fanFactorModifier, spirallingExpenses: team.spirallingExpenses,
        pettyCashTransferred: team.pettyCashTransferred }]
      : [];
  });
}
