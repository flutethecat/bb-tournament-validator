/**
 * Account deletion guards that every store checks at WRITE time (privacy review P1-5, P2-6). Dependency-free so the
 * identities store, the saves store, the avatar store and the session store can all import it.
 *
 * - Deletion fence: once a coach's delete job starts, writes that would (re)create their data are refused until the
 *   job is done plus a grace period (a request authorised before the delete can land after it). Keyed by a hash of the
 *   identity-store key, so the fence itself names nobody.
 * - Reserved names: "Deleted coach #<n>" is the pseudonym of deleted accounts; no account may be created, signed in or
 *   renamed to anything that reads as it, whatever the case, spacing or Unicode form.
 */
import { createHash } from "node:crypto";

/** EXACTLY the identity store's key function (normalizeFfbCoachId); test/privacy.test.ts pins the equality. */
export const coachKey = (name: string): string => name.trim().toLowerCase();
/** The fence key: NFC then the identity fold, as the avatar store folds names (coachAvatarId). Broader than coachKey on
 *  purpose: a decomposed and a composed spelling of one name are fenced together, whichever one a write arrives with. */
export const fenceKey = (name: string): string => coachKey(name.normalize("NFC"));
export const coachKeyHash = (name: string): string => createHash("sha256").update(`coach:${fenceKey(name)}`, "utf8").digest("hex");

export class DeletionFenceError extends Error {
  readonly status = 409;
  constructor() { super("This account is being deleted."); }
}

export const FENCE_GRACE_MS = 10 * 60_000;
/** key hash -> release time (Infinity while the job runs). */
const fenced = new Map<string, number>();

export function fenceCoachHash(hash: string): void { fenced.set(hash, Number.POSITIVE_INFINITY); }
/** The job finished: keep refusing for the grace period, then forget. */
export function releaseCoachHash(hash: string, now = Date.now(), graceMs = FENCE_GRACE_MS): void { fenced.set(hash, now + graceMs); }

/** The hash journals written before the NFC fence key stored (identity fold only). Still checked, so a legacy job fences. */
export const legacyCoachKeyHash = (name: string): string => createHash("sha256").update(`coach:${coachKey(name)}`, "utf8").digest("hex");

export function isCoachFenced(name: string, now = Date.now()): boolean {
  if (fenced.size === 0 || !name) return false;
  for (const hash of new Set([coachKeyHash(name), legacyCoachKeyHash(name)])) {
    const until = fenced.get(hash);
    if (until === undefined) continue;
    if (until <= now) { fenced.delete(hash); continue; }
    return true;
  }
  return false;
}

export function assertNotFenced(name: string): void {
  if (isCoachFenced(name)) throw new DeletionFenceError();
}

/** Tests only. */
export function clearFences(): void { fenced.clear(); }

// ---- reserved pseudonym names --------------------------------------------------------------------------------------

// The check itself lives in ./reservedNames.ts (no node: imports) so the SPA's coach-name step shares it.
import { RESERVED_NAME_MESSAGE } from "./reservedNames.js";
export { isReservedCoachName, PSEUDONYM_PREFIX, RESERVED_NAME_MESSAGE } from "./reservedNames.js";

export class ReservedNameError extends Error {
  readonly status = 400;
  constructor() { super(RESERVED_NAME_MESSAGE); }
}
