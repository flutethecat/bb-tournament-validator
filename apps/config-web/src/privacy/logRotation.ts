// Server-side log rotation (privacy notice: logs are kept 14 days). config-web's output is redirected to files by the
// host's task (data-store/config-web.log, *.out, *.err); this module rotates them from inside the server: at startup and
// daily, a live log last written before today is renamed with its date (config-web.log.2026-10-30), or, where the OS holds
// the file open (Windows redirection), copied to that name and truncated; dated files older than 14 days are deleted.

import { copyFileSync, existsSync, readdirSync, renameSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const LOG_RETENTION_DAYS = 14;
const LIVE = /\.(log|out|err)$/;
const DATED = /^(.+\.(?:log|out|err))\.(\d{4}-\d{2}-\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface RotationResult { rotated: string[]; deleted: string[] }

export function rotateLogs(dir: string, now = Date.now(), retentionDays = LOG_RETENTION_DAYS): RotationResult {
  const result: RotationResult = { rotated: [], deleted: [] };
  if (!existsSync(dir)) return result;
  const today = day(now);
  const cutoff = day(now - retentionDays * DAY_MS);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const dated = DATED.exec(name);
    try {
      if (dated) {
        if (dated[2]! < cutoff) { unlinkSync(path); result.deleted.push(name); }
        continue;
      }
      if (!LIVE.test(name)) continue;
      const stat = statSync(path);
      if (!stat.isFile() || stat.size === 0) continue;
      const stamp = day(stat.mtimeMs);
      if (stamp >= today) continue;
      const target = `${path}.${stamp}`;
      if (existsSync(target)) continue;
      try { renameSync(path, target); } catch { copyFileSync(path, target); truncateSync(path, 0); }
      result.rotated.push(name);
    } catch { /* one stuck file never blocks the rest; retried on the next sweep */ }
  }
  return result;
}

/** Rotate now and then once a day; the timer never keeps the process alive. */
export function startLogRotation(dirs: string[], log: (line: string) => void = console.log): void {
  const run = (): void => {
    for (const dir of dirs) {
      const out = rotateLogs(dir);
      if (out.rotated.length || out.deleted.length) log(`[logs] rotated=${out.rotated.length} deleted=${out.deleted.length} dir=${dir}`);
    }
  };
  run();
  setInterval(run, DAY_MS).unref();
}
