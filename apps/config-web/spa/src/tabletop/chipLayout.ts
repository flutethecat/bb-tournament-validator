// Hero chip tray capacity on desktop: at most two rows. The chips try the base size, then one notch smaller; if two rows still
// cannot hold them, the first N that fit are shown with a final "+K" overflow chip (its tip lists the hidden items).

export const CHIP_GAP = 4;
/** Chip sizes (px) by notch: from 1600 px 64 / 56 / 48, otherwise 56 / 48. The icon is drawn smaller inside the chip (CSS, data-size). */
export const chipNotches = (vw: number): number[] => (vw >= 1600 ? [64, 56, 48] : [56, 48]);

/** The tray's inner width at a viewport width: the 1400 px column, the card border and inset, the scoreboard centre column (420 px, 460 px from 1600), the column gaps, the crest column and the tray padding. */
export function trayInnerWidth(vw: number): number {
  const col = Math.min(1400, vw);
  const crest = vw >= 1600 ? 112 : 96;
  const side = (col - 4 - 40 - (vw >= 1600 ? 460 : 420) - 32) / 2;
  return Math.max(0, side - (crest + 18) - 16 - 12);
}

export interface ChipLayout { size: number; step: number; visible: number; hidden: number }

/** How `n` chips lay out in two rows at a viewport width. */
export function chipLayout(n: number, vw: number): ChipLayout {
  const inner = trayInnerWidth(vw);
  const notches = chipNotches(vw);
  const perRow = (size: number): number => Math.max(1, Math.floor((inner + CHIP_GAP) / (size + CHIP_GAP)));
  for (const [step, size] of notches.entries()) {
    if (n <= perRow(size) * 2) return { size, step, visible: n, hidden: 0 };
  }
  const last = notches[notches.length - 1]!;
  const cap = perRow(last) * 2;
  const visible = Math.max(0, cap - 1); // one slot is the "+K" chip
  return { size: last, step: notches.length - 1, visible, hidden: n - visible };
}
