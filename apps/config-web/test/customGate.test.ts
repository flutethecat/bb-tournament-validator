import { describe, expect, it } from "vitest";
import { customModeError } from "../src/customGate.js";

describe("customModeError — SR-260 ③ gate on custom:true", () => {
  it("ignores requests without custom (false/undefined) — normal builds untouched", () => {
    expect(customModeError({ custom: undefined, organizer: false, adminAuthed: false })).toBeUndefined();
    expect(customModeError({ custom: false, organizer: false, adminAuthed: false })).toBeUndefined();
  });

  it("refuses custom from a plain coach — fail closed, clear message", () => {
    const err = customModeError({ custom: true, organizer: false, adminAuthed: false });
    expect(err).toMatch(/organizer/i);
  });

  it("gates on truthiness, matching the routes' truthy honor sites", () => {
    // `custom: "yes"` would bypass validation in the handlers, so it must be gated too.
    expect(customModeError({ custom: "yes", organizer: false, adminAuthed: false })).toBeDefined();
  });

  it("admits an organizer session", () => {
    expect(customModeError({ custom: true, organizer: true, adminAuthed: false })).toBeUndefined();
  });

  it("admits admin auth (ADMIN_PASSWORD Basic or admin bearer token)", () => {
    expect(customModeError({ custom: true, organizer: false, adminAuthed: true })).toBeUndefined();
  });
});
