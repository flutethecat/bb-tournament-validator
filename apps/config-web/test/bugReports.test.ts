import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  APP_LOG_CAP,
  BodyTooLargeError,
  CONTEXT_CAP,
  RATE_LIMIT_MAX,
  RATE_WINDOW_MS,
  WIRE_LOG_CAP,
  bugReportAccessError,
  getBugReport,
  listBugReports,
  readJsonCapped,
  reportTimesByCoach,
  sanitizeComponent,
  submitBugReport,
} from "../src/bugReports.js";

const HUNTER2_MD5 = createHash("md5").update("hunter2", "utf8").digest("hex");

const dir = () => mkdtempSync(join(tmpdir(), "bbtv-bugreports-"));

const deps = (d: string) => ({
  dir: d,
  authenticationAvailable: true,
  verifyCoachDigest: (coach: string, passwordMd5: string) =>
    Promise.resolve(coach === "Tarkin" && passwordMd5 === HUNTER2_MD5),
});

const BASE = { coach: "Tarkin", passwordMd5: HUNTER2_MD5, description: "Ball vanished after blitz." };

afterEach(() => reportTimesByCoach.clear());

async function* stream(chunks: string[]): AsyncIterable<Buffer> {
  for (const c of chunks) yield Buffer.from(c, "utf8");
}

describe("POST /api/bug-reports — submitBugReport", () => {
  it("stores a report with logs and STRIPS credentials from report.json", async () => {
    const d = dir();
    const result = await submitBugReport(
      { ...BASE, gameId: "g794", clientVersion: "0.3.18", wireLog: "WIRE", appLog: "APP", context: { turn: 7 } },
      undefined,
      deps(d),
    );
    expect(result.status).toBe(200);
    const { id } = result.body as { id: string };
    const raw = readFileSync(join(d, id, "report.json"), "utf8");
    const report = JSON.parse(raw) as Record<string, unknown>;
    expect(report.coach).toBe("Tarkin");
    expect(report.gameId).toBe("g794");
    expect(report.clientVersion).toBe("0.3.18");
    expect(report.context).toEqual({ turn: 7 });
    expect(raw).not.toContain(HUNTER2_MD5);
    expect(raw).not.toContain("password");
    expect(readFileSync(join(d, id, "wire.log"), "utf8")).toBe("WIRE");
    expect(readFileSync(join(d, id, "app.log"), "utf8")).toBe("APP");
  });

  it("omits log files that weren't provided", async () => {
    const d = dir();
    const result = await submitBugReport(BASE, undefined, deps(d));
    const { id } = result.body as { id: string };
    expect(existsSync(join(d, id, "wire.log"))).toBe(false);
    expect(existsSync(join(d, id, "app.log"))).toBe(false);
    const files = (JSON.parse(readFileSync(join(d, id, "report.json"), "utf8")) as { files: unknown }).files;
    expect(files).toEqual({ wireLog: null, appLog: null });
  });

  it("accepts a Bearer session identity instead of body creds", async () => {
    const d = dir();
    const result = await submitBugReport(
      { description: "Session-authed report." },
      { coach: "Fives", organizer: false },
      deps(d),
    );
    expect(result.status).toBe(200);
    const { id } = result.body as { id: string };
    expect((JSON.parse(readFileSync(join(d, id, "report.json"), "utf8")) as { coach: string }).coach).toBe("Fives");
  });

  it("accepts legacy clear-text `password` (dual-accept)", async () => {
    const result = await submitBugReport(
      { coach: "Tarkin", password: "hunter2", description: "legacy creds" },
      undefined,
      deps(dir()),
    );
    expect(result.status).toBe(200);
  });

  it("401s wrong creds and missing creds; 503 when the fork DB is unavailable", async () => {
    const d = dir();
    expect((await submitBugReport({ ...BASE, passwordMd5: createHash("md5").update("x").digest("hex") }, undefined, deps(d))).status).toBe(401);
    expect((await submitBugReport({ description: "no creds" }, undefined, deps(d))).status).toBe(401);
    expect((await submitBugReport(BASE, undefined, { ...deps(d), authenticationAvailable: false })).status).toBe(503);
    expect(readdirSync(d)).toEqual([]); // nothing persisted on any failure
  });

  it("400s a missing or over-4000-char description", async () => {
    const d = dir();
    expect((await submitBugReport({ coach: "Tarkin", passwordMd5: HUNTER2_MD5 }, undefined, deps(d))).status).toBe(400);
    expect((await submitBugReport({ ...BASE, description: "x".repeat(4001) }, undefined, deps(d))).status).toBe(400);
  });

  it("413s oversize wireLog / appLog / context", async () => {
    const d = dir();
    const over = (n: number) => "x".repeat(n + 1);
    expect((await submitBugReport({ ...BASE, wireLog: over(WIRE_LOG_CAP) }, undefined, deps(d))).status).toBe(413);
    expect((await submitBugReport({ ...BASE, appLog: over(APP_LOG_CAP) }, undefined, deps(d))).status).toBe(413);
    expect((await submitBugReport({ ...BASE, context: { blob: over(CONTEXT_CAP) } }, undefined, deps(d))).status).toBe(413);
    expect(readdirSync(d)).toEqual([]);
  });

  it("rate limits at 10/hour per coach and recovers after the window", async () => {
    const d = dir();
    const t0 = Date.now();
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1)
      expect((await submitBugReport(BASE, undefined, deps(d), t0 + i)).status).toBe(200);
    const limited = await submitBugReport(BASE, undefined, deps(d), t0 + RATE_LIMIT_MAX);
    expect(limited.status).toBe(429);
    expect(limited.headers?.["retry-after"]).toBeDefined();
    expect((await submitBugReport(BASE, undefined, deps(d), t0 + RATE_WINDOW_MS + 1)).status).toBe(200);
  });

  it("sanitizes a path-traversal coach/gameId into the report dir (never outside it)", async () => {
    const d = dir();
    const result = await submitBugReport(
      { description: "traversal", gameId: "../../../etc/passwd" },
      { coach: "..\\..\\evil", organizer: false },
      deps(d),
    );
    expect(result.status).toBe(200);
    const { id } = result.body as { id: string };
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(resolve(join(d, id)).startsWith(resolve(d))).toBe(true);
    expect(readdirSync(d)).toEqual([id]); // exactly one folder, inside the dir
  });
});

