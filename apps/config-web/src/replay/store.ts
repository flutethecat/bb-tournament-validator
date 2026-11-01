// The replay moments cache: <dataDir>/replay-moments/<gameId>.json, one file per fork game, written once by the
// background job (job.ts) so each game is read from the fork ONCE. Versioned: a file from another schema or reader
// version reads as absent and is read again.

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import type { ReplayMoment, ReplaySide, ReplayTeam } from "./moments.js";

export const REPLAY_SCHEMA = 1;
/** Bump when the derivation changes what it reads: every cached game is read again. */
export const REPLAY_READER_VERSION = 2;
export const REPLAY_DIR = "replay-moments";

export interface ReplayReady {
  schema: typeof REPLAY_SCHEMA;
  reader: number;
  gameId: string;
  status: "ready";
  readAt: string;
  commands: number;
  truncated: boolean;
  teams: Record<ReplaySide, ReplayTeam>;
  moments: ReplayMoment[];
}

export interface ReplayUnavailable {
  schema: typeof REPLAY_SCHEMA;
  reader: number;
  gameId: string;
  status: "unavailable";
  readAt: string;
  /** The fork's answer ("Replay Unavailable") or the guard that kept the reader away. */
  reason: string;
}

export type ReplayEntry = ReplayReady | ReplayUnavailable;

const SAFE_ID = /^[0-9]{1,18}$/;

let replayCoachFilter: ((coach: string) => string | undefined) | undefined;
/** Account deletion: a coach name -> pseudonym (deleted coaches only), applied to the teams of every stored replay. */
export function setReplayCoachFilter(fn: ((coach: string) => string | undefined) | undefined): void { replayCoachFilter = fn; }
function filteredTeams<T extends Record<string, { coach: string }>>(teams: T): T {
  const out = { ...teams } as Record<string, { coach: string }>;
  for (const [side, team] of Object.entries(teams)) {
    const swapped = team && typeof team.coach === "string" ? replayCoachFilter?.(team.coach) : undefined;
    if (swapped) out[side] = { ...team, coach: swapped };
  }
  return out as T;
}

export class ReplayMomentStore {
  readonly dir: string;
  private writes = 0;

  constructor(dataDir: string) {
    this.dir = join(dataDir, REPLAY_DIR);
  }

  private file(gameId: string): string | undefined {
    return SAFE_ID.test(gameId) ? join(this.dir, `${gameId}.json`) : undefined;
  }

  /** The cached entry, or undefined (none, unreadable, another schema or reader version). */
  get(gameId: string): ReplayEntry | undefined {
    const file = this.file(gameId);
    if (!file || !existsSync(file)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ReplayEntry>;
      if (raw.schema !== REPLAY_SCHEMA || raw.reader !== REPLAY_READER_VERSION || raw.gameId !== gameId) return undefined;
      if (raw.status === "ready" && Array.isArray((raw as ReplayReady).moments) && raw.teams) return raw as ReplayReady;
      if (raw.status === "unavailable") return raw as ReplayUnavailable;
      return undefined;
    } catch {
      return undefined;
    }
  }

  has(gameId: string): boolean {
    return this.get(gameId) !== undefined;
  }

  put(raw: Omit<ReplayReady, "schema" | "reader"> | Omit<ReplayUnavailable, "schema" | "reader">): ReplayEntry {
    const entry = replayCoachFilter && "teams" in raw && raw.teams ? { ...raw, teams: filteredTeams(raw.teams) } : raw;
    const file = this.file(entry.gameId);
    if (!file) throw new Error(`not a fork game id: ${entry.gameId}`);
    const full = { schema: REPLAY_SCHEMA, reader: REPLAY_READER_VERSION, ...entry } as ReplayEntry;
    mkdirSync(this.dir, { recursive: true });
    atomicWriteTextFile(file, `${JSON.stringify(full, null, 1)}\n`);
    this.writes += 1;
    return full;
  }

  /** Changes on every write through this store or when the folder changes under it (cache stamp for the game pages). */
  revision(): string {
    let stamp = "none";
    try { const s = statSync(this.dir); stamp = String(s.mtimeMs); } catch { /* no folder yet */ }
    return `${this.writes}:${stamp}`;
  }
}
