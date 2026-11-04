import { describe, expect, it } from "vitest";
import { ApiError } from "../spa/src/shared/api";
import { boardStatusOf, boardTabShows, createBoard, ensureBoardStatus, LOG_ACTION_LABEL, MUTE_CHOICES } from "../spa/src/shared/board";
import { notificationIcon } from "../spa/src/home/notifications";
import { createBoard as clubCreateBoard } from "../spa/src/clubs/clubs";

// The SPA side of league / tournament boards (owner 11-04): the board controller's moderation calls hit the routes the
// server serves, the Board tab shows only for readers of a board that is on (and always for its moderators), one status
// read is shared per board and viewer, and the club board keeps its controller.

type Call = { path: string; method?: string; body?: unknown };
function fakeApi(answer: (c: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const api = (async (path: string, init?: { method?: string; body?: unknown }) => {
    const c = { path, ...(init?.method ? { method: init.method } : {}), ...(init?.body !== undefined ? { body: init.body } : {}) };
    calls.push(c);
    const r = answer(c);
    if (r instanceof Error) throw r;
    return r;
  }) as never;
  return { api, calls };
}

describe("board controller", () => {
  it("moderation, reports, mutes and settings call the board routes", async () => {
    const { api, calls } = fakeApi((c) => (c.path.endsWith("/reports") ? { reports: [] } : c.path.endsWith("/mutes") && !c.method ? { mutes: [] } : c.path.endsWith("/log") ? { log: [] } : { board: { threads: [], canPost: true, canModerate: true, settings: { enabled: true, publicRead: false, revision: 3 } } }));
    const b = createBoard({ api, base: () => "/api/leagues/lg1" });
    await b.load();
    await b.mark("p1", "hide", true, "Rude");
    await b.mark("p2", "pin", false);
    await b.mark("p2", "lock", true);
    await b.report("p3", "Spam");
    await b.remove("p4", "Off topic");
    await b.mute("Lad", "custom", "2027-01-01T00:00:00.000Z", "");
    await b.unmute("Lad");
    await b.saveSettings({ publicRead: true });
    await b.resolve("r1", "dismissed");
    const writes = calls.filter((c) => c.method).map((c) => [c.method, c.path, c.body]);
    expect(writes).toEqual([
      ["POST", "/api/leagues/lg1/board/seen", {}],
      ["POST", "/api/leagues/lg1/board/p1/hide", { hidden: true, reason: "Rude" }],
      ["POST", "/api/leagues/lg1/board/p2/pin", { pinned: false }],
      ["POST", "/api/leagues/lg1/board/p2/lock", { locked: true }],
      ["POST", "/api/leagues/lg1/board/p3/report", { reason: "Spam" }],
      ["DELETE", "/api/leagues/lg1/board/p4", { reason: "Off topic" }],
      ["POST", "/api/leagues/lg1/board/mutes", { coach: "Lad", duration: "custom", until: "2027-01-01T00:00:00.000Z" }],
      ["DELETE", "/api/leagues/lg1/board/mutes/Lad", undefined],
      ["PATCH", "/api/leagues/lg1/board/settings", { revision: 3, publicRead: true }],
      ["POST", "/api/leagues/lg1/board/reports/r1/resolve", { outcome: "dismissed" }],
    ]);
    expect(b.state.reports).toEqual([]);
  });

  it("a switched-off board reads as board-off; a members-only one keeps its status code", async () => {
    const off = createBoard({ api: fakeApi(() => new ApiError(403, "The board is switched off.", { code: "board-off" })).api, base: () => "/api/tournaments/t1" });
    await off.load();
    expect(off.state.code).toBe("board-off");
    const locked = createBoard({ api: fakeApi(() => new ApiError(403, "Members only", { code: "members-only" })).api, base: () => "/api/tournaments/t1" });
    await locked.load();
    expect(locked.state.code).toBe("403");
  });

  it("the club board keeps the same controller", () => {
    expect(clubCreateBoard).toBe(createBoard);
  });
});

describe("the Board tab", () => {
  it("shows for readers of a board that is on and always for moderators; hidden when off, unknown or failed", () => {
    expect(boardTabShows({ enabled: true, publicRead: false, canRead: true, canModerate: false })).toBe(true);
    expect(boardTabShows({ enabled: false, publicRead: false, canRead: false, canModerate: false })).toBe(false);
    expect(boardTabShows({ enabled: true, publicRead: false, canRead: false, canModerate: false })).toBe(false);
    expect(boardTabShows({ enabled: false, publicRead: false, canRead: true, canModerate: true })).toBe(true);
    expect(boardTabShows(null)).toBe(false);
    expect(boardTabShows(undefined)).toBe(false);
  });

  it("one status read per board and viewer (header and page share it); a failure reads as hidden", async () => {
    const { api, calls } = fakeApi(() => ({ enabled: true, publicRead: false, canRead: true, canModerate: false }));
    await Promise.all([ensureBoardStatus(api, "/api/leagues/x1", "Mia"), ensureBoardStatus(api, "/api/leagues/x1", "mia")]);
    expect(calls.map((c) => c.path)).toEqual(["/api/leagues/x1/board/status"]);
    expect(boardStatusOf("/api/leagues/x1", "Mia")?.canRead).toBe(true);
    await ensureBoardStatus(api, "/api/leagues/x1", "Other");
    expect(calls).toHaveLength(2);
    const failing = fakeApi(() => new ApiError(404, "League not found."));
    await ensureBoardStatus(failing.api, "/api/leagues/gone", "");
    expect(boardStatusOf("/api/leagues/gone", "")).toBeNull();
  });

  it("labels: mute choices, log actions and the report notification icon", () => {
    expect(MUTE_CHOICES.map((c) => c.value)).toEqual(["1h", "24h", "7d", "custom"]);
    expect(LOG_ACTION_LABEL.mute).toBe("Muted a coach");
    expect(notificationIcon("board-report")).toBe("/icons/panel/messages.png");
  });
});
