/**
 * Durable tabletop store. `TabletopRepository` is the seam: this file implements it on atomic JSON files
 * (temp file + rename via @bb/fork-ops atomicWriteTextFile); a Postgres implementation replaces it later
 * without touching postMatch.ts or the API. Layout under the store directory (env TABLETOP_DIR, resolved by
 * the caller; default sits beside the other data stores):
 *   matches/<id>.json     the match record
 *   events/<id>.ndjson    append-only events, one JSON object per line (rewritten atomically on append)
 *   teams/<sha256>.json   one team's revision chain
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import type { StoredTournamentResult } from "../tournamentResults.js";
import type { TabletopEvent } from "./events.js";
import type { PostMatchOption, PostMatchSummary, TabletopTeamFile } from "./postMatch.js";

export type MatchState = "recording" | "submitted" | "confirmed" | "published";

export interface MatchSide {
  coach: string;
  teamSaveId: string;
  teamName: string;
}

export interface MatchRecord {
  id: string;
  state: MatchState;
  fixtureRef?: string;
  home: MatchSide;
  away: MatchSide;
  postMatch: PostMatchOption;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** coach -> ISO time of confirmation (an organiser's confirm-for-both records both coaches). */
  confirmations: Record<string, string>;
  /** Head revision of each team when the match was created (a confirm needs the head unchanged). */
  baseRevision: { home: number; away: number };
  /** Set on submit: the post-match preview both coaches confirm. */
  preview?: { home: PostMatchSummary; away: PostMatchSummary };
  /** Optional league id the result counts in (defaults to the fixture tournament's package name). */
  league?: string;
  /** True when the fixture lists the two coaches in the opposite home/away order to this match. */
  fixtureSwap?: boolean;
  /** Set on publish when a fixture result was written: what to restore on undo. */
  fixtureLink?: { id: string; priorStatus: string; expectedRevision: number; reportedAt: string; swapped: boolean; opId: string };
  /** Organiser note recorded when a match was reopened. */
  note?: string;
  publishedAt?: string;
  publishedBy?: string;
  /** Set on confirm: revisions this match wrote (absent when postMatch is "none"), and its results-store key. */
  wroteRevisions?: { home: number; away: number };
  resultGameId?: string;
}

export interface TeamRevision {
  saveId: string;
  revision: number;
  parent: number | null;
  teamFile: TabletopTeamFile;
  matchId?: string;
  createdAt: string;
}

export interface TeamChain {
  saveId: string;
  coach: string;
  /** Current revision number. Undo moves it to the parent; revisions are never deleted. */
  head: number;
  revisions: TeamRevision[];
}

/**
 * Write-ahead journal for a multi-record commit (confirm / undo-revision). It holds the COMPLETE intended end
 * state, so replaying it is idempotent: write journal, apply every record, clear journal. An unfinished journal
 * is replayed to completion on startup and before any confirm/undo on its match.
 */
/** A chain write guarded by the version it was prepared against: applied only while the chain still matches `expect`. */
export interface ChainChange {
  expect: { head: number; revisions: number };
  target: TeamChain;
}

export interface CommitJournal {
  matchId: string;
  opId: string;
  kind: "confirm" | "undo" | "publish";
  /** Monotonic order of commits (assigned when the journal is first written); startup replays in this order. */
  seq?: number;
  /** "conflict": the world changed since the commit was prepared; it is never overwritten and needs an organiser. */
  state?: "pending" | "conflict";
  conflict?: string;
  /** Team chain changes (absent for a publication, which never rewrites team files). */
  homeChain?: ChainChange;
  awayChain?: ChainChange;
  /** Results store change: upsert this row, or remove this game id. */
  result: { put: StoredTournamentResult } | { remove: string } | null;
  /** Tournaments-store fixture change (idempotent on replay): record a result, or retract it. */
  fixture?:
    | { op: "record"; id: string; opId: string; expectedRevision: number; homeScore: number; awayScore: number; homeCasualties: number; awayCasualties: number; at: string }
    | { op: "retract"; id: string; opId: string; expectedRevision: number; status: string; at: string };
  /** The match record to write last. */
  match: MatchRecord;
}

export interface TabletopRepository {
  putJournal(journal: CommitJournal): Promise<void>;
  getJournal(matchId: string): Promise<CommitJournal | undefined>;
  clearJournal(matchId: string): Promise<void>;
  listJournalMatchIds(): Promise<string[]>;
  nextJournalSeq(): Promise<number>;
  createMatch(match: MatchRecord): Promise<void>;
  getMatch(id: string): Promise<MatchRecord | undefined>;
  listMatches(): Promise<MatchRecord[]>;
  updateMatch(match: MatchRecord): Promise<void>;
  /** An unfinished (recording/submitted) match already using this team save, other than `exceptId`. */
  findOpenMatchForSave(coach: string, saveId: string, exceptId?: string): Promise<MatchRecord | undefined>;
  readEvents(matchId: string): Promise<TabletopEvent[]>;
  /** Append events (callers have already de-duplicated). */
  appendEvents(matchId: string, events: readonly TabletopEvent[]): Promise<void>;
  getChain(coach: string, saveId: string): Promise<TeamChain | undefined>;
  putChain(chain: TeamChain): Promise<void>;
}

