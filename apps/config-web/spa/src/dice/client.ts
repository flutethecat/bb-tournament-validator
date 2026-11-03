// Dice roller client (no DOM, unit-tested): the server rolls, logs and answers; this keeps the last answer and tells
// the page which rolls are new (to animate) and which block choices this viewer may make. Reusable: any page with a
// `/dice` endpoint pair (GET state, POST roll / choose / log) can drive it (the recorder now; the advancement picker later).

import { reactive } from "vue";
import type { Fetcher } from "../session";

export type DiceKind = "d6" | "block" | "d8" | "d16" | "deviate" | "kickoff" | "defection";
export type DiceSide = "home" | "away";

export interface DiceRollView {
  id: string; at: string; by: string; side?: DiceSide; kind: DiceKind; purpose: string; dice: number[];
  result: Record<string, unknown>;
  block?: { count: number; chooser: "roller" | "opponent" | "none" };
  choice?: { index: number; face: string; by: string; at: string; admin?: boolean };
  admin?: boolean;
}

export interface DiceStateView {
  ruleset: string;
  kickoffTable: Array<{ total: number; name: string }>;
  logShown: boolean;
  canSeeLog: boolean;
  latest: DiceRollView[];
  pending: DiceRollView[];
  log?: DiceRollView[];
}

export interface DiceClientState {
  loaded: boolean;
  view: DiceStateView | null;
  busy: boolean;
  error: string;
  /** The newest roll this page has seen (the live result strip shows it). */
  current: DiceRollView | null;
  /** A roll that arrived from someone else since the last look (the live overlay plays it). */
  incoming: DiceRollView | null;
}

/** The face art (in-repo; tools/art/dice/PROVENANCE.md): the Super FUMBBL client's default brushed-metal D6 and block
 *  faces (the owner's own art) and D8 / D16 faces made to match them. */
export const BLOCK_FACE_LABEL: Record<string, string> = { skull: "Attacker down", "both-down": "Both down", push: "Push", stumble: "Stumble", pow: "Defender down" };
export function faceArt(kind: DiceKind | "d6" | "d8" | "d16" | "block", value: number | string): string {
  if (kind === "block") return `/assets/dice/block/128/block-face-${value}.png`;
  const dir = kind === "d8" ? "d8" : kind === "d16" ? "d16" : "d6";
  return `/assets/dice/${dir}/128/${dir}-face-${value}.png`;
}

/** Every face of each die, in order (block faces by id; the art has one Push face for the two Push sides). */
export const DIE_FACES: Record<"d6" | "d8" | "d16" | "block", Array<number | string>> = {
  d6: [1, 2, 3, 4, 5, 6], d8: [1, 2, 3, 4, 5, 6, 7, 8], d16: Array.from({ length: 16 }, (_, i) => i + 1),
  block: ["skull", "both-down", "push", "stumble", "pow", "push"],
};
/** A face as its 1-based index on the die, so a block face (a string id) drives the tumble like a number does. */
export const dieFaceIndex = (die: keyof typeof DIE_FACES, face: number | string): number => Math.max(1, DIE_FACES[die].indexOf(face) + 1);
/** The tumble's start rotation (whole turns, so the die always settles square to the viewer); always finite. */
export function dieSpin(die: keyof typeof DIE_FACES, face: number | string): { x: number; y: number; z: number } {
  const n = dieFaceIndex(die, face) + 1;
  return { x: 720 + (n % 3) * 90, y: 540 + (n % 4) * 90, z: (n % 2 ? 1 : -1) * 180 };
}

/** The dice to draw for a roll: [kind of die, face] per die. */
export function diceFaces(r: Pick<DiceRollView, "kind" | "dice" | "result">): Array<{ die: "d6" | "d8" | "d16" | "block"; face: number | string }> {
  if (r.kind === "block") return ((r.result.faces as string[] | undefined) ?? []).map((f) => ({ die: "block" as const, face: f }));
  if (r.kind === "d8") return [{ die: "d8", face: r.dice[0]! }];
  if (r.kind === "d16") return [{ die: "d16", face: r.dice[0]! }];
  if (r.kind === "deviate") return [{ die: "d6", face: r.dice[0]! }, { die: "d8", face: r.dice[1]! }];
  return r.dice.map((d) => ({ die: "d6" as const, face: d }));
}

