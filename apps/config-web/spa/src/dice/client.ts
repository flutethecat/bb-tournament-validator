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

// ---- the D8 roller (advancement "Advance Characteristic", spec-forfeit-and-dice-2026-11-02 Q7) ----------------------
// A big octahedral D8 in CSS 3D that tumbles, slows and settles on the face the SERVER rolled, then a short flourish (in
// the manner of a tabletop RPG's d20 roller). The geometry is a true octahedron: eight triangular faces, four meeting at
// the top vertex and four at the bottom, numbered so opposite faces add to 9 like a real D8.

/** Tilt of each face from the vertical (the octahedron's face normals sit atan(1/sqrt 2) above / below the equator). */
export const D8_TILT = (Math.atan(1 / Math.SQRT2) * 180) / Math.PI; // 35.26 deg
/** The eight faces: the value, the azimuth (deg, about the vertical) and whether it meets the top vertex. */
export const D8_FACES: ReadonlyArray<{ value: number; azimuth: number; top: boolean }> = (() => {
  const top = [1, 2, 3, 4];
  const out: Array<{ value: number; azimuth: number; top: boolean }> = [];
  top.forEach((v, i) => out.push({ value: v, azimuth: 45 + i * 90, top: true }));
  // the face opposite a top face sits 180 deg round, underneath: its value makes the pair add to 9
  top.forEach((v, i) => out.push({ value: 9 - v, azimuth: 45 + ((i + 2) % 4) * 90, top: false }));
  return out;
})();

/** Sizes of the octahedron's faces for a die drawn in a `size` px box (vertex radius ~0.42 of the box). */
export function d8Geometry(size: number): { radius: number; edge: number; height: number; inset: number } {
  const radius = size * 0.42;
  const edge = radius * Math.SQRT2;
  return { radius, edge, height: (edge * Math.sqrt(3)) / 2, inset: radius / Math.sqrt(3) };
}

/** The die's rotation that shows `value` square to the viewer (deg), with a small forward tilt so the top edges read. */
export function d8Final(value: number): { x: number; y: number; z: number } {
  const f = D8_FACES.find((x) => x.value === value) ?? D8_FACES[0]!;
  return { x: (f.top ? -D8_TILT : D8_TILT) - 8, y: -f.azimuth, z: 0 };
}

/** How long the roll plays (ms): about 2.2 s, or a quick fade when the viewer prefers reduced motion. `settle` is when
 *  the die stops and the flourish starts; `total` when the result and the choices appear. */
export function rollTiming(reduced: boolean, spin?: number): { spin: number; settle: number; total: number } {
  if (reduced) return { spin: 0, settle: 0, total: 250 };
  if (spin) return { spin, settle: spin, total: spin + 350 };
  return { spin: 1700, settle: 1700, total: 2250 };
}

// ---- 2D6 (Random Primary skill: the category table rolled with two D6, owner 11-03) ----------------------------------

/** A settled D6 shows the rolled face to the front, turned a little so the top and a side read as a cube. */
export const D6_FINAL = { x: -16, y: 18, z: 0 } as const;
/** The six sides of a D6 showing `face` in front: the opposite face behind (opposite faces add to 7), the rest around. */
export function d6Sides(face: number): number[] {
  const f = Math.min(6, Math.max(1, Math.round(face)));
  const others = [1, 2, 3, 4, 5, 6].filter((v) => v !== f && v !== 7 - f);
  return [f, 7 - f, others[0]!, others[1]!, others[2]!, others[3]!];
}

/** One step of a Random Primary roll as the server logged it: the two dice, the table entry, and whether it was rolled again. */
export interface SkillRollStep { dice: [number, number]; skill: string; rerolled?: boolean }
/**
 * The play-back plan of a Random Primary roll (the SERVER's logged 2D6 rolls, in order, rerolls included): the tumble of
 * each pair, kept under ~4 s in all (rerolled pairs play shorter), or nothing to play under reduced motion.
 */
export function skillRollPlan(rolls: readonly SkillRollStep[], reduced: boolean): { steps: Array<SkillRollStep & { spin: number; total: number }>; total: number } {
  if (reduced || !rolls.length) return { steps: rolls.map((r) => ({ ...r, spin: 0, total: 0 })), total: reduced ? 250 : 0 };
  const budget = 3600;
  const weight = (r: SkillRollStep): number => (r.rerolled ? 0.6 : 1);
  const unit = budget / rolls.reduce((sum, r) => sum + weight(r), 0);
  const steps = rolls.map((r) => {
    const total = Math.round(Math.min(1500, Math.max(450, unit * weight(r))));
    return { ...r, spin: Math.max(250, total - 350), total };
  });
  return { steps, total: steps.reduce((sum, x) => sum + x.total, 0) };
}

/** prefers-reduced-motion, guarded (no window in tests, old browsers). */
export function prefersReducedMotion(): boolean {
  try { return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  catch { return false; }
}
