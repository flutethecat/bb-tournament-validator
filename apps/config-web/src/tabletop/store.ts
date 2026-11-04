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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import type { StoredTournamentResult } from "../tournamentResults.js";
import type { TabletopEvent } from "./events.js";
import type { ClockState, MatchTimers } from "./clock.js";
import type { MatchPhase } from "./pregame.js";
import type { PostMatchOption, PostMatchSummary, TabletopTeamFile } from "./postMatch.js";

export type MatchState = "recording" | "submitted" | "confirmed" | "published";

/** One side's lobby inducements as the match keeps them (fixture lobby START). */
export interface LobbyInducements {
  picks: Array<{ id: string; name: string; qty: number; cost: number }>;
  total: number;
  treasury: number;
  pettyCash: number;
}

export interface MatchSide {
  coach: string;
  teamSaveId: string;
  teamName: string;
}

export interface MatchRecord {
  id: string;
  state: MatchState;
  fixtureRef?: string;
  /** Where the match is: pre-game phases, then "playing". Absent on matches from before pre-game existed = playing. */
  phase?: MatchPhase;
  /** Half / turn / whose turn; set when the match reaches "playing". */
  clock?: ClockState;
  /** Turn-timer decision (set when the agreement step resolves, or at once when the competition decides). */
  timers?: MatchTimers;
  /** Created by the admin Testing Suite: excluded from standings, Elo and results, and removable in bulk. */
  test?: true;
  /** Overtime after half 2 (default false). */
  allowOvertime?: boolean;
  home: MatchSide;
  away: MatchSide;
  postMatch: PostMatchOption;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** coach -> ISO time of confirmation (an organiser's confirm-for-both records both coaches). */
  confirmations: Record<string, string>;
  /** Set when an organiser confirmed for both coaches: who and when (the log shows it as an admin line). */
  confirmedBy?: { by: string; at: string; admin: boolean };
  /** Head revision of each team when the match was created (a confirm needs the head unchanged). */
  baseRevision: { home: number; away: number };
  /** Set on submit: the post-match preview both coaches confirm. */
  preview?: { home: PostMatchSummary; away: PostMatchSummary };
  /** Venue or table, when known (shown in the header bar). */
  venue?: string;
  /** Optional league id the result counts in (defaults to the fixture tournament's package name). */
  league?: string;
  /** The league season the match is played in, when the creator named one: its inducement table prices the pre-game picker. */
  leagueSeason?: { leagueId: string; seasonId: string };
  /**
   * Pre-match inducements bought in the fixture lobby (src/fixtureLobby), seated after the seat draw: one-match items,
   * never written back to the team file. Absent = none were bought before the match (the pre-game step still runs).
   */
  inducements?: Record<"home" | "away", LobbyInducements>;
  /** True when the fixture lists the two coaches in the opposite home/away order to this match. */
  fixtureSwap?: boolean;
  /** League fixtures: the money rules (leagues/moneyRules.ts) in force when the match started. Absent = the site's fixed
   *  rule (10,000 per touchdown); the post-match always uses this snapshot, never the league's current rules. */
  money?: import("../leagues/moneyRules.js").MoneySnapshot;
  /** Set on publish when a fixture result was written: what to restore on undo. */
  fixtureLink?: { id: string; priorStatus: string; expectedRevision: number; reportedAt: string; swapped: boolean; opId: string };
  /** Organiser note recorded when a match was reopened. */
  note?: string;
  /** The match recorder toggle "Show dice log" (per match, off by default): the coaches see the dice log. Organisers always do. */
  diceLogShown?: true;
  /** Set when an organiser entered a forfeit for this match's league fixture (src/leagues/forfeit.ts): the match is closed. */
  forfeit?: { at: string; by: string; score?: { home: number; away: number }; /** the state to reopen to when undone */ priorState?: MatchState };
  /** Written BEFORE the league forfeit is applied: a retry after a crash re-applies it (idempotent for this match) and closes. */
  forfeitPending?: { at: string; by: string };
  /** Coach's comments (end-game step, src/discord/comments.ts): one per seat, at most 120 characters, keyed by SIDE (the
   *  coach is the seat's, so account deletion anonymises it with the seat). An organiser may hide one. */
  comments?: Partial<Record<"home" | "away", MatchComment>>;
  publishedAt?: string;
  publishedBy?: string;
  /** Set on confirm: revisions this match wrote (absent when postMatch is "none"), and its results-store key. */
  wroteRevisions?: { home: number; away: number };
  resultGameId?: string;
}

export interface MatchComment {
  text: string;
  at: string;
  /** Hidden by an organiser of the competition (or a site admin): never shown in the digest or on the match page. */
  hidden?: { by: string; at: string };
}

export interface TeamRevision {
  saveId: string;
  revision: number;
  parent: number | null;
  teamFile: TabletopTeamFile;
  matchId?: string;
  /** A Team Captain appointment (tabletop/captain.ts): an appended revision, never a match's. Who, when, whom, what was granted. */
  appointment?: { by: string; at: string; admin: boolean; playerId: string; grants: string[] };
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
  /** Who caused this commit, and whether an organiser did so on behalf of the coaches (confirm for both, reopen, undo-revision, publish). */
  by?: string;
  admin?: boolean;
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
    | { op: "record"; id: string; opId: string; expectedRevision: number; homeScore: number; awayScore: number; homeCasualties: number; awayCasualties: number; moneyRulesVersion?: number; at: string }
    | { op: "retract"; id: string; opId: string; expectedRevision: number; status: string; at: string };
  /** The match record to write last. */
  match: MatchRecord;
}

export interface TabletopRepository {
  putJournal(journal: CommitJournal): Promise<void>;
  getJournal(matchId: string): Promise<CommitJournal | undefined>;
  clearJournal(matchId: string): Promise<void>;
  listJournalMatchIds(): Promise<string[]>;
  /** Every match plus the match files that could not be read (optional: callers that must fail closed). */
  listMatchesChecked?(): Promise<{ matches: MatchRecord[]; unreadable: string[] }>;
  nextJournalSeq(): Promise<number>;
  createMatch(match: MatchRecord): Promise<void>;
  getMatch(id: string): Promise<MatchRecord | undefined>;
  listMatches(): Promise<MatchRecord[]>;
  /** Remove a match with its events and any journal (the Testing Suite purge). Team chains are left alone. */
  deleteMatch(id: string): Promise<void>;
  updateMatch(match: MatchRecord): Promise<void>;
  /** An unfinished (recording/submitted) match already using this team save, other than `exceptId`. */
  findOpenMatchForSave(coach: string, saveId: string, exceptId?: string): Promise<MatchRecord | undefined>;
  readEvents(matchId: string): Promise<TabletopEvent[]>;
  /** A cheap token that changes whenever the match's event log does (keys the match-view cache); optional. */
  eventsRevision?(matchId: string): Promise<string>;
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

  async deleteMatch(id: string): Promise<void> {
    for (const file of [this.matchFile(id), this.eventsFile(id), this.journalFile(id)]) if (existsSync(file)) unlinkSync(file);
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

  /** listMatches, plus the names of match files that are unreadable or not a match record (callers that must fail closed). */
  async listMatchesChecked(): Promise<{ matches: MatchRecord[]; unreadable: string[] }> {
    const matches: MatchRecord[] = [];
    const unreadable: string[] = [];
    for (const name of readdirSync(join(this.dir, "matches"))) {
      if (!name.endsWith(".json")) continue;
      try {
        const m = JSON.parse(readFileSync(join(this.dir, "matches", name), "utf8")) as MatchRecord;
        if (!m || typeof m !== "object" || typeof m.id !== "string" || typeof m.state !== "string") unreadable.push(name);
        else matches.push(m);
      } catch { unreadable.push(name); }
    }
    return { matches, unreadable };
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

  /** The log is append-only, so its size (with the write time) changes on every append. */
  async eventsRevision(matchId: string): Promise<string> {
    const file = this.eventsFile(matchId);
    if (!existsSync(file)) return "0";
    const s = statSync(file);
    return `${s.size}:${s.mtimeMs}`;
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
