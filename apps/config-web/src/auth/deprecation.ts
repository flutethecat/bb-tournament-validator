/**
 * Back-compat telemetry for the password→token migration. Clients in the field still send
 * `password` on guarded routes; this release accepts them and COUNTS them so the removal release
 * can be timed on evidence rather than a guess.
 *
 * SR-257 discipline: the counter records the ROUTE only. No coach name, no password, ever —
 * a credential must not reach a log line, and a coach name next to "password auth" is a hint too.
 */

const counters = new Map<string, number>();

export function noteLegacyPasswordAuth(route: string): number {
  const next = (counters.get(route) ?? 0) + 1;
  counters.set(route, next);
  // Log the first hit and then every 25th, so a busy tester box doesn't flood the console.
  if (next === 1 || next % 25 === 0)
    console.warn(`[deprecated-password-auth] route=${route} count=${next} (migrate to POST /api/fork/login + Bearer token)`);
  return next;
}

export function legacyPasswordAuthCounts(): Record<string, number> {
  return Object.fromEntries(counters);
}

/** Test seam only. */
export function resetLegacyPasswordAuthCounts(): void {
  counters.clear();
}
