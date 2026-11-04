/**
 * The badge store (badges lane, 11-04): <FORK_STATE_DIR>/badges/badges.json, one file.
 *
 *   auto     the site badges and achievements the engine derived (src/badges/engine.ts): one row per subject per badge (per
 *            tier, per race). Rewritten only by the engine's diff, never by hand.
 *   leagues  per league: the organiser's custom badges (name, description, icon from BADGE_ICONS, scope) and the awards they
 *            gave by hand, with the league's badge revision (every write names it: 428 missing, 409 stale).
 *   log      every award and revoke (site and organiser), every custom badge create / edit / archive, newest first, capped.
 *   seeded   badge ids the engine has evaluated before: a NEW catalog entry (or the very first run) awards silently, so a
 *            deploy never floods inboxes or Discord with history.
 *
 * Reads are strict: only "no file yet" is empty; an unreadable or unparsable file throws (callers fail closed).
 * Coach data: subject names and the `by` of a log row / custom award. Exported and removed by the privacy collectors
 * (src/privacy/collectors.ts "badges").
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import type { AwardContext } from "./evaluators.js";

export interface BadgeSubject { kind: "coach" | "team"; key: string; name: string }

export interface StoredAward {
  /** Earned key (evaluators.ts earnedKey). */
  key: string;
  badgeId: string;
  variant?: string;
  subject: BadgeSubject;
  /** When it was earned (the game / milestone time). */
  at: string;
  /** When the site recorded it. */
  awardedAt: string;
  context: AwardContext;
}

export type CustomScope = "coach" | "team" | "both";

export interface CustomBadge {
  id: string;
  name: string;
  description: string;
  icon: string;
  scope: CustomScope;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface CustomAward {
  id: string;
  badgeId: string;
  /** coach: key = the coach key; team: key = the team key, seasonId / teamId = where it was picked. */
  subject: BadgeSubject & { seasonId?: string; teamId?: string };
  /** The coach of the team at the time (team awards): who the notice went to. */
  coach?: string;
  note?: string;
  by: string;
  at: string;
}

export interface LeagueBadges { revision: number; badges: CustomBadge[]; awards: CustomAward[] }

export type BadgeLogAction = "award" | "revoke" | "create" | "edit" | "archive";
export interface BadgeLogEntry {
  id: string;
  at: string;
  action: BadgeLogAction;
  badgeId: string;
  variant?: string;
  subject?: BadgeSubject;
  /** The organiser or admin; "" = the site (an automatic award or revoke). */
  by: string;
  leagueId?: string;
  reason?: string;
}

export interface BadgeFile {
  version: 1;
  initialisedAt?: string;
  seeded: string[];
  /** Award key -> when it was first recorded: announced at most once ever (kept when the award is revoked). */
  announced?: Record<string, string>;
  auto: StoredAward[];
  leagues: Record<string, LeagueBadges>;
  log: BadgeLogEntry[];
}

export const BADGE_LOG_CAP = 5000;

export class BadgeStoreError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const emptyBadgeFile = (): BadgeFile => ({ version: 1, seeded: [], auto: [], leagues: {}, log: [] });

export const badgesFile = (stateDir: string): string => join(stateDir, "badges", "badges.json");

export class BadgeStore {
  readonly file: string;
  constructor(stateDir: string) { this.file = badgesFile(stateDir); }

  /** Strict read: ENOENT = empty; anything else throws (fail closed). */
  read(): BadgeFile {
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return emptyBadgeFile();
      throw new BadgeStoreError(503, "Badges are unavailable right now.");
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new BadgeStoreError(503, "Badges are unavailable right now."); }
    const f = data as Partial<BadgeFile> | null;
    if (!f || typeof f !== "object" || f.version !== 1 || !Array.isArray(f.auto) || !Array.isArray(f.log) || !f.leagues || typeof f.leagues !== "object") {
      throw new BadgeStoreError(503, "Badges are unavailable right now.");
    }
    return { version: 1, ...(f.initialisedAt ? { initialisedAt: f.initialisedAt } : {}), seeded: Array.isArray(f.seeded) ? f.seeded : [], ...(f.announced && typeof f.announced === "object" ? { announced: f.announced } : {}), auto: f.auto, leagues: f.leagues, log: f.log };
  }

  /** A cheap stamp (size + mtime) that changes whenever the file does: callers holding a copy re-read only when it moved. */
  stamp(): string {
    try { const st = statSync(this.file); return `${st.size}:${st.mtimeMs}`; } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return "none";
      throw new BadgeStoreError(503, "Badges are unavailable right now.");
    }
  }

  write(file: BadgeFile): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    file.log = file.log.slice(0, BADGE_LOG_CAP);
    atomicWriteTextFile(this.file, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** Read-modify-write in one synchronous step (no await between the read and the write). */
  update<T>(fn: (file: BadgeFile) => T): T {
    const file = this.read();
    const out = fn(file);
    this.write(file);
    return out;
  }

  league(file: BadgeFile, leagueId: string): LeagueBadges {
    return file.leagues[leagueId] ?? { revision: 0, badges: [], awards: [] };
  }
}
