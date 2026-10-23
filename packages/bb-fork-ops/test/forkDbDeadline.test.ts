import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { forkCoachPasswordDigest, withDeadline } from "@bb/fork-ops";

// A fork DB that accepts the TCP connection and then says nothing: every DB operation must end at its deadline and
// destroy the connection, so no caller (or lock a caller holds) waits on it indefinitely.
let server: Server;
let port = 0;
const sockets: Socket[] = [];
const previous = process.env.FORK_DB_TIMEOUT_MS;
let handshakeByte = false;

beforeAll(async () => {
  process.env.FORK_DB_TIMEOUT_MS = "150";
  server = createServer((s) => {
    sockets.push(s);
    s.on("error", () => {});
    if (handshakeByte) s.write(Buffer.from([0x4a])); // one byte of a handshake, then silence
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  if (previous === undefined) delete process.env.FORK_DB_TIMEOUT_MS; else process.env.FORK_DB_TIMEOUT_MS = previous;
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("fork DB operations are bounded", () => {
  it("a silent server rejects within the deadline and the connection is torn down", async () => {
    const started = Date.now();
    await expect(
      forkCoachPasswordDigest({ dbHost: "127.0.0.1", dbPort: port, dbUser: "u", dbPassword: "p", dbName: "d" }, "Alice"),
    ).rejects.toThrow(/timed out|ETIMEDOUT|timeout/i);
    expect(Date.now() - started).toBeLessThan(2_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(sockets.length).toBeGreaterThan(0);
    expect(sockets.every((s) => s.destroyed || s.readableEnded)).toBe(true);
  });

  it("a handshake that starts and then stalls is still ended at the deadline, transport destroyed", async () => {
    handshakeByte = true;
    const before = sockets.length;
    const started = Date.now();
    await expect(
      forkCoachPasswordDigest({ dbHost: "127.0.0.1", dbPort: port, dbUser: "u", dbPassword: "p", dbName: "d" }, "Alice"),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    await new Promise((r) => setTimeout(r, 50));
    const mine = sockets.slice(before);
    expect(mine.length).toBe(1);
    expect(mine[0]!.destroyed || mine[0]!.readableEnded).toBe(true);
    handshakeByte = false;
  });

  it("withDeadline runs the timeout hook and rejects", async () => {
    let hooked = false;
    await expect(withDeadline(new Promise(() => {}), 20, () => { hooked = true; }, "op")).rejects.toThrow(/op timed out after 20ms/);
    expect(hooked).toBe(true);
  });
});
