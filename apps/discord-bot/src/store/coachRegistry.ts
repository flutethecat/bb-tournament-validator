/**
 * Coach identity library — owner design (decision D4, 2026-07-06).
 * One entry per coach; discordUserId / fumbblName / nafName / nafId all resolve
 * the same person (NAF name/number is the established competitive identifier).
 * JSON-file store with atomic writes; the T1 tournament service reads the same
 * registry for entrant identity later.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type CoachKey = "discordUserId" | "fumbblName" | "nafName" | "nafId";
export const COACH_KEYS: CoachKey[] = ["discordUserId", "fumbblName", "nafName", "nafId"];

export interface CoachTeamRegistration {
  tournament: string;
  teamName: string;
  rosterRace: string;
  /** Discord message link or client/service submission id. */
  sourceRef?: string;
  registeredAt: string;
}

export interface CoachEntry {
  id: string;
  discordUserId?: string;
  fumbblName?: string;
  nafName?: string;
  nafId?: string;
  teams: CoachTeamRegistration[];
  updatedAt: string;
}

export class KeyConflictError extends Error {
  constructor(key: CoachKey, value: string, existing: CoachEntry) {
    super(`${key}:${value} is already registered to coach ${existing.id}.`);
    this.name = "KeyConflictError";
  }
}

const norm = (v: string) => v.trim().toLowerCase();

export class FileCoachRegistry {
  constructor(private readonly filePath: string) {}

  private read(): CoachEntry[] {
    if (!existsSync(this.filePath)) return [];
    return JSON.parse(readFileSync(this.filePath, "utf8")) as CoachEntry[];
  }

  private write(entries: CoachEntry[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  /** Create or update. Enforces key uniqueness across entries. */
  async upsert(patch: Partial<CoachEntry> & { id?: string }): Promise<CoachEntry> {
    const entries = this.read();
    const hasKey = COACH_KEYS.some((k) => patch[k]);
    if (!patch.id && !hasKey) throw new Error("At least one identity key is required.");

    let entry = patch.id ? entries.find((e) => e.id === patch.id) : undefined;
    if (!entry && patch.discordUserId)
      entry = entries.find((e) => e.discordUserId === patch.discordUserId);

    for (const key of COACH_KEYS) {
      const v = patch[key];
      if (!v) continue;
      const clash = entries.find((e) => e !== entry && e[key] && norm(e[key]!) === norm(v));
      if (clash) throw new KeyConflictError(key, v, clash);
    }

    if (!entry) {
      entry = { id: randomUUID(), teams: [], updatedAt: "" };
      entries.push(entry);
    }
    for (const key of COACH_KEYS) if (patch[key]) entry[key] = patch[key];
    entry.updatedAt = new Date().toISOString();
    this.write(entries);
    return entry;
  }

  async lookup(key: CoachKey, value: string): Promise<CoachEntry | undefined> {
    return this.read().find((e) => e[key] && norm(e[key]!) === norm(value));
  }

  async addTeam(coachId: string, team: CoachTeamRegistration): Promise<void> {
    const entries = this.read();
    const entry = entries.find((e) => e.id === coachId);
    if (!entry) throw new Error(`No coach with id ${coachId}.`);
    // one registration per tournament: latest wins
    entry.teams = entry.teams.filter((t) => t.tournament !== team.tournament);
    entry.teams.push(team);
    entry.updatedAt = new Date().toISOString();
    this.write(entries);
  }

  async list(): Promise<CoachEntry[]> {
    return this.read();
  }
}
