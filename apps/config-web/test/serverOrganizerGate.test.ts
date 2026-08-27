import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";

const root = mkdtempSync(join(tmpdir(), "server-organizer-gate-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  mkdirSync(join(root, "library"), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");

  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/team/setResurrection organizer gate", () => {
  it("returns 401 without a session and 403 for a non-organizer coach session", async () => {
    const body = JSON.stringify({ teamId: "42", resurrection: true });
    const unauthenticated = await fetch(`${origin}/api/team/setResurrection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unauthenticated.status).toBe(401);

    const { token } = createSession("PlainCoach");
    const coach = await fetch(`${origin}/api/team/setResurrection`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
    expect(coach.status).toBe(403);
    expect(await coach.json()).toEqual({ error: "Organizer access required." });
  });
});