describe("readJsonCapped", () => {
  it("parses under the cap and throws BodyTooLargeError over it", async () => {
    expect(await readJsonCapped(stream(['{"a":1}']), 100)).toEqual({ a: 1 });
    await expect(readJsonCapped(stream(["x".repeat(60), "x".repeat(60)]), 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("sanitizeComponent", () => {
  it("allowlists [A-Za-z0-9_-], truncates, and falls back when empty", () => {
    expect(sanitizeComponent("../../etc", "fallback")).toBe("etc");
    expect(sanitizeComponent("Tarkin_79-4", "fallback")).toBe("Tarkin_79-4");
    expect(sanitizeComponent("///", "nogame")).toBe("nogame");
    expect(sanitizeComponent("a".repeat(99), "f")).toHaveLength(40);
  });
});

describe("GET gates + reads", () => {
  it("fails closed without organizer or admin auth", () => {
    expect(bugReportAccessError({ organizer: false, adminAuthed: false })).toBeDefined();
    expect(bugReportAccessError({ organizer: true, adminAuthed: false })).toBeUndefined();
    expect(bugReportAccessError({ organizer: false, adminAuthed: true })).toBeUndefined();
  });

  it("lists newest-first with truncated descriptions; get returns the full report.json", async () => {
    const d = dir();
    const first = await submitBugReport({ ...BASE, description: "y".repeat(300) }, undefined, deps(d), Date.UTC(2026, 7, 18, 10));
    const second = await submitBugReport({ ...BASE, gameId: "g2" }, undefined, deps(d), Date.UTC(2026, 7, 18, 11));
    const rows = listBugReports(d);
    expect(rows.map((r) => r.id)).toEqual([(second.body as { id: string }).id, (first.body as { id: string }).id]);
    expect(rows[1]!.description).toHaveLength(200);
    expect(rows[0]!.gameId).toBe("g2");
    const full = getBugReport(d, rows[1]!.id) as { description: string };
    expect(full.description).toHaveLength(300);
  });

  it("refuses a traversal id and unknown ids", () => {
    const d = dir();
    expect(getBugReport(d, "../secrets")).toBeUndefined();
    expect(getBugReport(d, "nope")).toBeUndefined();
  });
});
