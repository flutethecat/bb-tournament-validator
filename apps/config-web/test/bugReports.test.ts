import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  APP_LOG_CAP,
  BodyTooLargeError,
  CONTEXT_CAP,
  FIXED_IN_CAP,
  METADATA_FIELD_CAP,
  STATUS_RECORD_CAP,
  REPLY_CAP,
  STATUS_QUERY_MAX,
  RATE_LIMIT_MAX,
  RATE_WINDOW_MS,
  WIRE_LOG_CAP,
  bugReportAccessError,
  getBugReport,
  getBugReportScreenshot,
  listBugReports,
  lookupBugReportStatuses,
  newReceipt,
  normalizeGameService,
  parseStatusQuery,
  pruneBugReports,
  readJsonCapped,
  receiptMatches,
  reportTimesByCoach,
  sanitizeComponent,
  submitBugReport,
  updateBugReportTriage,
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

  it("persists gameService (owner 08-18) and names the folder <service>-<id> when both are present", async () => {
    const d = dir();
    const result = await submitBugReport(
      { ...BASE, gameId: "1932766", gameService: "fumbbl" },
      undefined,
      deps(d),
    );
    expect(result.status).toBe(200);
    const { id } = result.body as { id: string };
    expect(id).toContain("fumbbl-1932766");
    const report = JSON.parse(readFileSync(join(d, id, "report.json"), "utf8")) as Record<string, unknown>;
    expect(report.gameService).toBe("fumbbl");
    expect(report.gameId).toBe("1932766");
  });

  it("nulls an unrecognized gameService and keeps it OUT of the folder name", async () => {
    const d = dir();
    const result = await submitBugReport(
      { ...BASE, gameId: "868", gameService: "../../evil" },
      undefined,
      deps(d),
    );
    expect(result.status).toBe(200);
    const { id } = result.body as { id: string };
    expect(id).toContain("_868");
    expect(id).not.toContain("evil");
    const report = JSON.parse(readFileSync(join(d, id, "report.json"), "utf8")) as Record<string, unknown>;
    expect(report.gameService).toBeNull();
  });

  it("persists gameService without letting a serviceless/gameless report change folder naming", async () => {
    const d = dir();
    // service but NO game id: folder stays <stamp>_<coach>_nogame — a bare service label would lie.
    const result = await submitBugReport({ ...BASE, gameService: "fork" }, undefined, deps(d));
    const { id } = result.body as { id: string };
    expect(id).toMatch(/_nogame$/);
    expect((JSON.parse(readFileSync(join(d, id, "report.json"), "utf8")) as { gameService: string }).gameService).toBe("fork");
  });

  it("omits log files that weren't provided", async () => {
    const d = dir();
    const result = await submitBugReport(BASE, undefined, deps(d));
    const { id } = result.body as { id: string };
    expect(existsSync(join(d, id, "wire.log"))).toBe(false);
    expect(existsSync(join(d, id, "app.log"))).toBe(false);
    const files = (JSON.parse(readFileSync(join(d, id, "report.json"), "utf8")) as { files: unknown }).files;
    expect(files).toEqual({ wireLog: null, appLog: null, screenshot: null, screenshotMimeType: null });
  });

  it("stores feedback with a validated screenshot and default triage state", async () => {
    const d = dir();
    const bytes = Buffer.from("not-a-real-png-but-binary-storage-is-lossless");
    const result = await submitBugReport({
      ...BASE,
      kind: "feedback",
      screenshot: { fileName: "board.png", mimeType: "image/png", base64: bytes.toString("base64") },
    }, undefined, deps(d));
    expect(result.status).toBe(200);
    const { id } = result.body as { id: string };
    const report = getBugReport(d, id) as Record<string, unknown>;
    expect(report.kind).toBe("feedback");
    expect(report.triage).toMatchObject({ status: "new", rootCause: "", reason: "" });
    expect(getBugReportScreenshot(d, id)).toEqual({ mimeType: "image/png", base64: bytes.toString("base64") });
  });

  it("rejects unsupported or malformed screenshots", async () => {
    const d = dir();
    expect((await submitBugReport({ ...BASE, screenshot: { mimeType: "image/svg+xml", base64: "PHN2Zz4=" } }, undefined, deps(d))).status).toBe(400);
    expect((await submitBugReport({ ...BASE, screenshot: { mimeType: "image/png", base64: "%%%" } }, undefined, deps(d))).status).toBe(400);
    expect(readdirSync(d)).toEqual([]);
  });

  it("accepts explicit null log attachments from clients with logging disabled", async () => {
    const d = dir();
    const result = await submitBugReport({ ...BASE, wireLog: null, appLog: null }, undefined, deps(d));
    expect(result.status).toBe(200);
    const { id } = result.body as { id: string };
    expect(existsSync(join(d, id, "wire.log"))).toBe(false);
    expect(existsSync(join(d, id, "app.log"))).toBe(false);
  });

  it("accepts a Bearer session identity instead of body creds", async () => {
    const d = dir();
    const result = await submitBugReport(
      { description: "Session-authed report." },
      { coach: "Fives", organizer: false, admin: false },
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

  it("accepts a PUBLIC-edition report (owner 09-10) without creds, filed as fumbbl:<coach>, rate-limited per coach", async () => {
    const d = dir();
    const ok = await submitBugReport(
      { coach: "SomeFumbblCoach", publicEdition: true, description: "public edition report" },
      undefined,
      deps(d),
    );
    expect(ok.status).toBe(200);
    const folder = readdirSync(d)[0];
    const report = JSON.parse(readFileSync(join(d, folder, "report.json"), "utf8"));
    expect(report.coach).toBe("fumbbl:SomeFumbblCoach");
    expect(report).not.toHaveProperty("publicEdition");
    // no claimed coach → pooled under fumbbl:anonymous; a non-boolean flag still needs creds
    const anon = await submitBugReport({ publicEdition: true, description: "anon" }, undefined, deps(d));
    expect(anon.status).toBe(200);
    expect((await submitBugReport({ coach: "X", publicEdition: "true", description: "bad flag" }, undefined, deps(d))).status).toBe(401);
    for (let i = 0; i < RATE_LIMIT_MAX; i++) reportTimesByCoach.set("fumbbl:spammer", [...(reportTimesByCoach.get("fumbbl:spammer") ?? []), Date.now()]);
    expect((await submitBugReport({ coach: "Spammer", publicEdition: true, description: "over" }, undefined, deps(d))).status).toBe(429);
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
      { coach: "..\\..\\evil", organizer: false, admin: false },
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

describe("normalizeGameService", () => {
  it("allowlists fumbbl/fork; everything else (incl. absent) is null", () => {
    expect(normalizeGameService("fumbbl")).toBe("fumbbl");
    expect(normalizeGameService("fork")).toBe("fork");
    expect(normalizeGameService("FUMBBL")).toBeNull();
    expect(normalizeGameService(7)).toBeNull();
    expect(normalizeGameService(undefined)).toBeNull();
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
    const second = await submitBugReport({ ...BASE, gameId: "g2", gameService: "fork" }, undefined, deps(d), Date.UTC(2026, 7, 18, 11));
    const rows = listBugReports(d);
    expect(rows.map((r) => r.id)).toEqual([(second.body as { id: string }).id, (first.body as { id: string }).id]);
    expect(rows[1]!.description).toHaveLength(200);
    expect(rows[0]!.gameId).toBe("g2");
    expect(rows[0]!.gameService).toBe("fork");
    expect(rows[1]!.gameService).toBeNull(); // report filed without the field
    const full = getBugReport(d, rows[1]!.id) as { description: string };
    expect(full.description).toHaveLength(300);
  });

  it("refuses a traversal id and unknown ids", () => {
    const d = dir();
    expect(getBugReport(d, "../secrets")).toBeUndefined();
    expect(getBugReport(d, "nope")).toBeUndefined();
  });

  it("updates triage fields with an audit identity and exposes them in the list", async () => {
    const d = dir();
    const submitted = await submitBugReport(BASE, undefined, deps(d), Date.UTC(2026, 7, 18, 10));
    const id = (submitted.body as { id: string }).id;
    const updated = updateBugReportTriage(d, id, {
      status: "in-progress",
      rootCause: "Stale movement metadata",
      reason: "Offer surface was not regenerated",
    }, "OrganizerOne", Date.UTC(2026, 7, 18, 11));
    expect(updated.status).toBe(200);
    expect(listBugReports(d)[0]).toMatchObject({
      kind: "bug",
      triage: {
        status: "in-progress",
        rootCause: "Stale movement metadata",
        reason: "Offer surface was not regenerated",
        updatedBy: "OrganizerOne",
      },
    });
  });

  it("fails closed for invalid triage updates", async () => {
    const d = dir();
    const submitted = await submitBugReport(BASE, undefined, deps(d));
    const id = (submitted.body as { id: string }).id;
    expect(updateBugReportTriage(d, id, { status: "deleted", rootCause: "", reason: "" }, "admin").status).toBe(400);
    expect(updateBugReportTriage(d, "../escape", { status: "new", rootCause: "", reason: "" }, "admin").status).toBe(404);
  });
});

describe("reporter receipts + status lookup (owner 11-04)", () => {
  const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
  const submit = async (d: string, now = Date.UTC(2026, 10, 4, 10)) => {
    const result = await submitBugReport(BASE, undefined, deps(d), now);
    return result.body as { ok: boolean; id: string; receipt: string };
  };

  it("returns a 32-byte base64url receipt only on create and stores only its SHA-256", async () => {
    const d = dir();
    const { id, receipt } = await submit(d);
    expect(receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(receipt, "base64url")).toHaveLength(32);
    const raw = readFileSync(join(d, id, "report.json"), "utf8");
    expect(raw).not.toContain(receipt);
    expect(raw).not.toContain("receiptHash");
    // The hash lives only in the small status record the status check reads.
    const record = JSON.parse(readFileSync(join(d, id, "status.json"), "utf8")) as Record<string, unknown>;
    expect(record.receiptHash).toBe(sha(receipt));
    expect(Object.keys(record).sort()).toEqual(["fixedIn", "receiptHash", "reply", "replyAt", "status", "updatedAt"]);
    expect(JSON.stringify(record)).not.toContain(receipt);
    // Never again: not in the read, the listing, the screenshot read or the PATCH answer.
    const hash = sha(receipt);
    expect(JSON.stringify(getBugReport(d, id))).not.toContain(hash);
    expect(getBugReport(d, id)).not.toHaveProperty("receiptHash");
    expect(JSON.stringify(listBugReports(d))).not.toContain(hash);
    const patched = updateBugReportTriage(d, id, { status: "triaged", rootCause: "", reason: "" }, "admin");
    expect(JSON.stringify(patched.body)).not.toContain(hash);
    expect(JSON.stringify(patched.body)).not.toContain(receipt);
    // The stored hash survives the PATCH (status checks keep working).
    expect((JSON.parse(readFileSync(join(d, id, "status.json"), "utf8")) as { receiptHash: string; status: string }))
      .toMatchObject({ receiptHash: hash, status: "triaged" });
    // Two reports never share a receipt.
    expect((await submit(d)).receipt).not.toBe(receipt);
  });

  it("matches in constant time and never matches a missing or malformed hash", () => {
    const { receipt, receiptHash } = newReceipt();
    expect(receiptMatches(receiptHash, receipt)).toBe(true);
    expect(receiptMatches(receiptHash, newReceipt().receipt)).toBe(false);
    expect(receiptMatches(undefined, receipt)).toBe(false);
    expect(receiptMatches("abc", receipt)).toBe(false);
  });

  it("answers exactly the public fields, mapping the triage states", async () => {
    const d = dir();
    const { id, receipt } = await submit(d);
    const [row] = lookupBugReportStatuses(d, [{ id, receipt }]);
    expect(Object.keys(row!).sort()).toEqual(["fixedIn", "id", "reply", "replyAt", "status", "updatedAt"]);
    expect(row).toEqual({ id, status: "received", reply: null, replyAt: null, fixedIn: null, updatedAt: "2026-11-04T10:00:00.000Z" });
    const expected = { new: "received", triaged: "triaged", "in-progress": "inProgress", resolved: "resolved", closed: "closed" } as const;
    for (const [status, publicStatus] of Object.entries(expected)) {
      updateBugReportTriage(d, id, { status, rootCause: "secret cause", reason: "secret note" }, "admin");
      const [r] = lookupBugReportStatuses(d, [{ id, receipt }]);
      expect(r!.status).toBe(publicStatus);
      expect(JSON.stringify({ ...r, id: "" })).not.toMatch(/secret|Tarkin|Ball vanished/); // the id is the reporter's own
    }
  });

  it("omits wrong receipts, unknown ids, traversal ids and pre-receipt reports silently", async () => {
    const d = dir();
    const { id, receipt } = await submit(d);
    const legacy = await submit(d, Date.UTC(2026, 10, 4, 11));
    // A report filed before receipts existed: no hash on disk -> never answered (no backfill).
    rmSync(join(d, legacy.id, "status.json"));
    // A PATCH on a pre-receipt report never creates a status record.
    updateBugReportTriage(d, legacy.id, { status: "resolved", rootCause: "", reason: "", reply: "Fixed" }, "admin");
    expect(existsSync(join(d, legacy.id, "status.json"))).toBe(false);
    const third = await submit(d, Date.UTC(2026, 10, 4, 12));
    const rows = lookupBugReportStatuses(d, [
      { id: third.id, receipt: newReceipt().receipt }, // wrong receipt
      { id: "2026-01-01T00-00-00-000Z_Nobody_nogame", receipt },
      { id: "../" + id, receipt },
      { id: legacy.id, receipt: legacy.receipt },
      { id: third.id, receipt: third.receipt }, // a repeated id is dropped before any read: first entry wins
      { id, receipt },
      { id, receipt },
    ]);
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(lookupBugReportStatuses(d, [{ id, receipt: receipt.slice(1) }])).toEqual([]);
    expect(lookupBugReportStatuses(d, [{ id: third.id, receipt: third.receipt }]).map((r) => r.id)).toEqual([third.id]);
  });

  it("validates the request shape and caps it at 50 entries", () => {
    const entry = { id: "x", receipt: "y" };
    expect(parseStatusQuery({ reports: Array(STATUS_QUERY_MAX).fill(entry) })).toHaveProperty("entries");
    expect(parseStatusQuery({ reports: Array(STATUS_QUERY_MAX + 1).fill(entry) })).toHaveProperty("error");
    for (const bad of [null, [], "x", {}, { reports: "x" }, { reports: [null] }, { reports: [{ id: 1, receipt: "y" }] }, { reports: [{ id: "x" }] }])
      expect(parseStatusQuery(bad)).toHaveProperty("error");
  });

  it("stores reply and fixedIn through the PATCH; updatedAt moves on public edits only", async () => {
    const d = dir();
    const { id, receipt } = await submit(d);
    const t = (h: number) => Date.UTC(2026, 10, 4, h);
    const status = () => lookupBugReportStatuses(d, [{ id, receipt }])[0]!;
    // Private-only edit (status unchanged, notes added): public updatedAt stays at submit time.
    updateBugReportTriage(d, id, { status: "new", rootCause: "cause", reason: "notes" }, "admin", t(11));
    expect(status().updatedAt).toBe("2026-11-04T10:00:00.000Z");
    // Status change: public.
    updateBugReportTriage(d, id, { status: "triaged", rootCause: "cause", reason: "notes" }, "admin", t(12));
    expect(status().updatedAt).toBe(new Date(t(12)).toISOString());
    // Reply + fixedIn: stored, trimmed, replyAt stamped.
    const saved = updateBugReportTriage(d, id, { status: "triaged", rootCause: "cause", reason: "notes", reply: "  Fixed, thanks!  ", fixedIn: "v1.0.307" }, "admin", t(13));
    expect(saved.status).toBe(200);
    expect(status()).toMatchObject({ reply: "Fixed, thanks!", replyAt: new Date(t(13)).toISOString(), fixedIn: "1.0.307", updatedAt: new Date(t(13)).toISOString() });
    expect(listBugReports(d)[0]!.playerUpdate).toMatchObject({ reply: "Fixed, thanks!", fixedIn: "1.0.307" });
    // Root cause / notes edits again: public fields untouched.
    updateBugReportTriage(d, id, { status: "triaged", rootCause: "new cause", reason: "new notes" }, "admin", t(14));
    expect(status()).toMatchObject({ reply: "Fixed, thanks!", fixedIn: "1.0.307", updatedAt: new Date(t(13)).toISOString() });
    // Same reply re-sent: no change.
    updateBugReportTriage(d, id, { status: "triaged", rootCause: "", reason: "", reply: "Fixed, thanks!", fixedIn: "1.0.307" }, "admin", t(15));
    expect(status().updatedAt).toBe(new Date(t(13)).toISOString());
    // fixedIn alone changes: public.
    updateBugReportTriage(d, id, { status: "triaged", rootCause: "", reason: "", fixedIn: "1.0.308a" }, "admin", t(16));
    expect(status()).toMatchObject({ fixedIn: "1.0.308a", replyAt: new Date(t(13)).toISOString(), updatedAt: new Date(t(16)).toISOString() });
    // Clearing the reply: public, replyAt cleared.
    updateBugReportTriage(d, id, { status: "triaged", rootCause: "", reason: "", reply: "" }, "admin", t(17));
    expect(status()).toMatchObject({ reply: null, replyAt: null, updatedAt: new Date(t(17)).toISOString() });
  });

  it("rejects an over-long reply and a malformed or over-long fixedIn", async () => {
    const d = dir();
    const { id } = await submit(d);
    const base = { status: "triaged", rootCause: "", reason: "" };
    expect(updateBugReportTriage(d, id, { ...base, reply: "x".repeat(REPLY_CAP + 1) }, "admin").status).toBe(400);
    expect(updateBugReportTriage(d, id, { ...base, reply: 5 }, "admin").status).toBe(400);
    for (const fixedIn of ["latest", "1", "1.0.307 beta", "../1.0", "1.0.307" + "a".repeat(FIXED_IN_CAP), 1.0])
      expect(updateBugReportTriage(d, id, { ...base, fixedIn }, "admin").status).toBe(400);
    expect(updateBugReportTriage(d, id, { ...base, reply: "x".repeat(REPLY_CAP), fixedIn: "1.0.307-rc1" }, "admin").status).toBe(200);
  });

  it("deleting or pruning the report removes the hash with it", async () => {
    const d = dir();
    const { id, receipt } = await submit(d, Date.UTC(2025, 0, 1));
    expect(pruneBugReports(d, Date.UTC(2026, 10, 4))).toEqual([id]);
    expect(existsSync(join(d, id))).toBe(false);
    expect(lookupBugReportStatuses(d, [{ id, receipt }])).toEqual([]);
  });
});

describe("status check vs the session middleware (Sol P2)", () => {
  it("is exempt from the cookie CSRF header and the onboarding 428 gate (it ignores any session)", async () => {
    const { isStateChangingApiRequest } = await import("../src/auth/csrf.js");
    const { onboardingGateApplies } = await import("../src/auth/onboarding.js");
    expect(isStateChangingApiRequest("POST", "/api/bug-reports/status")).toBe(false);
    expect(onboardingGateApplies("POST", "/api/bug-reports/status")).toBe(false);
    // The submit route keeps both.
    expect(isStateChangingApiRequest("POST", "/api/bug-reports")).toBe(true);
    expect(onboardingGateApplies("POST", "/api/bug-reports")).toBe(true);
  });
});

describe("status check reads only the small status record (Sol P2, 11-04)", () => {
  const submit = async (d: string, extra: Record<string, unknown> = {}) =>
    (await submitBugReport({ ...BASE, ...extra }, undefined, deps(d), Date.UTC(2026, 10, 4, 10))) as { status: number; body: { id: string; receipt: string; error?: string } };

  it("refuses over-long or non-string clientVersion / gameId with 400 at submit", async () => {
    const d = dir();
    const long = "x".repeat(METADATA_FIELD_CAP + 1);
    expect((await submit(d, { clientVersion: long })).status).toBe(400);
    expect((await submit(d, { gameId: long })).status).toBe(400);
    expect((await submit(d, { clientVersion: 5 })).status).toBe(400);
    expect((await submit(d, { gameId: { a: 1 } })).status).toBe(400);
    expect((await submit(d, { gameService: ["fork"] })).status).toBe(400);
    expect((await submit(d, { publicEdition: true, coach: "y".repeat(5000), clientVersion: "1.0.307", gameId: "x".repeat(METADATA_FIELD_CAP) })).status).toBe(200);
    expect(readdirSync(d)).toHaveLength(1);
  });

  it("answers from status.json even when report.json is unreadable, and skips a status record over the cap", async () => {
    const d = dir();
    const { body: { id, receipt } } = await submit(d);
    writeFileSync(join(d, id, "report.json"), "{ not json", "utf8");
    expect(lookupBugReportStatuses(d, [{ id, receipt }]).map((r) => r.id)).toEqual([id]);
    const file = join(d, id, "status.json");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...record, reply: "z".repeat(STATUS_RECORD_CAP) }), "utf8");
    expect(lookupBugReportStatuses(d, [{ id, receipt }])).toEqual([]);
    writeFileSync(file, JSON.stringify({ ...record, status: "new" }), "utf8"); // unknown public status: refused
    expect(lookupBugReportStatuses(d, [{ id, receipt }])).toEqual([]);
  });

  it("de-duplicates ids case-insensitively before any read", async () => {
    const d = dir();
    const { body: { id, receipt } } = await submit(d);
    const rows = lookupBugReportStatuses(d, [{ id: id.toUpperCase(), receipt: newReceipt().receipt }, { id, receipt }]);
    expect(rows).toEqual([]); // the first spelling took the slot
    expect(lookupBugReportStatuses(d, [{ id, receipt }, { id: id.toLowerCase(), receipt }]).map((r) => r.id)).toEqual([id]);
  });

  it("the CSRF and onboarding exemptions cover only POST /api/bug-reports/status", async () => {
    const { isStateChangingApiRequest } = await import("../src/auth/csrf.js");
    const { onboardingGateApplies } = await import("../src/auth/onboarding.js");
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(isStateChangingApiRequest(method, "/api/bug-reports/status")).toBe(true);
      expect(onboardingGateApplies(method, "/api/bug-reports/status")).toBe(true);
    }
    expect(isStateChangingApiRequest("post", "/api/bug-reports/status")).toBe(false);
    expect(onboardingGateApplies("post", "/api/bug-reports/status")).toBe(false);
  });
});
