import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminResponse, forkAdminConfigFromEnv } from "@bb/fork-ops";

describe("adminResponse", () => {
  // Golden vector derived from the LIVE fork (2026-07-09): GET /admin/challenge returned
  // this exact challenge; the computed response was verified to authenticate successfully
  // against GET /admin/cache?response=<computed> (status: ok) before trusting this in code.
  it("matches the real fork's expected response for a known challenge/password pair", () => {
    const challenge = "3c67e0dacb39754d058e398f9911ab71";
    const passwordMd5Hex = "098f6bcd4621d373cade4e832627b4f6"; // md5("test") — server-dev.ini admin.password
    expect(adminResponse(challenge, passwordMd5Hex)).toBe("dbcab631cd5fcb3e9d50bc9df4fe752d");
  });

  it("produces a different response for a different challenge (not a constant)", () => {
    const passwordMd5Hex = "098f6bcd4621d373cade4e832627b4f6";
    const a = adminResponse("3c67e0dacb39754d058e398f9911ab71", passwordMd5Hex);
    const b = adminResponse("00000000000000000000000000000000".slice(0, 32), passwordMd5Hex);
    expect(a).not.toBe(b);
  });

  it("produces a different response for a different password (not ignoring the key)", () => {
    const challenge = "3c67e0dacb39754d058e398f9911ab71";
    const a = adminResponse(challenge, "098f6bcd4621d373cade4e832627b4f6");
    const b = adminResponse(challenge, "827ccb0eea8a706c4c34a16891f84e7b"); // md5("12345")
    expect(a).not.toBe(b);
  });

  it("is deterministic (same inputs -> same output)", () => {
    const challenge = "3c67e0dacb39754d058e398f9911ab71";
    const passwordMd5Hex = "098f6bcd4621d373cade4e832627b4f6";
    expect(adminResponse(challenge, passwordMd5Hex)).toBe(adminResponse(challenge, passwordMd5Hex));
  });
});

describe("forkAdminConfigFromEnv", () => {
  const KEYS = ["FORK_ADMIN_PASSWORD", "FORK_ADMIN_URL", "FORK_GAME_PORT"] as const;
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is undefined when FORK_ADMIN_PASSWORD is unset (opt-in signal)", () => {
    expect(forkAdminConfigFromEnv()).toBeUndefined();
  });

  it("defaults to http://127.0.0.1:22227 when only the password is set", () => {
    process.env.FORK_ADMIN_PASSWORD = "abc123";
    expect(forkAdminConfigFromEnv()).toEqual({ baseUrl: "http://127.0.0.1:22227", passwordMd5Hex: "abc123" });
  });

  it("honors FORK_GAME_PORT and an explicit FORK_ADMIN_URL override", () => {
    process.env.FORK_ADMIN_PASSWORD = "abc123";
    process.env.FORK_GAME_PORT = "22228";
    expect(forkAdminConfigFromEnv()).toEqual({ baseUrl: "http://127.0.0.1:22228", passwordMd5Hex: "abc123" });
    process.env.FORK_ADMIN_URL = "http://10.0.0.5:9999";
    expect(forkAdminConfigFromEnv()).toEqual({ baseUrl: "http://10.0.0.5:9999", passwordMd5Hex: "abc123" });
  });
});