/** One line saying what a roll means ("7: Brilliant Coaching", "4 squares, Up and left"). Server-sent words only. */
export function rollMeaning(r: Pick<DiceRollView, "kind" | "dice" | "result" | "choice">): string {
  const res = r.result;
  switch (r.kind) {
    case "kickoff": return `${String(res.total)}: ${String(res.eventName ?? "")}`;
    case "deviate": return `${String(res.distance)} square${res.distance === 1 ? "" : "s"}, ${String(res.directionLabel ?? "")} ${String(res.arrow ?? "")}`.trim();
    case "block": {
      const labels = (res.labels as string[] | undefined) ?? [];
      if (r.choice) return `Chose ${BLOCK_FACE_LABEL[r.choice.face] ?? r.choice.face}`;
      return labels.join(", ");
    }
    case "defection": return res.leaves ? "Leaves the team" : "Stays";
    default: return r.dice.length > 1 ? `${r.dice.join(" + ")} = ${String(res.total)}` : String(res.total ?? r.dice[0]);
  }
}

/** May this seat choose a face of this pending block roll? (The server decides; this only shows the picker.) */
export function canChoose(r: DiceRollView, mySide: DiceSide | null, organiser: boolean): boolean {
  if (!r.block || r.block.chooser === "none" || r.choice) return false;
  if (organiser) return true;
  if (!mySide) return false;
  return r.block.chooser === "opponent" ? true : r.side === mySide;
}
/** The picker opens by itself for the coach who is asked to choose: the opponent for -2/-3, the roller for 2/3. */
export function askedToChoose(r: DiceRollView, mySide: DiceSide | null): boolean {
  if (!r.block || r.block.chooser === "none" || r.choice || !mySide) return false;
  return r.block.chooser === "opponent" ? r.side !== mySide : r.side === mySide;
}

export function createDiceClient(base: string, deps: { api: Fetcher; me: () => string }) {
  const state = reactive<DiceClientState>({ loaded: false, view: null, busy: false, error: "", current: null, incoming: null });
  const seen = new Set<string>();
  let first = true;

  function take(view: DiceStateView): void {
    state.view = view;
    const latest = view.latest ?? [];
    const newest = latest.at(-1) ?? null;
    if (first) { for (const r of latest) seen.add(r.id + (r.choice ? ":c" : "")); first = false; state.current = newest; state.loaded = true; return; }
    for (const r of latest) {
      const key = r.id + (r.choice ? ":c" : "");
      if (seen.has(key)) continue;
      seen.add(key);
      if (!r.choice && r.by !== deps.me()) state.incoming = r; // someone else's roll: play it here too
    }
    state.current = newest;
    state.loaded = true;
  }

  async function refresh(): Promise<void> {
    try {
      take(await deps.api<DiceStateView>(`${base}/dice`));
      state.error = "";
    } catch (e) {
      state.error = (e as Error).message;
    }
  }

  async function post(path: string, body: Record<string, unknown>): Promise<DiceRollView | null> {
    state.busy = true;
    state.error = "";
    try {
      const res = await deps.api<DiceStateView & { roll?: DiceRollView }>(`${base}/${path}`, { method: "POST", body });
      if (res.roll) seen.add(res.roll.id + (res.roll.choice ? ":c" : ""));
      take(res);
      if (res.roll) state.current = res.roll;
      return res.roll ?? null;
    } catch (e) {
      state.error = (e as Error).message;
      await refresh();
      return null;
    } finally {
      state.busy = false;
    }
  }

  return {
    state,
    refresh,
    roll: (spec: { kind: DiceKind; count?: number; side?: DiceSide }) => post("dice/roll", spec),
    choose: (rollId: string, index: number) => post("dice/choose", { rollId, index }),
    setLogShown: (shown: boolean) => post("dice/log", { shown }),
    dismissIncoming: () => { state.incoming = null; },
  };
}
export type DiceClient = ReturnType<typeof createDiceClient>;
