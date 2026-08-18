/**
 * Shared brute-force lockout for every coach-credential entry point (the browser portal's
 * `/api/auth/login` and the client's `/api/fork/login`). Extracted from portal.ts so the two
 * doors share ONE counter — otherwise an attacker just alternates doors to double the budget.
 */

export interface LoginAttempt {
  failures: number;
  windowStarted: number;
  lockedUntil: number;
}

export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const MAX_FAILURES = 5;

export const attemptsByIp = new Map<string, LoginAttempt>();
export const attemptsByCoach = new Map<string, LoginAttempt>();

export function normalizeCoach(coach: string): string {
  return coach.trim().toLowerCase();
}

export function attemptState(map: Map<string, LoginAttempt>, key: string, now: number): LoginAttempt {
  const current = map.get(key);
  if (!current || (current.lockedUntil <= now && now - current.windowStarted >= ATTEMPT_WINDOW_MS)) {
    const fresh = { failures: 0, windowStarted: now, lockedUntil: 0 };
    map.set(key, fresh);
    return fresh;
  }
  return current;
}

export function lockoutRemaining(state: LoginAttempt, now: number): number {
  return Math.max(0, state.lockedUntil - now);
}

export function recordFailure(state: LoginAttempt, now: number): void {
  state.failures += 1;
  if (state.failures >= MAX_FAILURES) state.lockedUntil = now + LOCKOUT_MS;
}
