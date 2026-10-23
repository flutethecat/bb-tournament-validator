import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// An acknowledged write must be reported as done even if the connection's cleanup (end()) stalls: the deadline
// covers connect + query; cleanup is bounded separately and only tears the transport down.
const destroy = vi.fn();
vi.mock("mysql2/promise", () => ({
  default: {
    createConnection: vi.fn(async () => ({
      execute: async () => [{ affectedRows: 1 }],
      end: () => new Promise(() => {}), // never acknowledges the close
      destroy,
    })),
  },
}));

const previous = process.env.FORK_DB_TIMEOUT_MS;
beforeAll(() => { process.env.FORK_DB_TIMEOUT_MS = "100"; });
afterAll(() => { if (previous === undefined) delete process.env.FORK_DB_TIMEOUT_MS; else process.env.FORK_DB_TIMEOUT_MS = previous; });

describe("fork DB cleanup is bounded separately from the query", () => {
  it("a stalled end() after an acknowledged insert still returns the insert's result, and destroys the transport", async () => {
    const { createForkAccountDigestIfAvailable } = await import("../src/index.js");
    const started = Date.now();
    await expect(createForkAccountDigestIfAvailable({ dbHost: "h", dbPort: 1, dbUser: "u", dbPassword: "p", dbName: "d" }, "NewCoach", "a".repeat(32))).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(destroy).toHaveBeenCalled();
  });
});
