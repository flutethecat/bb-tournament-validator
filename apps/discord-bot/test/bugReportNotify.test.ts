import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Client } from "discord.js";
import {
  BugReportNotifyState,
  buildTriageModal,
  createConfigWebClient,
  parseBugReportRows,
  parseTriageCustomId,
  pollBugReports,
  renderBugReportEmbed,
  renderTriageButtons,
  selectNewReports,
  shortToken,
  triageButtonId,
  type BugReportRow,
} from "../src/bugReportNotify";

const dir = () => mkdtempSync(join(tmpdir(), "bbtv-bug-"));

const row = (over: Partial<BugReportRow> = {}): BugReportRow => ({
  id: "2026-09-08T03-00-00-000Z_Flutethecat_fumbbl-1940051",
  coach: "Flutethecat",
  gameId: "1940051",
  gameService: "fumbbl",
  clientVersion: "0.3.20-o66iy",
  description: "Trail numbers survive a touchdown.",
  submittedAt: "2026-09-08T03:00:00.000Z",
  kind: "bug",
  triage: { status: "new", rootCause: "", reason: "", updatedAt: null, updatedBy: null },
  ...over,
});

describe("parseBugReportRows", () => {
  it("normalises config-web's listing and skips malformed rows", () => {
    const rows = parseBugReportRows({
      reports: [
        { id: "2026-09-08T03-00-00-000Z_a_nogame", coach: "a", description: "x", triage: { status: "bogus" } },
        { id: "../etc/passwd", coach: "evil" },
        "not-an-object",
        { id: "2026-09-08T03-01-00-000Z_b_fork-12", coach: "b", kind: "feedback", gameService: "fork", gameId: "12", triage: { status: "resolved", updatedBy: "admin" } },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["2026-09-08T03-00-00-000Z_a_nogame", "2026-09-08T03-01-00-000Z_b_fork-12"]);
    expect(rows[0]!.triage.status).toBe("new"); // unknown status degrades to new, never a trusted-looking string
    expect(rows[0]!.kind).toBe("bug");
    expect(rows[1]!.kind).toBe("feedback");
    expect(rows[1]!.triage).toMatchObject({ status: "resolved", updatedBy: "admin" });
    expect(parseBugReportRows(null)).toEqual([]);
    expect(parseBugReportRows({ reports: "nope" })).toEqual([]);
  });
});

describe("BugReportNotifyState", () => {
  it("seeds, marks, and resolves short tokens atomically", () => {
    const state = new BugReportNotifyState(join(dir(), "notify.json"));
    expect(state.isEmpty()).toBe(true);
    state.mark([]);
    expect(state.isEmpty()).toBe(false); // an empty seed is still a seed — history is never replayed
    const r = row();
    expect(state.hasSeen(r.id)).toBe(false);
    state.mark([r.id]);
    expect(state.hasSeen(r.id)).toBe(true);
    expect(state.resolveToken(shortToken(r.id))).toBe(r.id);
    expect(selectNewReports([r, row({ id: "2026-09-08T04-00-00-000Z_z_nogame" }), row({ id: "2026-09-08T03-30-00-000Z_m_nogame" })], state).map((x) => x.id))
      .toEqual(["2026-09-08T03-30-00-000Z_m_nogame", "2026-09-08T04-00-00-000Z_z_nogame"]); // oldest first
  });
});

describe("triage customIds", () => {
  it("round-trips and stays under Discord's 100-char cap even for the longest report id", () => {
    const longId = `2026-09-08T03-00-00-000Z_${"c".repeat(40)}_${"g".repeat(40)}`;
    const token = shortToken(longId);
    const id = triageButtonId("in-progress", token);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseTriageCustomId(id)).toEqual({ kind: "button", status: "in-progress", token });
    expect(parseTriageCustomId(`bugtriage-modal:closed:${token}`)).toEqual({ kind: "modal", status: "closed", token });
    expect(parseTriageCustomId("resub:yes:abc")).toBeUndefined();
    expect(parseTriageCustomId("bugtriage:bogus:deadbeef")).toBeUndefined();
    expect(parseTriageCustomId("bugtriage:closed:not-hex")).toBeUndefined();
  });
});

describe("rendering", () => {
  it("renders the card with the admin deep link, attachment inventory, and one button per triage status", () => {
    const r = { ...row(), files: { wireLog: "wire.log", appLog: null, screenshot: "screenshot.png" } };
    const embed = renderBugReportEmbed(r, "https://superfumbbltest.duckdns.org:4310/").toJSON();
    expect(embed.title).toBe("🐛 Bug report from Flutethecat");
    expect(embed.url).toBe("https://superfumbbltest.duckdns.org:4310/admin.html#reports");
    expect(embed.fields?.map((f) => f.value)).toEqual(["fumbbl #1940051", "0.3.20-o66iy", "wire log, screenshot", "**New**"]);
    expect(embed.footer?.text).toContain(r.id);

    const rows = renderTriageButtons(r.id, "https://x.test", "new").map((a) => a.toJSON());
    const labels = rows[0]!.components.map((c) => (c as { label?: string }).label);
    expect(labels).toEqual(["Triaged", "In progress", "Resolved", "Closed"]);
    expect((rows[1]!.components[0] as { url?: string }).url).toBe("https://x.test/admin.html#reports");

    const modal = buildTriageModal("resolved", shortToken(r.id), { ...r.triage, rootCause: "stale dialog" }).toJSON();
    expect(modal.title).toBe("Mark as Resolved");
    expect(modal.custom_id).toBe(`bugtriage-modal:resolved:${shortToken(r.id)}`);
  });
});

describe("config-web client + poll", () => {
  it("signs in as the service coach, re-logs in on a 401, seeds silently, then DMs each new report once", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let listing: unknown = { reports: [row()] };
    let logins = 0;
    let liveToken = "tok-1";
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/fork/login")) {
        logins += 1;
        const body = JSON.parse(String(init?.body)) as { coach: string; passwordMd5: string };
        expect(body).toEqual({ coach: "BBBot", passwordMd5: "5ebe2294ecd0e0f08eab7690d2a6ee69" }); // md5("secret")
        return new Response(JSON.stringify({ ok: true, token: liveToken }), { status: 200 });
      }
      const auth = (init?.headers as Record<string, string>).authorization;
      if (auth !== `Bearer ${liveToken}`) return new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 });
      if (String(url).endsWith("/api/bug-reports")) return new Response(JSON.stringify(listing), { status: 200 });
      if (init?.method === "PATCH") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      const id = decodeURIComponent(String(url).split("/api/bug-reports/")[1]!);
      const found = (listing as { reports: BugReportRow[] }).reports.find((r) => r.id === id);
      return found
        ? new Response(JSON.stringify({ ...found, files: { wireLog: "wire.log" } }), { status: 200 })
        : new Response(JSON.stringify({ error: "nope" }), { status: 404 });
    }) as unknown as typeof fetch;
    const api = createConfigWebClient({ baseUrl: "http://127.0.0.1:4310/", coach: "BBBot", password: "secret", fetchImpl });

    const sent: unknown[] = [];
    const client = {
      users: { fetch: async () => ({ tag: "Jay#0001", send: async (p: unknown) => { sent.push(p); } }) },
    } as unknown as Client;
    const state = new BugReportNotifyState(join(dir(), "notify.json"));
    const ctx = { client, api, state, publicUrl: "https://x.test", notifyUserId: "42" };

    expect(await pollBugReports(ctx)).toContain("seeded with 1");
    expect(sent).toHaveLength(0);
    expect(logins).toBe(1);
    liveToken = "tok-2"; // session evicted server-side -> the next call 401s -> one re-login, then success

    const fresh = row({ id: "2026-09-08T05-00-00-000Z_Kildash_nogame", coach: "Kildash", gameId: null, gameService: null });
    listing = { reports: [fresh, row()] };
    const note = await pollBugReports(ctx);
    expect(logins).toBe(2);
    expect(note).toContain("DM → Jay#0001");
    expect(sent).toHaveLength(1);
    const payload = sent[0] as { embeds: { toJSON(): { title: string } }[] };
    expect(payload.embeds[0]!.toJSON().title).toBe("🐛 Bug report from Kildash");
    expect(await pollBugReports(ctx)).toBe(""); // already seen — no repeat
    expect(sent).toHaveLength(1);

    const patched = await api.patchTriage(fresh.id, { status: "triaged", rootCause: "x", reason: "y" });
    expect(patched).toEqual({ ok: true });
    const patchCall = calls.find((c) => c.init?.method === "PATCH")!;
    expect(patchCall.url).toBe(`http://127.0.0.1:4310/api/bug-reports/${encodeURIComponent(fresh.id)}`);
    expect(JSON.parse(String(patchCall.init?.body))).toEqual({ status: "triaged", rootCause: "x", reason: "y" });
    expect(await api.getReport("../nope")).toBeUndefined();
  });
});
