import { describe, expect, it } from "vitest";
import { teamEditingError } from "../src/customGate.js";

describe("teamEditingError — organizer-only in-place saves", () => {
  it("allows new builds without teamId", () => {
    expect(teamEditingError({ teamId: undefined, organizer: false, adminAuthed: false })).toBeUndefined();
  });

  it("returns the exact error that the build route maps to 403 for a plain coach", () => {
    expect(teamEditingError({ teamId: "owned", organizer: false, adminAuthed: false })).toBe(
      "team editing is organizer-only during testing",
    );
  });

  it("admits organizer identity or admin auth", () => {
    expect(teamEditingError({ teamId: "owned", organizer: true, adminAuthed: false })).toBeUndefined();
    expect(teamEditingError({ teamId: "owned", organizer: false, adminAuthed: true })).toBeUndefined();
  });
});
