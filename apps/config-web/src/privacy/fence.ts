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

export function isCoachFenced(name: string, now = Date.now()): boolean {
  if (fenced.size === 0 || !name) return false;
  const hash = coachKeyHash(name);
  const until = fenced.get(hash);
  if (until === undefined) return false;
  if (until <= now) { fenced.delete(hash); return false; }
  return true;
}

export function assertNotFenced(name: string): void {
  if (isCoachFenced(name)) throw new DeletionFenceError();
}

/** Tests only. */
export function clearFences(): void { fenced.clear(); }

// ---- reserved pseudonym names --------------------------------------------------------------------------------------

export const PSEUDONYM_PREFIX = "Deleted coach #";

/** True for anything that reads as "Deleted coach…": NFKC, case-folded, with spaces, punctuation and format characters removed. */
export function isReservedCoachName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const folded = name.normalize("NFKC").toLowerCase().replace(/[\s\p{Cf}\p{P}\p{S}_]/gu, "");
  return folded.startsWith("deletedcoach");
}

export const RESERVED_NAME_MESSAGE = "That coach name is reserved.";

export class ReservedNameError extends Error {
  readonly status = 400;
  constructor() { super(RESERVED_NAME_MESSAGE); }
}
