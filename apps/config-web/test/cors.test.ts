import { describe, expect, it } from "vitest";
import { APP_WEBVIEW_ORIGINS, corsDecision, parseAllowedOrigins } from "../src/cors.js";

describe("parseAllowedOrigins", () => {
  it("splits, trims, lowercases, and drops trailing slashes + empties", () => {
    const set = parseAllowedOrigins(" https://To.Example.com/ , http://localhost:5173 ,, ");
    expect(set).toEqual(new Set([...APP_WEBVIEW_ORIGINS, "https://to.example.com", "http://localhost:5173"]));
  });

  it("unset env yields exactly the app WebView origins (08-18: Tauri v2 plugin-http sends Origin)", () => {
    expect(parseAllowedOrigins(undefined)).toEqual(new Set(APP_WEBVIEW_ORIGINS));
  });

  it("the packaged app's WebView origin is allowed by default", () => {
    const set = parseAllowedOrigins(undefined);
    expect(corsDecision("http://tauri.localhost", "cfg.example:4310", set).kind).toBe("allowed");
    expect(corsDecision("tauri://localhost", "cfg.example:4310", set).kind).toBe("allowed");
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
