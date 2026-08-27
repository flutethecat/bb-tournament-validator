import { describe, expect, it } from "vitest";
import { teamBuilderWireError } from "../src/teamBuilderWire";

describe("teamBuilderWireError", () => {
  it.each([null, [], "body", 1] as unknown[])("rejects invalid root %j", (body) => {
    expect(teamBuilderWireError(body)).toBe("request body must be a JSON object.");
  });

  it.each([{}, { apothecary: true }, { apothecary: false }, { packageName: "bb2025-default" }, { teamId: "123" },
    { rosteredInducements: [{ key: "bloodweiser_kegs", count: 2 }] }])(
    "accepts %j",
    (body) => {
      expect(teamBuilderWireError(body)).toBeNull();
    },
  );

  it.each([
    { apothecary: 0 },
    { apothecary: 1 },
    { apothecary: "true" },
    { apothecary: null },
  ])("rejects %j", (body) => {
    expect(teamBuilderWireError(body)).toBe("apothecary must be a boolean when supplied.");
  });

  it.each([{ packageName: 1 }, { packageName: true }, { packageName: null }])(
    "rejects %j",
    (body) => {
      expect(teamBuilderWireError(body)).toBe("packageName must be a string when supplied.");
    },
  );

  it.each([{ teamId: 1 }, { teamId: true }, { teamId: null }, { teamId: "  " }])(
    "rejects %j",
    (body) => {
      expect(teamBuilderWireError(body)).toBe("teamId must be a non-empty string when supplied.");
    },
  );

  it.each([
    { rosteredInducements: {} },
    { rosteredInducements: [null] },
    { rosteredInducements: [{ key: "", count: 1 }] },
    { rosteredInducements: [{ key: "bribes", count: 0 }] },
  ])(
    "rejects %j",
    (body) => {
      expect(teamBuilderWireError(body)).toMatch(/rosteredInducements|rostered inducement/i);
    },
  );
});
