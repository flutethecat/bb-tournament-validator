import { describe, expect, it } from "vitest";
import { corsDecision, parseAllowedOrigins } from "../src/cors.js";

describe("parseAllowedOrigins", () => {
  it("splits, trims, lowercases, and drops trailing slashes + empties", () => {
    const set = parseAllowedOrigins(" https://To.Example.com/ , http://localhost:5173 ,, ");
    expect(set).toEqual(new Set(["https://to.example.com", "http://localhost:5173"]));
  });

  it("unset env yields an empty allowlist (same-origin/no-Origin only)", () => {
    expect(parseAllowedOrigins(undefined).size).toBe(0);
  });
});

describe("corsDecision", () => {
  const allow = parseAllowedOrigins("http://localhost:5173");

  it("no Origin header (curl / tauriFetch / fork Java client) passes with no headers", () => {
    expect(corsDecision(undefined, "host:4310", allow)).toEqual({ kind: "no-origin" });
  });

  it("reflects an allowlisted origin, case-insensitively", () => {
    expect(corsDecision("http://LOCALHOST:5173", "host:4310", allow)).toEqual({
      kind: "allowed",
      origin: "http://LOCALHOST:5173",
    });
  });

  it("allows same-origin (config-web's own frontend) without any env", () => {
    expect(corsDecision("http://box.example:4310", "box.example:4310", new Set()).kind).toBe("allowed");
  });

  it("denies any other origin — fail closed", () => {
    expect(corsDecision("https://evil.example", "box.example:4310", allow).kind).toBe("denied");
    expect(corsDecision("null", "box.example:4310", allow).kind).toBe("denied");
    expect(corsDecision("not a url", "box.example:4310", allow).kind).toBe("denied");
  });

  it("never treats a wildcard entry as a real origin match for arbitrary origins", () => {
    // Someone setting CORS_ALLOWED_ORIGINS=* gets a literal (useless) entry, not a wildcard.
    expect(corsDecision("https://evil.example", "h:1", parseAllowedOrigins("*")).kind).toBe("denied");
  });
});
