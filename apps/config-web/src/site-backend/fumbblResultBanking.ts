/**
 * Builds the per-team `TeamBankTask`s (banking.ts) from a `ParsedGameResult` — i.e. the `applyFn` that
 * mutates a persisted team XML with the server-computed post-game numbers. This is the greenfield writer
 * the hub/portal spec calls out (spec-team-portal §3, C-2 CE-1). Shapes ruled by Meero SR-185.
 *
 * ⚖ SERVER-DERIVED LAW / CE-1: every field written here is a number the GAME SERVER computed and put in
 * the `FumbblResult` upload — we SET or BANK it, we NEVER recompute a rules outcome, and we NEVER silently
 * coerce (Meero SR-185 general form: reject or quarantine, never silently clamp). Concretely:
 *   • `currentSpps` — SET to `<starPlayerPoints @current>`, the authoritative post-game TOTAL (NOT
 *     old+earned; the server already did that sum). Cited: `FumbblResult.java:353` current=getCurrentSpps().
 *   • lifetime stat counters — INCREMENTED by this game's explicit `<statistics>` values
 *     (`FumbblResult.java:399-417`) and `<playerAwards>`→mvps (`:387`). old+thisGame is banking a
 *     server-computed delta, not deriving one.
 *   • serious injuries → `<injuryList>` (SR-185 ruling ②) — APPEND `<injury>NAME</injury>` per the FORK's
 *     OWN team parser schema `RosterPlayer.java:471-477/505-506` (`<injuryList>` of `<injury
 *     [recovering="true"]>NAME</injury>`), NEVER the FUMBBLUI render shape. NAME = the SeriousInjury enum
 *     name the result already carries (`FumbblResult.java:421-427`, serious + decay). A fresh post-game
 *     injury is a LASTING entry (no `recovering` attr — that flag marks the transient miss-next slot, not
 *     a new lasting injury). One authority per dialect; result-schema ⇄ team-schema relate through THIS
 *     apply, not by copying.
 *   • `dedicatedFans` (SR-185 ruling ③) — BANK VERBATIM: `df_new = df_old + dedicatedFansModifier`
 *     (`StepDedicatedFans.modifier()` is the server's delta), then VALIDATE against the BB2025 range and
 *     QUARANTINE (throw ⇒ banking.ts restores the .bak) if out of range. A CLAMP would be a recompute and
 *     would hide corruption at the cheapest catch point — so we do not clamp. The rare legitimate
 *     over-range case (a natural-6 win already at max fans) that quarantines is DATA that the cap is
 *     website-side (owner-class, same family as treasury ①) — surfaced, not silently absorbed.
 *
 * 🔴 STILL NOT WRITTEN (owner-class, flagged via {@link unbankedResidual}, never dropped): the TREASURY /
 * winnings / spiralling-expenses / petty-cash composition. The final treasury is NOT in the result (only
 * the COMPONENTS) and the composition rule is fumbbl.com website-side, absent from fork source AND the
 * FUMBBLUI-derived contract (SR-185: owner-class, Christer-1:1). Inventing it would violate CE-1.
 */

import type { TeamBankTask } from "./banking.js";
import type { ParsedGameResult, ParsedPlayerResult, ParsedTeamResult } from "./fumbblResult.js";

/**
 * BB2025 dedicated-fans valid range (RULES-SOURCE: bloodbowlbase.ru/bb2025 — dedicated fans are 1..6).
 * NOT a fork constant (the fork's `Team.dedicatedFans` is an unbounded int; the cap is a rules bound
 * applied website-side). Used ONLY as a QUARANTINE bound per SR-185 ③ — never as a clamp.
 */
const DF_MIN = 1;
const DF_MAX = 6;

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

