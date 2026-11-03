// Fork route lockdown, flag OFF (the production default): my-games and build keep their pre-lockdown answers and order of
// checks once the host is configured (Sol P2, 11-03): a body without a coach is 400 "coach is required", an invalid builder
// body is the validation 400, never 401 sign_in_required. FORK_DB_HOST points at a closed port: these answers come before
// any DB call. Flag ON, the same requests answer 401 sign_in_required.
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { onboardedCoaches } from "./onboardedFixture.js";

const root = mkdtempSync(join(tmpdir(), "fork-lockdown-flag-off-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    ADMIN_PASSWORD: "admin-secret",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    SESSIONS_FILE: join(root, "sessions.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_BUILDER_SAVES_DIR: join(root, "saves"),
    FORK_STATE_DIR: join(root, "state"),
    FORK_TEAMS_DIR: join(root, "teams"),
    FORK_DB_HOST: "127.0.0.1",
    FORK_DB_PORT: "1",
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    BUG_REPORTS_DIR: join(root, "bug-reports"),
    TABLETOP_DIR: join(root, "tabletop"),
    TEAM_AVATARS_DIR: join(root, "team-avatars"),
    COACH_AVATARS_DIR: join(root, "coach-avatars"),
    COACH_REGISTRY_JSON: join(root, "coach-registry.json"),
    CONFIG_WEB_LOG_DIR: join(root, "log"),
    BUILD_LOG_FILE: join(root, "build-log.json"),
    FORK_ADMIN_PASSWORD: "",
    SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  previousEnv.set("FORK_ROUTES_REQUIRE_AUTH", process.env.FORK_ROUTES_REQUIRE_AUTH);
  delete process.env.FORK_ROUTES_REQUIRE_AUTH;
  for (const directory of ["library", "saves", "state", "teams", "packages", "tournaments", "bug-reports", "tabletop", "log"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: onboardedCoaches("LockCoach") }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterEach(() => { delete process.env.FORK_ROUTES_REQUIRE_AUTH; });

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<{ status: number; error?: string; code?: string }> {
  const res = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return { status: res.status, ...(typeof json.error === "string" ? { error: json.error } : {}), ...(typeof json.code === "string" ? { code: json.code } : {}) };
}

describe("fork route lockdown off: my-games and build answer as before", () => {
  it("POST /api/fork/my-games {} is 400 coach is required", async () => {
    expect(await post("/api/fork/my-games", {})).toEqual({ status: 400, error: "coach is required" });
  });

  it("POST /api/fork/team-builder/build with an invalid body is the validation 400", async () => {
    expect(await post("/api/fork/team-builder/build", [])).toEqual({ status: 400, error: "request body must be a JSON object." });
  });

  it("with the flag on, the same requests are 401 sign_in_required", async () => {
    process.env.FORK_ROUTES_REQUIRE_AUTH = "1";
    expect((await post("/api/fork/my-games", {})).code).toBe("sign_in_required");
    expect((await post("/api/fork/team-builder/build", [])).code).toBe("sign_in_required");
  });
});
