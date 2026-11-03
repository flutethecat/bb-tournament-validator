/**
 * The dice log (spec-forfeit-and-dice-2026-11-02, Q3 / Q6): every roll the site makes for a match, time-stamped, written
 * BEFORE anyone is shown the result. One append-only NDJSON file per log under `<TABLETOP_DIR>/dice/`:
 *   {"t":"roll", ...DiceRoll}            a roll (its result is fixed at write time)
 *   {"t":"choice", rollId, index, ...}  a block-die choice (the first valid one for a roll wins; later ones are refused)
 * A log id is a recorder match id, or `fx-<hash>` for a league fixture with no recorder match (forfeit defections).
 *
 * Privacy: `by` / `choice.by` are coach names. The privacy export lists the rolls a coach made; account deletion
 * anonymises those names in place (src/privacy/collectors.ts), never deleting the rolls.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";

export const DICE_KINDS = ["d6", "block", "d8", "d16", "deviate", "kickoff", "defection"] as const;
export type DiceKind = (typeof DICE_KINDS)[number];
export type DiceSide = "home" | "away";

export interface DiceBlockChoice { index: number; face: string; by: string; at: string; admin?: boolean }

export interface DiceRoll {
  id: string;
  /** The log this roll belongs to (a match id or a fixture key). */
  logId: string;
  at: string;
  /** Who pressed roll (the proven session coach, never taken from a request). */
  by: string;
  /** The seat the roll was made for, when it is a seat's roll. */
  side?: DiceSide;
  kind: DiceKind;
  /** A short human label ("2 dice", "Block, 2 dice, the opponent chooses", "Kick-off event"). */
  purpose: string;
  /** Raw dice in roll order. */
  dice: number[];
  /** What the dice mean (block faces, the deviate distance and direction, the kick-off event, a defection). */
  result: Record<string, unknown>;
  /** Block rolls: dice count (negative = the opponent chooses) and who chooses. */
  block?: { count: number; chooser: "roller" | "opponent" | "none" };
  /** Folded from the log: the block-die choice once made. */
  choice?: DiceBlockChoice;
  /** An organiser rolled for a team they do not coach. */
  admin?: boolean;
}

export interface DiceLogStore {
  /** Append one roll. Throws when it cannot be written (the caller then shows nothing). */
  appendRoll(roll: DiceRoll): void;
  /** Append a block choice for a roll that has none yet (the caller checks first, under the match lock). */
  appendChoice(logId: string, rollId: string, choice: DiceBlockChoice): void;
  /** Every roll of a log, oldest first, with its choice folded in. */
  read(logId: string): DiceRoll[];
}

const SAFE_ID = /^[\w-]{1,64}$/;
/** The log id for a league fixture (no recorder match): a stable, path-safe hash of its ref. */
export const fixtureLogId = (ref: string): string => `fx-${createHash("sha256").update(ref, "utf8").digest("hex").slice(0, 32)}`;
export const newRollId = (): string => `r${randomBytes(9).toString("base64url")}`;

export class FileDiceLog implements DiceLogStore {
  constructor(private readonly dir: string) {}

  private file(logId: string): string {
    if (!SAFE_ID.test(logId)) throw new Error("invalid dice log id");
    return join(this.dir, `${logId}.ndjson`);
  }

  private append(logId: string, line: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(logId);
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    atomicWriteTextFile(file, `${existing}${JSON.stringify(line)}\n`);
  }

  appendRoll(roll: DiceRoll): void {
    const { choice: _c, ...rest } = roll;
    this.append(roll.logId, { t: "roll", ...rest });
  }

  appendChoice(logId: string, rollId: string, choice: DiceBlockChoice): void {
    this.append(logId, { t: "choice", rollId, ...choice });
  }

  read(logId: string): DiceRoll[] {
    let file: string;
    try { file = this.file(logId); } catch { return []; }
    if (!existsSync(file)) return [];
    return foldDiceLog(readFileSync(file, "utf8"));
  }
}

/** NDJSON text -> rolls with their first choice folded in (a bad line is skipped). */
export function foldDiceLog(text: string): DiceRoll[] {
  const rolls: DiceRoll[] = [];
  const byId = new Map<string, DiceRoll>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (o.t === "roll" && typeof o.id === "string") {
      const { t: _t, ...roll } = o;
      const r = roll as unknown as DiceRoll;
      rolls.push(r);
      byId.set(r.id, r);
    } else if (o.t === "choice" && typeof o.rollId === "string") {
      const r = byId.get(o.rollId);
      if (r && !r.choice && typeof o.index === "number") r.choice = { index: o.index, face: String(o.face ?? ""), by: String(o.by ?? ""), at: String(o.at ?? ""), ...(o.admin === true ? { admin: true } : {}) };
    }
  }
  return rolls;
}

/** An in-memory log for tests. `failNext` makes the next append throw (a write failure). */
export class MemoryDiceLog implements DiceLogStore {
  private readonly lines = new Map<string, string[]>();
  failNext = false;
  private push(logId: string, line: Record<string, unknown>): void {
    if (this.failNext) { this.failNext = false; throw new Error("dice log write failed"); }
    this.lines.set(logId, [...(this.lines.get(logId) ?? []), JSON.stringify(line)]);
  }
  appendRoll(roll: DiceRoll): void { const { choice: _c, ...rest } = roll; this.push(roll.logId, { t: "roll", ...rest }); }
  appendChoice(logId: string, rollId: string, choice: DiceBlockChoice): void { this.push(logId, { t: "choice", rollId, ...choice }); }
  read(logId: string): DiceRoll[] { return foldDiceLog((this.lines.get(logId) ?? []).join("\n")); }
}
