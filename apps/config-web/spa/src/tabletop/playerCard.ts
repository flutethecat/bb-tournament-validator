// The player portrait card: which element asks for it (data-pcard="<side>:<playerId>"), and where it sits.
import type { Side } from "./recorder";

export const CARD_DELAY_MS = 250;
export const CARD_HOLD_MS = 450;
export const cardKey = (side: Side, id: string): string => `${side}:${id}`;
export function parseCardKey(key: string | undefined | null): { side: Side; id: string } | null {
  const m = /^(home|away):(.+)$/.exec(key ?? "");
  return m ? { side: m[1] as Side, id: m[2]! } : null;
}

export interface Box { left: number; top: number; right: number; bottom: number }

/** Beside the hovered element, never over it: to its right, else its left, else under / over it; clamped inside the viewport. */
export function placeCard(target: Box, size: { w: number; h: number }, view: { w: number; h: number }, pointerY: number, gap = 12, edge = 8): { x: number; y: number } {
  const clampY = (y: number): number => Math.min(Math.max(y, edge), Math.max(edge, view.h - size.h - edge));
  const clampX = (x: number): number => Math.min(Math.max(x, edge), Math.max(edge, view.w - size.w - edge));
  if (target.right + gap + size.w <= view.w - edge) return { x: target.right + gap, y: clampY(pointerY - size.h / 2) };
  if (target.left - gap - size.w >= edge) return { x: target.left - gap - size.w, y: clampY(pointerY - size.h / 2) };
  const below = target.bottom + gap + size.h <= view.h - edge;
  return { x: clampX(target.left), y: below ? target.bottom + gap : Math.max(edge, target.top - gap - size.h) };
}
