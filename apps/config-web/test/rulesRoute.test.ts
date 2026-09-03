import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "config-web-rules-route-"));
const previousEnv = new Map<string, string | undefined>();
const packageFile = resolve("tournament-packages/naf-world-cup-2027.json");
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

beforeAll(async () => {
  const packageDir = join(root, "packages");
  mkdirSync(packageDir, { recursive: true });
  copyFileSync(packageFile, join(packageDir, "naf-world-cup-2027.json"));

  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "0",
    HOST: "127.0.0.1",
    PORT: "0",
    ADMIN_PASSWORD: "rules-route-test-password",
    PACKAGES_DIR: packageDir,
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }

  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening)
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => error ? reject(error) : resolveClose()),
    );
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("public ruleset route", () => {
  it("GET /rules/naf-world-cup-2027 returns the rendered NAF World Cup 2027 page", async () => {
    const response = await fetch(`${origin}/rules/naf-world-cup-2027`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(body).toContain("<h1>NAF World Cup 2027");
  });

  it("GET ?roster=Ogre renders the race panel and marks the Ogre row current", async () => {
    const response = await fetch(`${origin}/rules/naf-world-cup-2027?roster=Ogre`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<h2>Your team: Ogre</h2>");
    expect(body).toMatch(/data-roster="Ogre" aria-current="true"/);
  });

  it("GET unknown package id returns a 404 in the rules-page shell", async () => {
    const response = await fetch(`${origin}/rules/does-not-exist`);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain('class="rules-page"');
    expect(body).toContain("No ruleset called");
  });

  it("GET /rules succeeds without an Authorization header even when admin auth is configured", async () => {
    const response = await fetch(`${origin}/rules/naf-world-cup-2027`);

    expect(response.status).toBe(200);
  });

  it("POST /rules/x returns 405", async () => {
    const response = await fetch(`${origin}/rules/x`, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("POST /api/export is byte-identical to GET /rules for the same package and generatedAt", async () => {
    const rawPackage = readFileSync(packageFile, "utf8");
    const [pageResponse, exportResponse] = await Promise.all([
      fetch(`${origin}/rules/naf-world-cup-2027`),
      fetch(`${origin}/api/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawPackage,
      }),
    ]);

    expect(pageResponse.status).toBe(200);
    expect(exportResponse.status).toBe(200);
    expect(await exportResponse.text()).toBe(await pageResponse.text());
  });
});
