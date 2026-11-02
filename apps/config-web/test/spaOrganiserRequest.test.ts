// SPA side of organiser requests (spa/src/account/organiserRequest.ts): the request page and admin queue stores against a
// fake fetcher. They only show what the server sent; the client checks save a round trip.
import { describe, expect, it } from "vitest";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createOrganiserQueue, createOrganiserRequest, safeHref } from "../spa/src/account/organiserRequest";

type Call = { path: string; method: string; body?: unknown };
function fake(handler: (c: Call) => unknown): { api: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const api = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const c = { path, method: init.method ?? "GET", body: init.body };
    calls.push(c);
    const out = handler(c);
    if (out instanceof Error) throw out;
    return out;
  }) as Fetcher;
  return { api, calls };
}
const row = (over: Record<string, unknown> = {}) => ({ id: "or000000000001", coach: "Ann", run: "league", competition: "", region: "", note: "n", links: [], status: "pending", createdAt: "2026-11-02T00:00:00Z", ...over });

describe("request page store", () => {
  it("loads, checks the form locally, sends only trimmed links, and withdraws", async () => {
    const { api, calls } = fake((c) => c.method === "GET" ? { organizer: false, request: null } : c.method === "POST" ? { request: row() } : { request: row({ status: "withdrawn" }) });
    const page = createOrganiserRequest({ api });
    await page.load();
    expect(page.state).toMatchObject({ loaded: true, organizer: false, request: null });
    expect(await page.submit()).toBe(false);
    expect(page.state.formError).toBe("Choose what you want to run.");
    page.state.form.run = "league";
    expect(await page.submit()).toBe(false);
    expect(page.state.formError).toMatch(/a little about/);
    page.state.form.note = "Club league";
    page.state.form.links = ["ftp://x", "", ""];
    expect(await page.submit()).toBe(false);
    expect(page.state.formError).toMatch(/not a link/);
    page.state.form.links = [" https://example.test/a ", "", ""];
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(await page.submit()).toBe(true);
    expect(calls.at(-1)).toEqual({ path: "/api/me/organiser-request", method: "POST", body: { run: "league", competition: "", region: "", note: "Club league", links: ["https://example.test/a"] } });
    expect(page.state.request?.status).toBe("pending");
    expect(page.state.form.note).toBe("");
    expect(await page.withdraw()).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
    expect(page.state.request?.status).toBe("withdrawn");
  });

  it("shows the server's refusal; a 401 asks the shell to re-read the session", async () => {
    let signedOut = 0;
    const page = createOrganiserRequest({ api: fake(() => new ApiError(409, "You already have a request waiting.")).api, onSignedOut: () => { signedOut++; } });
    Object.assign(page.state.form, { run: "both", note: "x" });
    expect(await page.submit()).toBe(false);
    expect(page.state.formError).toBe("You already have a request waiting.");
    const gone = createOrganiserRequest({ api: fake(() => new ApiError(401, "Authentication required.")).api, onSignedOut: () => { signedOut++; } });
    await gone.load();
    expect(signedOut).toBe(1);
    expect(gone.state.error).toBe("");
  });

  it("renders only http(s) links as links", () => {
    expect(safeHref("https://example.test/")).toBe("https://example.test/");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
  });
});

describe("admin queue store", () => {
  it("loads a view, decides with the reason, and reloads", async () => {
    const { api, calls } = fake((c) => c.method === "GET" ? { requests: [row()], pending: 1 } : { ok: true });
    const q = createOrganiserQueue({ api });
    await q.load("pending");
    expect(calls[0]!.path).toBe("/api/admin/organiser-requests?status=pending");
    expect(q.state).toMatchObject({ pending: 1, loaded: true });
    q.state.reason[row().id] = "  Welcome.  ";
    expect(await q.decide(q.state.requests[0]!, "approve")).toBe(true);
    expect(calls[1]).toEqual({ path: "/api/admin/organiser-requests/or000000000001/approve", method: "POST", body: { reason: "Welcome." } });
    expect(q.state.notice).toBe("Ann is now an organiser.");
    expect(calls[2]!.method).toBe("GET");
    q.state.reason[row().id] = "r".repeat(301);
    expect(await q.decide(q.state.requests[0]!, "decline")).toBe(false);
    expect(q.state.rowError[row().id]).toMatch(/at most 300/);
  });
});
