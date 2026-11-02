// Test sign-in rule (registration spec Q13, owner 11-02): a test sign-in session (src/auth/testLogin.ts) may write only in
// competitions marked `test: true` (created by a test session or marked by an admin), so registration flows can be UAT'd
// with test coaches while every real competition stays out of reach. A real session is unaffected.

import { RegistrationError } from "./types.js";

export const TEST_SESSION_REFUSAL = "Test sign-in sessions can only change test competitions.";

/** May this session write in this competition? Real sessions: always (other checks still apply). Test sessions: only in
 *  a competition marked test. A missing competition is never a test competition. */
export function testSessionMayWrite(session: { test?: boolean } | undefined, competition: { test?: boolean } | undefined): boolean {
  if (!session?.test) return true;
  return competition?.test === true;
}

/** Throws a 403 RegistrationError when a test session writes in a competition not marked test. */
export function assertTestSessionMayWrite(session: { test?: boolean } | undefined, competition: { test?: boolean } | undefined): void {
  if (!testSessionMayWrite(session, competition)) throw new RegistrationError(403, "test-session", TEST_SESSION_REFUSAL);
}
