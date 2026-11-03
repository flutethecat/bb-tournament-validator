/**
 * The site's ONE dice roller (spec-forfeit-and-dice-2026-11-02, Decisions: "Super Fumbbl is the presentation layer,
 * FFB-Server is the roller ... Node here would be just fine"). Every roll the site makes goes through here: the recorder's
 * dice roller and pre-game "Roll for me", the coin and seat draws, the redraft rest rolls and forfeit defections.
 *
 * Fairness: the default source is Node's CSPRNG through `crypto.randomInt`, which draws uniformly with rejection
 * sampling (an out-of-range draw is thrown away and drawn again, never folded with a modulo), the same method as FFB's
 * Fortuna. The seeded source used by tests applies the same rejection sampling to a small deterministic generator, so a
 * test can replay an exact sequence and still check the distribution.
 *
 * Injection: callers take a `Roller` (or a `die` function) from their deps; tests pass `seededRoller(seed)` or a fixed
 * sequence (`sequenceRoller`). Nothing here keeps global state, so two callers never share a stream by accident.
 */
import { randomInt } from "node:crypto";

/** A uniform integer source: `int(min, max)` returns min..max inclusive. */
export interface Roller {
  int(min: number, max: number): number;
}

/** One die of `sides` faces: 1..sides. */
export const rollDie = (roller: Roller, sides: number): number => roller.int(1, sides);
/** `count` dice of `sides` faces, in roll order. */
export const rollDice = (roller: Roller, sides: number, count: number): number[] => Array.from({ length: count }, () => rollDie(roller, sides));
/** A fair coin: true or false. */
export const flipCoin = (roller: Roller): boolean => roller.int(0, 1) === 1;
/** A uniform index into a list of `length` items (0..length-1). */
export const pickIndex = (roller: Roller, length: number): number => roller.int(0, length - 1);

const checkRange = (min: number, max: number): void => {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new RangeError("roller: bad range");
  if (max - min >= 2 ** 32) throw new RangeError("roller: range too large");
};

/** The live source: Node's CSPRNG (crypto.randomInt, uniform by rejection sampling). */
export const cryptoRoller: Roller = {
  int(min, max) {
    checkRange(min, max);
    return randomInt(min, max + 1);
  },
};

/**
 * A deterministic source for tests: mulberry32 32-bit words, mapped to the range by rejection sampling (draws in the
 * incomplete top bucket are discarded), so the output is exactly uniform over the range.
 */
export function seededRoller(seed: number): Roller {
  let a = seed >>> 0;
  const next32 = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    int(min, max) {
      checkRange(min, max);
      const span = max - min + 1;
      const limit = Math.floor(2 ** 32 / span) * span; // largest multiple of span: draws at or above it are rejected
      for (;;) {
        const x = next32();
        if (x < limit) return min + (x % span);
      }
    },
  };
}

/** A fixed sequence for tests (each value must lie in the asked range; the sequence repeats). */
export function sequenceRoller(values: readonly number[]): Roller {
  let i = 0;
  return {
    int(min, max) {
      const v = values[i % values.length]!;
      i += 1;
      if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`sequenceRoller: ${v} is outside ${min}..${max}`);
      return v;
    },
  };
}

/** A `die(sides)` function over a roller (the older injection shape some deps still take). */
export const dieFrom = (roller: Roller) => (sides: number): number => rollDie(roller, sides);
/** A roller over a `die(sides)` function (an injected test die keeps working): int(min,max) = min - 1 + die(span). */
export const rollerFromDie = (die: (sides: number) => number): Roller => ({
  int(min, max) {
    checkRange(min, max);
    return min - 1 + die(max - min + 1);
  },
});
