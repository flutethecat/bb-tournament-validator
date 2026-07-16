import { describe, expect, it } from "vitest";
import { mirrorX, computeActiveFeatures } from "../src/super/service";
import { getFeature, serviceCapabilities } from "../src/super/registry";

// Fast-follow teeth for the Super MVP service-side (Kallus QR note / Yularen fast-follow): the
// security-sensitive pure core — frame normalization, payload validation, membership intersection.

describe("mirrorX (frame normalization, SM-1/RC-1)", () => {
  it("home seat is identity; away seat mirrors x = 25 - x, y untouched by the caller", () => {
    expect(mirrorX(7, "home")).toBe(7);
    expect(mirrorX(7, "away")).toBe(18); // 25 - 7
    expect(mirrorX(0, "away")).toBe(25);
    expect(mirrorX(25, "away")).toBe(0);
    expect(mirrorX(12, "away")).toBe(13);
  });

  it("round-trips: publisher-local → global → recipient-local lands the right square for both seats", () => {
    // away publisher at local x=3 → global; a home recipient sees global as-is; an away recipient re-mirrors.
    for (const x of [0, 3, 12, 13, 25]) {
      // away publishes local x → global
      const global = mirrorX(x, "away");
      // home recipient: global → local (identity)
      expect(mirrorX(global, "home")).toBe(global);
      // away recipient: global → local returns the ORIGINAL publisher-local x (self-inverse)
      expect(mirrorX(global, "away")).toBe(x);
      // home publisher: local == global, away recipient sees the mirror
      expect(mirrorX(mirrorX(x, "home"), "away")).toBe(25 - x);
    }
  });
});

describe("registry validate-at-admission (SM-2)", () => {
  const validate = getFeature("s1.kickAim")!.validate;

  it("accepts in-bounds integer coords and returns only {x,y}", () => {
    expect(validate({ x: 5, y: 7 })).toEqual({ x: 5, y: 7 });
    expect(validate({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(validate({ x: 25, y: 14 })).toEqual({ x: 25, y: 14 });
    // strips extra fields — only the schema'd keys are relayed
    expect(validate({ x: 5, y: 7, evil: "drop me" })).toEqual({ x: 5, y: 7 });
  });

  it("DROPS hostile / malformed payloads (never relays them)", () => {
    expect(validate({ x: 9999, y: 3 })).toBeNull();   // out of bounds
    expect(validate({ x: 3, y: NaN })).toBeNull();    // NaN
    expect(validate({ x: 1.5, y: 2 })).toBeNull();    // non-integer
    expect(validate({ x: -1, y: 2 })).toBeNull();     // negative
    expect(validate({ x: 3 })).toBeNull();            // missing y
    expect(validate("nope")).toBeNull();              // not an object
    expect(validate(null)).toBeNull();
    expect(validate({ x: "3", y: "4" })).toBeNull();  // string coords
  });

  it("s1.kickAim is an advertised service capability (SC-5 kill-switch surface)", () => {
    expect(serviceCapabilities()).toContain("s1.kickAim");
    expect(getFeature("nope.notreal")).toBeUndefined();
  });
});

describe("computeActiveFeatures (membership intersection, SM-4)", () => {
  const svc = new Set(["s1.kickAim", "s2.hoverDice"]);

  it("a lone coach ⇒ everything inert (empty set)", () => {
    expect([...computeActiveFeatures([new Set(["s1.kickAim"])], svc)]).toEqual([]);
    expect([...computeActiveFeatures([], svc)]).toEqual([]);
  });

  it("two coaches ⇒ only the intersection of BOTH caps ∩ service is active", () => {
    const both = computeActiveFeatures([new Set(["s1.kickAim"]), new Set(["s1.kickAim"])], svc);
    expect([...both]).toEqual(["s1.kickAim"]);
    // one-sided capability → inert
    const oneSided = computeActiveFeatures([new Set(["s1.kickAim"]), new Set(["s2.hoverDice"])], svc);
    expect([...oneSided]).toEqual([]);
    // a cap neither the service nor both advertise never activates
    const unknown = computeActiveFeatures([new Set(["s9.ghost"]), new Set(["s9.ghost"])], svc);
    expect([...unknown]).toEqual([]);
  });
});
