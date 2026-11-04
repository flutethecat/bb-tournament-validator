/**
 * Checked readers for the badge pass (badges lane review 11-04, P2-0): the league store's own reads are lenient (an unreadable
 * league or season file is silently left out), which would let one bad file revoke every award it held. These read the
 * same files STRICTLY: a missing directory is empty, but any file that can't be read or parsed, or that names another id,
 * throws, so the engine aborts the pass before anything is written. Cached per file by size and mtime.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEAGUE_ID, SEASON_ID } from "../leagues/store.js";
import type { LeagueRecord, SeasonRecord } from "../leagues/types.js";

export class BadgeSourceError extends Error {}

export class CheckedLeagueReader {
  private readonly root: string;
  private readonly cache = new Map<string, { stamp: string; value: unknown }>();
  /** `stateDir` = FORK_STATE_DIR (the league store keeps its files under <stateDir>/leagues). */
  constructor(stateDir: string) { this.root = join(stateDir, "leagues"); }

  private read<T>(path: string): T {
    let stamp: string;
    let text: string;
    try {
      const st = statSync(path);
      stamp = `${st.size}:${st.mtimeMs}`;
      const hit = this.cache.get(path);
      if (hit && hit.stamp === stamp) return hit.value as T;
      text = readFileSync(path, "utf8");
    } catch (e) { throw new BadgeSourceError(`unreadable league file (${(e as NodeJS.ErrnoException).code ?? "error"})`); }
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new BadgeSourceError("unparsable league file"); }
    if (!value || typeof value !== "object") throw new BadgeSourceError("league file is not an object");
    this.cache.set(path, { stamp, value });
    return value as T;
  }

  private dirs(dir: string): string[] {
    if (!existsSync(dir)) return [];
    try { return readdirSync(dir); } catch { throw new BadgeSourceError("unreadable league directory"); }
  }

  list(): LeagueRecord[] {
    const out: LeagueRecord[] = [];
    for (const id of this.dirs(this.root)) {
      if (!LEAGUE_ID.test(id)) continue;
      const file = join(this.root, id, "league.json");
      if (!existsSync(file)) continue; // a directory without its record (a league being created) is not a league yet
      const rec = this.read<LeagueRecord>(file);
      if (rec.id !== id) throw new BadgeSourceError("league record names another id");
      out.push(rec);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  competitions(leagueId: string): SeasonRecord[] {
    const dir = join(this.root, leagueId, "seasons");
    const out: SeasonRecord[] = [];
    for (const f of this.dirs(dir)) {
      if (!f.endsWith(".json") || !SEASON_ID.test(f.slice(0, -5))) continue;
      const s = this.read<SeasonRecord>(join(dir, f));
      if (s.id !== f.slice(0, -5) || s.leagueId !== leagueId || !Array.isArray(s.fixtures) || !Array.isArray(s.teams)) throw new BadgeSourceError("season record does not match its file");
      out.push(s);
    }
    return out.sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
  }
}
