// Fork route lockdown policy (src/auth/forkRouteAuth.ts): the flag default, the service key and the gate table.
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCKABLE_FORK_ROUTES,
  forkGateAdmits,
  forkRouteDenial,
  forkRoutesRequireAuth,
  isLockableForkRoute,
  serviceKeyMatches,
} from "../src/auth/forkRouteAuth.js";

afterEach(() => { delete process.env.FORK_ROUTES_REQUIRE_AUTH; });

describe("forkRoutesRequireAuth", () => {
  it("is OFF unless the env says on (owner 11-03)", () => {
    expect(forkRoutesRequireAuth({})).toBe(false);
    for (const off of ["", "0", "false", "off", "no", "maybe"]) expect(forkRoutesRequireAuth({ FORK_ROUTES_REQUIRE_AUTH: off }), off).toBe(false);
    for (const on of ["1", "true", "ON", " yes "]) expect(forkRoutesRequireAuth({ FORK_ROUTES_REQUIRE_AUTH: on }), on).toBe(true);
  });
});

describe("serviceKeyMatches", () => {
  it("matches only the configured key; an unset key never matches", () => {
    expect(serviceKeyMatches("k1", { CONFIG_WEB_SERVICE_KEY: "k1" })).toBe(true);
    expect(serviceKeyMatches("k2", { CONFIG_WEB_SERVICE_KEY: "k1" })).toBe(false);
    expect(serviceKeyMatches("", { CONFIG_WEB_SERVICE_KEY: "" })).toBe(false);
    expect(serviceKeyMatches("anything", {})).toBe(false);
    expect(serviceKeyMatches(undefined, { CONFIG_WEB_SERVICE_KEY: "k1" })).toBe(false);
    expect(serviceKeyMatches(["k1"], { CONFIG_WEB_SERVICE_KEY: "k1" })).toBe(false);
  });
});

describe("lockable routes", () => {
  it("never include the open sign-in / builder routes or the (temporarily exempt) game-creation routes", () => {
    for (const path of [
      "/api/fork/login", "/api/fork/name-available", "/api/fork/register", "/api/fork/rosters",
      "/api/fork/team-builder/tiers", "/api/fork/team-builder/limits", "/api/fork/team-builder/inducements",
      "/api/fork/team-builder/legal-skills", "/api/fork/team-builder/preview",
      "/api/fork/challenge", "/api/fork/matchstatus", "/api/fork/cancel", "/api/fork/jnlp",
    ]) expect(isLockableForkRoute(path), path).toBe(false);
  });

  it("flag off: the old public posture per gate (records/games/retire were public only on the sidecar-off gate)", () => {
    for (const [path, policy] of LOCKABLE_FORK_ROUTES) {
      const method = [...policy.methods][0]!;
      expect(forkGateAdmits(method, path, {}, "public-paths"), path).toBe(true);
      expect(forkGateAdmits(method, path, {}, "session"), path).toBe(policy.legacyGate === "both");
      expect(forkRouteDenial(method, path, { signedIn: false, adminCredential: false, service: false }), path).toBeUndefined();
    }
  });

  it("flag on: anonymous is refused except the body-credential routes; credentials pass the gate to the handler", () => {
    process.env.FORK_ROUTES_REQUIRE_AUTH = "1";
    const anon = { signedIn: false, adminCredential: false, service: false };
    for (const [path, policy] of LOCKABLE_FORK_ROUTES) {
      const method = [...policy.methods][0]!;
      const body = policy.kind === "body-credential";
      expect(forkGateAdmits(method, path, {}, "session"), path).toBe(body);
      expect(forkGateAdmits(method, path, { authorization: "Basic eA==" }, "session"), path).toBe(true);
      expect(forkRouteDenial(method, path, anon)?.body.code, path).toBe(body ? undefined : "sign_in_required");
      expect(forkRouteDenial(method, path, { ...anon, signedIn: true }), path).toBeUndefined();
      expect(forkRouteDenial(method, path, { ...anon, service: true }) === undefined, path).toBe(body || policy.kind === "service-read");
    }
  });

  it("a method the route does not list is not covered (the handler answers it)", () => {
    process.env.FORK_ROUTES_REQUIRE_AUTH = "1";
    expect(forkRouteDenial("DELETE", "/api/fork/library", { signedIn: false, adminCredential: false, service: false })).toBeUndefined();
  });
});
