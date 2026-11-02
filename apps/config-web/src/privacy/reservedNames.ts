/**
 * Reserved coach names, dependency-free (no node: imports) so the SPA's coach-name step (/app/welcome) runs the same
 * check as every server writer. Re-exported by src/privacy/fence.ts, which stays the import for server code.
 *
 * "Deleted coach #<n>" is the pseudonym of deleted accounts: no account may be created, signed in or renamed to anything
 * that reads as it, whatever the case, spacing or Unicode form.
 */

export const PSEUDONYM_PREFIX = "Deleted coach #";

/** True for anything that reads as "Deleted coach…": NFKC, case-folded, with spaces, punctuation and format characters removed. */
export function isReservedCoachName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const folded = name.normalize("NFKC").toLowerCase().replace(/[\s\p{Cf}\p{P}\p{S}_]/gu, "");
  return folded.startsWith("deletedcoach");
}

export const RESERVED_NAME_MESSAGE = "That coach name is reserved.";
