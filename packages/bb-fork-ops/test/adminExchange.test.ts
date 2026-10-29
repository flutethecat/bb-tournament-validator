import { afterEach, describe, expect, it, vi } from "vitest";
import { adminExchange, adminList, adminListLive, gamestateResult } from "@bb/fork-ops";

// The admin and gamestate servlets keep one last challenge each: a second caller fetching a challenge before the
// first caller's command went out invalidates it. Every challenge/command pair in the transport runs on one queue per
// fork base URL, so concurrent callers never interleave.

const cfg = { baseUrl: "http://127.0.0.1:22227", passwordMd5Hex: "098f6bcd4621d373cade4e832627b4f6" };
const result = `<gameResult replayId="9" halves="2"><teamResult teamId="a"><score>1</score></teamResult><teamResult teamId="b"><score>0</score></teamResult></gameResult>`;

afterEach(() => vi.unstubAllGlobals());

function stubFork() {
  const seen: string[] = [];
  let outstanding = 0; // challenges handed out whose command has not arrived yet
  let maxOutstanding = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    seen.push(path);
    await new Promise((r) => setTimeout(r, 3));
    if (path.endsWith("/challenge")) {
      outstanding += 1;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      return new Response("<x><challenge>3c67e0dacb39754d058e398f9911ab71</challenge></x>");
    }
    outstanding -= 1;
    if (path === "/gamestate/result") return new Response(result);
    return new Response('<admin><list size="0"/><status>ok</status></admin>');
  }));
  return { seen, max: () => maxOutstanding };
}

describe("admin transport: one challenge/command exchange at a time per fork", () => {
  it("concurrent callers (lists, a live poll, a result pull) never interleave challenge and command", async () => {
    const fork = stubFork();
    await Promise.all([adminList(cfg, "active"), adminListLive(cfg), gamestateResult(cfg, "9"), adminList(cfg, "finished")]);
    expect(fork.max()).toBe(1);
    for (let i = 0; i < fork.seen.length; i += 2) {
      expect(fork.seen[i]!.endsWith("/challenge"), fork.seen.join(" ")).toBe(true);
      expect(fork.seen[i + 1]!.endsWith("/challenge")).toBe(false);
    }
    expect(fork.seen.filter((p) => p.endsWith("/challenge"))).toHaveLength(7);
  });

  it("a failed exchange does not block the queue; other forks are not queued behind this one", async () => {
    stubFork();
    await expect(adminExchange(cfg, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(adminList(cfg, "active")).resolves.toContain("<status>ok</status>");
    let otherRan = false;
    const slow = adminExchange(cfg, () => new Promise((r) => setTimeout(r, 30)));
    await adminExchange({ baseUrl: "http://other.test" }, async () => { otherRan = true; });
    expect(otherRan).toBe(true);
    await slow;
  });
});
