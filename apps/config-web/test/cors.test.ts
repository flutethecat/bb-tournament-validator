import { describe, expect, it } from "vitest";
import { APP_WEBVIEW_ORIGINS, corsDecision, nullOriginEligible, parseAllowedOrigins } from "../src/cors.js";

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

  it("the 1.0.31+ app-patch page origins are allowed by default (owner 10-01: bug reports 403'd on the preflight)", () => {
    const set = parseAllowedOrigins(undefined);
    expect(corsDecision("http://sfapp.localhost", "cfg.example:4310", set).kind).toBe("allowed");
    expect(corsDecision("https://sfapp.localhost", "cfg.example:4310", set).kind).toBe("allowed");
    expect(corsDecision("sfapp://localhost", "cfg.example:4310", set).kind).toBe("allowed");
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
    expect(corsDecision("null", "box.example:4310", allow).kind).toBe("denied"); // unless the caller passes allowNullOrigin
    expect(corsDecision("not a url", "box.example:4310", allow).kind).toBe("denied");
  });

  it("never treats a wildcard entry as a real origin match for arbitrary origins", () => {
    // Someone setting CORS_ALLOWED_ORIGINS=* gets a literal (useless) entry, not a wildcard.
    expect(corsDecision("https://evil.example", "h:1", parseAllowedOrigins("*")).kind).toBe("denied");
  });
});

// Owner 11-06 (Linux "Origin not allowed"): plugin-http serializes sfapp://localhost as the opaque origin "null".
describe("Origin null (the Linux / macOS app)", () => {
  const allow = parseAllowedOrigins(undefined);
  it("is allowed only when the request carries no ambient browser credential", () => {
    expect(corsDecision("null", "h:1", allow, { allowNullOrigin: true })).toEqual({ kind: "allowed", origin: "null" });
    expect(corsDecision("null", "h:1", allow, { allowNullOrigin: false }).kind).toBe("denied");
    expect(nullOriginEligible({}, "/api/bug-reports")).toBe(true);
    expect(nullOriginEligible({ authorization: "Bearer abc" }, "/api/bug-reports")).toBe(true);
  });
  it("Sol 11-06 HIGH: a cookie or a (browser-cached) Basic login makes it ineligible", () => {
    expect(nullOriginEligible({ cookie: "cw_session=x" }, "/api/bug-reports")).toBe(false);
    expect(nullOriginEligible({ authorization: "Basic YWRtaW46eA==" }, "/api/fork/game/1/delete")).toBe(false);
    expect(nullOriginEligible({ authorization: "  basic YWRtaW46eA==" }, "/api/x")).toBe(false);
  });
  it("Sol 11-06 LOW: never on the loopback-gated test-login routes", () => {
    expect(nullOriginEligible({}, "/api/auth/test-login/options")).toBe(false);
    expect(nullOriginEligible({}, "/api/auth/test-login")).toBe(false);
    expect(nullOriginEligible({}, "/api/auth/test-loginx")).toBe(true);
  });
});