/** Set an attribute on a specific `<playerStatistics ...>` opening tag inside a player block. */
function setCurrentSpps(playerBlock: string, current: number): string {
  if (/<playerStatistics\b[^>]*\bcurrentSpps="[^"]*"/.test(playerBlock)) {
    return playerBlock.replace(/(<playerStatistics\b[^>]*\bcurrentSpps=")[^"]*(")/, `$1${current}$2`);
  }
  // No currentSpps attribute present ⇒ add one to the opening tag (defensive; composed teams always have it).
  return playerBlock.replace(/<playerStatistics\b/, `<playerStatistics currentSpps="${current}"`);
}

/** Lifetime earned SPP is distinct from the spendable current balance. The result carries this-game
 *  earned as a server-derived delta, so bank it onto the team XML for Team Library progression display. */
function addEarnedSpps(playerBlock: string, earned: number | undefined): string {
  if (earned === undefined || earned === 0) return playerBlock;
  const opening = playerBlock.match(/<playerStatistics\b[^>]*>/)?.[0];
  if (!opening) return playerBlock;
  const prior = Number(opening.match(/\bearnedSpps="(\d+)"/)?.[1] ?? 0);
  const next = prior + earned;
  if (/\bearnedSpps="\d+"/.test(opening)) {
    return playerBlock.replace(/(<playerStatistics\b[^>]*\bearnedSpps=")\d+("[^>]*>)/, `$1${next}$2`);
  }
  return playerBlock.replace(/<playerStatistics\b/, `<playerStatistics earnedSpps="${next}"`);
}

/** Increment a `<tag>N</tag>` counter inside a scope by `delta` (no-op if delta 0 or tag absent). */
function bumpCounter(scope: string, tag: string, delta: number): string {
  if (delta === 0) return scope;
  return scope.replace(new RegExp(`(<${tag}>)(\\d+)(</${tag}>)`), (_m, a, n, b) => `${a}${Number(n) + delta}${b}`);
}

/**
 * Append serious injuries to a player block's `<injuryList>` (SR-185 ②, fork-parser schema). Handles the
 * empty self-closing `<injuryList/>` and the populated `<injuryList>…</injuryList>` forms. A block with no
 * injuryList at all is left untouched (defensive — composed teams always carry the element).
 */
function appendInjuries(playerBlock: string, injuries: string[]): string {
  if (injuries.length === 0) return playerBlock;
  const entries = injuries.map((name) => `<injury>${escXml(name)}</injury>`).join("");
  if (/<injuryList\s*\/>/.test(playerBlock)) {
    return playerBlock.replace(/<injuryList\s*\/>/, `<injuryList>${entries}</injuryList>`);
  }
  if (/<injuryList\b[^>]*>[\s\S]*?<\/injuryList>/.test(playerBlock)) {
    return playerBlock.replace(/<\/injuryList>/, `${entries}</injuryList>`);
  }
  return playerBlock;
}

/** Apply this game's numbers to ONE `<player ... id="PLAYERID">…</player>` block. Server-derived only. */
function applyToPlayerBlock(block: string, pr: ParsedPlayerResult): string {
  let out = block;
  if (pr.currentSpps !== undefined) out = setCurrentSpps(out, pr.currentSpps);
  out = addEarnedSpps(out, pr.earnedSpps);
  for (const s of STAT_INCREMENTS) out = bumpCounter(out, s.teamTag, s.from(pr));
  out = appendInjuries(out, pr.injuries);
  return out;
}

/**
 * Apply the team-level dedicated-fans delta (SR-185 ③). BANK VERBATIM `df + modifier`; THROW (⇒ the whole
 * team apply quarantines, banking.ts restores the .bak) if the result is out of the BB2025 range — never
 * clamp. No-op when the result carries no modifier (serializer omits it at 0) or the team has no
 * `<dedicatedFans>` element.
 */
function applyDedicatedFans(teamXml: string, modifier: number | undefined): string {
  if (modifier === undefined || modifier === 0) return teamXml;
  const m = teamXml.match(/<dedicatedFans>(\d+)<\/dedicatedFans>/);
  if (!m) return teamXml;
  const next = Number(m[1]) + modifier;
  if (next < DF_MIN || next > DF_MAX) {
    throw new Error(
      `dedicatedFans ${m[1]} + modifier ${modifier} = ${next} is outside BB2025 range [${DF_MIN},${DF_MAX}] ` +
        `— banking verbatim would corrupt; quarantining (SR-185 ③: never silently clamp). If this is a ` +
        `legitimate at-cap result, the cap is website-side (owner-class, escalate like treasury).`,
    );
  }
  return teamXml.replace(/<dedicatedFans>\d+<\/dedicatedFans>/, `<dedicatedFans>${next}</dedicatedFans>`);
}

/**
 * Build the applyFn for one team: apply the team-level df delta, then for each player result find its
 * `<player id="…">` block and apply the server numbers. Unknown playerIds are skipped (a star/merc in the
 * result that isn't a persisted roster player has no lifetime record to bank). A thrown df-range violation
 * propagates ⇒ banking.ts quarantines this team without a partial write.
 */
function makeApplyFn(team: ParsedTeamResult): (xml: string) => string {
  return (xml: string): string => {
    let out = applyDedicatedFans(xml, team.dedicatedFansModifier);
    for (const pr of team.players) {
      if (!pr.playerId) continue;
      const re = new RegExp(`(<player\\b[^>]*\\bid="${escapeRe(pr.playerId)}"[^>]*>)([\\s\\S]*?)(</player>)`);
      out = out.replace(re, (_m, open: string, inner: string, close: string) => `${open}${applyToPlayerBlock(inner, pr)}${close}`);
    }
    return out;
  };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One `TeamBankTask` per team in the result. Feed straight into `bankGameResult`. */
export function buildBankTasks(result: ParsedGameResult): TeamBankTask[] {
  return result.teams.map((team) => ({ teamId: team.teamId, applyFn: makeApplyFn(team) }));
}

/** The server-computed numbers a v1 apply deliberately does NOT bank — the TREASURY composition (owner-
 *  class, SR-185 ①). Surfaced so the caller records them alongside the ledger instead of dropping them
 *  silently. SPP / stats / injuries / dedicatedFans are now banked, so they are NOT residual. */
export interface UnbankedResidual {
  teamId: string;
  winnings?: number;
  spirallingExpenses?: number;
  treasurySpentOnInducements?: number;
  pettyCashTransferred?: number;
  pettyCashUsed?: number;
}

export function unbankedResidual(result: ParsedGameResult): UnbankedResidual[] {
  return result.teams.map((team) => ({
    teamId: team.teamId,
    winnings: team.winnings,
    spirallingExpenses: team.spirallingExpenses,
    treasurySpentOnInducements: team.treasurySpentOnInducements,
    pettyCashTransferred: team.pettyCashTransferred,
    pettyCashUsed: team.pettyCashUsed,
  }));
}
