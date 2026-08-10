import { describe, expect, it } from "vitest";
import { teamBuilderWireError } from "../src/teamBuilderWire";

describe("teamBuilderWireError", () => {
  it.each([null, [], "body", 1] as unknown[])("rejects invalid root %j", (body) => {
    expect(teamBuilderWireError(body)).toBe("request body must be a JSON object.");
  });

  it.each([{}, { apothecary: true }, { apothecary: false }])("accepts %j", (body) => {
    expect(teamBuilderWireError(body)).toBeNull();
  });

  it.each([
    { apothecary: 0 },
    { apothecary: 1 },
    { apothecary: "true" },
    { apothecary: null },
  ])("rejects %j", (body) => {
    expect(teamBuilderWireError(body)).toBe("apothecary must be a boolean when supplied.");
  });
});
