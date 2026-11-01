// Game-time proposals (spec-main-landing-nav §4.6, ruling §7: "a proposal is two coaches agreeing a TIME to play an
// existing fixture"). One JSON file under FORK_STATE_DIR:
//
//   schedule/proposals.json   { version: 1, proposals: ProposalRecord[] }
//
// A proposal names an existing fixture (src/schedule/fixtures.ts ref), the coach who sent it, the coach who answers it
// and up to three candidate 2-hour slots (UTC ISO starts). Accepting one never creates a fixture: the API writes the
// agreed time onto the fixture itself and marks the proposal accepted here.
//
// Reads are STRICT: a missing file is empty, an unreadable or malformed one throws (never read as "no proposals", which
// would let a duplicate through). Writes are atomic and synchronous, so one request's read-modify-write never
// interleaves with another's. Coaches are stored in their identity spelling and compared by the identity key (trim +
// lower case). A write that names a coach whose account is being deleted is refused (the deletion fence).

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { assertNotFenced } from "../privacy/fence.js";

export const SLOT_HOURS = 2;
export const SLOT_MS = SLOT_HOURS * 3_600_000;
export const MAX_SLOTS = 3;
export const PROPOSAL_ID = /^p[a-f0-9]{16}$/;
/** Answered (or expired) proposals are kept this long for the list's history, then pruned on the next write. */
export const KEEP_SETTLED_MS = 60 * 24 * 3_600_000;
export const PROPOSALS_CAP = 5000;

export type ProposalStatus = "pending" | "accepted" | "declined" | "countered" | "withdrawn" | "superseded";
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["pending", "accepted", "declined", "countered", "withdrawn", "superseded"];

export interface ProposalRecord {
  id: string;
  /** The fixture's ref (fixtures.ts): league:<league>:<season>:<fixture> or tournament:<match>. */
  fixture: string;
  /** The coach who sent the times. */
  from: string;
  /** The coach who answers (accept one, counter, decline). */
  to: string;
  /** Candidate slot starts (UTC ISO), 1-3; each slot lasts SLOT_HOURS. */
  slots: string[];
  status: ProposalStatus;
  createdAt: string;
  answeredAt?: string;
  /** The slot the answering coach accepted. */
  acceptedSlot?: string;
  /** This proposal is a counter to that one. */
  counterOf?: string;
  /** The proposal that replaced this one (a counter, or the sender's newer times). */
  replacedBy?: string;
}

export interface ProposalsFile { version: 1; proposals: ProposalRecord[] }

export class ScheduleStoreError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const scheduleKey = (coach: string): string => coach.trim().toLowerCase();
export const sameCoach = (a: string | undefined, b: string | undefined): boolean => scheduleKey(a ?? "") !== "" && scheduleKey(a ?? "") === scheduleKey(b ?? "");

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function validRecord(o: Obj): o is Obj & ProposalRecord {
  return isStr(o.id) && PROPOSAL_ID.test(o.id) && isStr(o.fixture) && isStr(o.from) && isStr(o.to) && isStr(o.createdAt) &&
    Array.isArray(o.slots) && o.slots.every(isStr) && isStr(o.status) && (PROPOSAL_STATUSES as readonly string[]).includes(o.status);
}

/** A proposal that is still pending but whose every slot has started can no longer be accepted. */
export function isExpired(p: Pick<ProposalRecord, "status" | "slots">, now: number): boolean {
  return p.status === "pending" && p.slots.every((s) => Date.parse(s) <= now);
}

export class ProposalStore {
  readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "schedule", "proposals.json");
  }

  /** Every stored proposal (a copy). Throws ScheduleStoreError(500) on an unreadable file. */
  all(): ProposalRecord[] {
    return this.read().proposals;
  }

  get(id: string): ProposalRecord | undefined {
    if (!PROPOSAL_ID.test(id)) return undefined;
    return this.read().proposals.find((p) => p.id === id);
  }

  /** Proposals the coach sent or must answer, newest first. */
  forCoach(coach: string): ProposalRecord[] {
    return this.read().proposals.filter((p) => sameCoach(p.from, coach) || sameCoach(p.to, coach))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  /** Pending proposals of one fixture. */
  pendingFor(fixture: string): ProposalRecord[] {
    return this.read().proposals.filter((p) => p.fixture === fixture && p.status === "pending");
  }

  /**
   * One read-modify-write. `change` gets the stored list (mutable) and returns a result; the file is written after it
   * returns, pruned of old settled rows. Every coach named by a row the change adds or touches is fence-checked.
   */
  mutate<T>(change: (proposals: ProposalRecord[], ctx: { newId(): string }) => T, now = Date.now()): T {
    const file = this.read();
    const before = new Map(file.proposals.map((p) => [p.id, JSON.stringify(p)]));
    const result = change(file.proposals, { newId: () => newProposalId(new Set(file.proposals.map((p) => p.id))) });
    for (const p of file.proposals) {
      if (before.get(p.id) === JSON.stringify(p)) continue;
      assertNotFenced(p.from);
      assertNotFenced(p.to);
    }
    file.proposals = prune(file.proposals, now);
    this.write(file);
    return result;
  }

  /** Privacy (account deletion): drop every proposal naming one of these identity keys. Returns how many went. */
  removeCoach(keys: ReadonlySet<string>): number {
    const file = this.read();
    const kept = file.proposals.filter((p) => !keys.has(scheduleKey(p.from)) && !keys.has(scheduleKey(p.to)));
    const removed = file.proposals.length - kept.length;
    if (removed) this.write({ ...file, proposals: kept });
    return removed;
  }

  private read(): ProposalsFile {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, proposals: [] };
      throw new ScheduleStoreError(500, "The proposals store is unreadable.");
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new ScheduleStoreError(500, "The proposals store is unreadable."); }
    if (!isObj(data) || !Array.isArray(data.proposals)) throw new ScheduleStoreError(500, "The proposals store is unreadable.");
    return { version: 1, proposals: data.proposals.filter((o): o is ProposalRecord => isObj(o) && validRecord(o)).map((p) => structuredClone(p)) };
  }

  private write(file: ProposalsFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    atomicWriteTextFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

function newProposalId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `p${randomBytes(8).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

/** Settled rows (and pending rows whose slots all passed) older than KEEP_SETTLED_MS go; the newest PROPOSALS_CAP stay. */
function prune(list: ProposalRecord[], now: number): ProposalRecord[] {
  const kept = list.filter((p) => {
    const settledAt = p.status === "pending"
      ? (isExpired(p, now) ? Math.max(...p.slots.map((s) => Date.parse(s))) : Number.POSITIVE_INFINITY)
      : Date.parse(p.answeredAt ?? p.createdAt);
    return !(Number.isFinite(settledAt) && now - settledAt > KEEP_SETTLED_MS);
  });
  if (kept.length <= PROPOSALS_CAP) return kept;
  return kept.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, PROPOSALS_CAP);
}