const safeId = (id: string): string => {
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error("invalid id");
  return id;
};
const chainKey = (coach: string, saveId: string): string =>
  createHash("sha256").update(coach, "utf8").update("\0").update(saveId, "utf8").digest("hex");

export class FileTabletopRepository implements TabletopRepository {
  constructor(private readonly dir: string) {
    for (const sub of ["matches", "events", "teams", "journals"]) mkdirSync(join(dir, sub), { recursive: true });
  }

  private matchFile = (id: string) => join(this.dir, "matches", `${safeId(id)}.json`);
  private eventsFile = (id: string) => join(this.dir, "events", `${safeId(id)}.ndjson`);
  private journalFile = (id: string) => join(this.dir, "journals", `${safeId(id)}.json`);
  private chainFile = (coach: string, saveId: string) => join(this.dir, "teams", `${chainKey(coach, saveId)}.json`);

  async putJournal(journal: CommitJournal): Promise<void> {
    atomicWriteTextFile(this.journalFile(journal.matchId), `${JSON.stringify(journal)}
`);
  }

  async getJournal(matchId: string): Promise<CommitJournal | undefined> {
    const file = this.journalFile(matchId);
    if (!existsSync(file)) return undefined;
    try { return JSON.parse(readFileSync(file, "utf8")) as CommitJournal; } catch { return undefined; }
  }

  async clearJournal(matchId: string): Promise<void> {
    const file = this.journalFile(matchId);
    if (existsSync(file)) unlinkSync(file);
  }

  async nextJournalSeq(): Promise<number> {
    const file = join(this.dir, "journals", ".seq");
    let n = 0;
    try { n = Number(readFileSync(file, "utf8")) || 0; } catch { /* first journal */ }
    atomicWriteTextFile(file, String(n + 1));
    return n + 1;
  }

  async listJournalMatchIds(): Promise<string[]> {
    return readdirSync(join(this.dir, "journals")).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  }

  async createMatch(match: MatchRecord): Promise<void> {
    if (existsSync(this.matchFile(match.id))) throw new Error("match exists");
    atomicWriteTextFile(this.matchFile(match.id), `${JSON.stringify(match, null, 2)}\n`);
  }

  async getMatch(id: string): Promise<MatchRecord | undefined> {
    let file: string;
    try { file = this.matchFile(id); } catch { return undefined; }
    if (!existsSync(file)) return undefined;
    try { return JSON.parse(readFileSync(file, "utf8")) as MatchRecord; } catch { return undefined; }
  }

  async listMatches(): Promise<MatchRecord[]> {
    const out: MatchRecord[] = [];
    for (const name of readdirSync(join(this.dir, "matches"))) {
      if (!name.endsWith(".json")) continue;
      const m = await this.getMatch(name.slice(0, -5));
      if (m) out.push(m);
    }
    return out;
  }

  async updateMatch(match: MatchRecord): Promise<void> {
    atomicWriteTextFile(this.matchFile(match.id), `${JSON.stringify(match, null, 2)}\n`);
  }

  async findOpenMatchForSave(coach: string, saveId: string, exceptId?: string): Promise<MatchRecord | undefined> {
    for (const name of readdirSync(join(this.dir, "matches"))) {
      if (!name.endsWith(".json")) continue;
      const m = await this.getMatch(name.slice(0, -5));
      if (!m || m.id === exceptId || (m.state !== "recording" && m.state !== "submitted")) continue;
      if ((m.home.coach === coach && m.home.teamSaveId === saveId) || (m.away.coach === coach && m.away.teamSaveId === saveId)) return m;
    }
    return undefined;
  }

  async readEvents(matchId: string): Promise<TabletopEvent[]> {
    const file = this.eventsFile(matchId);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TabletopEvent);
  }

  async appendEvents(matchId: string, events: readonly TabletopEvent[]): Promise<void> {
    if (!events.length) return;
    const file = this.eventsFile(matchId);
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    const added = events.map((e) => JSON.stringify(e)).join("\n");
    atomicWriteTextFile(file, `${existing}${added}\n`);
  }

  async getChain(coach: string, saveId: string): Promise<TeamChain | undefined> {
    const file = this.chainFile(coach, saveId);
    if (!existsSync(file)) return undefined;
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as TeamChain;
      return c.coach === coach && c.saveId === saveId ? c : undefined;
    } catch { return undefined; }
  }

  async putChain(chain: TeamChain): Promise<void> {
    atomicWriteTextFile(this.chainFile(chain.coach, chain.saveId), `${JSON.stringify(chain, null, 2)}\n`);
  }
}

/** The team file at a chain's head. */
export const headRevision = (chain: TeamChain): TeamRevision => chain.revisions.find((r) => r.revision === chain.head)!;
