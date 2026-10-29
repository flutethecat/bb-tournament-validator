/**
 * A league player's stored value (gold) travels in the fork team file as `storedValue` on the <player> element, so
 * result banking can price a death or missed game from it. An empty `storedValue=""` marks a league player with no
 * stored value (it still marks the team as a league team). Every site write path that changes a player's value
 * (advancement, admin skill and stat edits) must shift the stored value by the same delta as the team aggregates.
 */

const OPEN_TAG = /^<player\b[^>]*>/i;

/** The stored value, or undefined when the attribute is absent, empty or not a positive safe integer. */
export function readStoredPlayerValue(playerBlock: string): number | undefined {
  const raw = playerBlock.match(OPEN_TAG)?.[0].match(/\bstoredValue="(\d+)"/i)?.[1];
  const value = raw === undefined ? undefined : Number(raw);
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** True when the team file carries league stored values (any player has a `storedValue` attribute, even empty). */
export function hasStoredPlayerValues(teamXml: string): boolean {
  return /<player\b[^>]*\bstoredValue="/i.test(teamXml);
}

/** Applies a value delta to an existing numeric storedValue; a block without one is returned unchanged. */
export function shiftStoredPlayerValue(playerBlock: string, deltaGold: number): string {
  if (deltaGold === 0) return playerBlock;
  const current = readStoredPlayerValue(playerBlock);
  if (current === undefined) return playerBlock;
  const next = Math.max(0, current + deltaGold);
  return playerBlock.replace(OPEN_TAG, (open) => open.replace(/\bstoredValue="\d+"/i, `storedValue="${next}"`));
}
