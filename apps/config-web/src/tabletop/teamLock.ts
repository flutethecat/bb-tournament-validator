/**
 * One lock domain per tabletop TEAM (coach + team save): every write that reads or moves a team chain's head, or pins it
 * (match creation, every serialised match write including confirm / undo / publish journals and their recovery, and the
 * Team Captain appoint / revoke), runs under the locks of the teams it touches, so none of them interleave.
 * Locks are taken in sorted key order (no deadlock) and are not re-entrant: never call withTeamLocks inside itself for
 * the same team. Match writes take their match lock (api.ts serial) first, then the team locks; nothing holding a team
 * lock waits for a match lock.
 */
const queues = new Map<string, Promise<unknown>>();

export const teamLockKey = (s: { coach: string; teamSaveId: string }): string => `${s.coach}\0${s.teamSaveId}`;

function lockOne<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

export function withTeamLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(keys)].sort();
  const step = (i: number): Promise<T> => (i >= sorted.length ? fn() : lockOne(sorted[i]!, () => step(i + 1)));
  return step(0);
}

/** The team locks of a match (both seats). */
export const matchTeamKeys = (m: { home: { coach: string; teamSaveId: string }; away: { coach: string; teamSaveId: string } }): string[] =>
  [teamLockKey(m.home), teamLockKey(m.away)];
