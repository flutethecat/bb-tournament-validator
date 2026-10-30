import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compressToUTF16, decompressFromUTF16 } from "../src/replay/lzString";
import { challengeResponse, decodeFrame, readReplay, replayOptionsFromEnv, ReplayReadError, type ReplaySocket } from "../src/replay/reader";

// The fork replay reader's wire (src/replay/reader.ts) against a scripted fake socket: frames in the fork's LZ-String
// UTF-16 encoding, the anonymous and the REPLAY-join handshakes, the unavailable answer, the deadlines and budgets.

describe("LZ-String UTF-16 codec (the fork's server.command.compression)", () => {
  it("matches lz-string 1.5.0 byte for byte and round-trips", () => {
    // lz-string 1.5.0 compressToUTF16 output (the fumbbl40k client's dependency), captured 10-30
    const version = "ᯡ࠽䅬̀愧堶悢ೠড኉|း怭䁫ҁ ℠䜡⸰ڒ䀺䈠丯஬ࠢ粠 ";
    expect(compressToUTF16('{"netCommandId":"clientRequestVersion"}')).toBe(version);
    expect(decompressFromUTF16(version)).toBe('{"netCommandId":"clientRequestVersion"}');
    for (const s of ["x", "héllo ✓ 😀 ‘quoted’", "abab".repeat(500), JSON.stringify({ a: [1, 2, 3], b: "Grashnak Blackhoof" })]) {
      expect(decompressFromUTF16(compressToUTF16(s))).toBe(s);
    }
    expect(decompressFromUTF16("")).toBeNull();
  });

  it("decodeFrame reads plain JSON, compressed text and binary frames; refuses junk", () => {
    const cmd = { netCommandId: "serverStatus", serverStatus: "Replay Unavailable" };
    expect(decodeFrame(JSON.stringify(cmd))).toEqual(cmd);
    expect(decodeFrame(compressToUTF16(JSON.stringify(cmd)))).toEqual(cmd);
    expect(decodeFrame(new TextEncoder().encode(compressToUTF16(JSON.stringify(cmd))).buffer)).toEqual(cmd);
    expect(() => decodeFrame(42)).toThrow(ReplayReadError);
    expect(() => decodeFrame("[1,2]")).toThrow();
  });
});

describe("password challenge response (upstream PasswordChallenge.createResponse)", () => {
  it("no challenge (the standalone fork): the md5 digest itself; a challenge: HMAC-MD5 keyed on md5(password)", () => {
    const md5 = createHash("md5").update("secret").digest("hex");
    expect(challengeResponse(null, md5)).toBe(md5);
    expect(challengeResponse("", md5)).toBe(md5);
    // upstream XORs the 16-byte digest itself (no HMAC block padding): pinned to the fumbbl40k client's
    // createChallengeResponse("0011223344556677", md5("secret")), computed 10-30
    expect(challengeResponse("0011223344556677", md5)).toBe("9b0c756c57c01060f5bdae53b6681610");
  });
});

/** A scripted fork: answers each client command with the frames `script` returns (compressed like the fork). */
class FakeFork implements ReplaySocket {
  binaryType = "";
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  private listeners = new Map<string, Array<(e: { data?: unknown }) => void>>();
  constructor(private readonly script: (cmd: Record<string, unknown>) => unknown[], opts: { open?: boolean } = {}) {
    if (opts.open !== false) queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(type: string, l: (e: { data?: unknown }) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]); }
  emit(type: string, e: { data?: unknown }): void { for (const l of this.listeners.get(type) ?? []) l(e); }
  send(data: string | Uint8Array): void {
    const cmd = decodeFrame(typeof data === "string" ? data : new TextDecoder().decode(data));
    this.sent.push(cmd);
    for (const out of this.script(cmd)) queueMicrotask(() => this.emit("message", { data: new TextEncoder().encode(compressToUTF16(JSON.stringify(out))).buffer }));
  }
  close(): void { if (!this.closed) { this.closed = true; queueMicrotask(() => this.emit("close", {})); } }
}

const game = { gameId: 7, teamHome: { teamId: "H", teamName: "Reavers", playerArray: [{ playerId: "h1", playerName: "Grak" }] }, teamAway: { teamId: "A", teamName: "Grinders", playerArray: [] } };
const td = (commandNr: number) => ({
  netCommandId: "serverModelSync", commandNr,
  modelChangeList: { modelChangeArray: [{ modelChangeId: "gameSetHalf", modelChangeValue: 1 }, { modelChangeId: "gameSetHomePlaying", modelChangeValue: true }, { modelChangeId: "turnDataSetTurnNr", modelChangeKey: "home", modelChangeValue: 2 }, { modelChangeId: "playerResultSetTouchdowns", modelChangeKey: "h1", modelChangeValue: commandNr }] },
  reportList: { reports: [] },
});
const replayScript = (cmd: Record<string, unknown>): unknown[] => {
  if (cmd.netCommandId === "clientRequestVersion") return [{ netCommandId: "serverVersion", serverVersion: "3.4.0", clientPropertyNames: [] }];
  if (cmd.netCommandId === "clientReplay") {
    return [
      { netCommandId: "serverGameState", game },
      { netCommandId: "serverReplay", commandArray: [td(1)], totalNrOfCommands: 2, lastCommand: false },
      { netCommandId: "serverReplay", commandArray: [td(2)], totalNrOfCommands: 2, lastCommand: true },
    ];
  }
  return [];
};

describe("readReplay", () => {
  it("anonymous: version, clientReplay for the game, batches until lastCommand, moments derived, socket closed", async () => {
    let fork: FakeFork | undefined;
    const taps: unknown[] = [];
    const r = await readReplay("7", { url: "ws://fork/command", socket: () => (fork = new FakeFork(replayScript)), tap: (c) => taps.push(c) });
    expect(fork!.sent.map((c) => c.netCommandId)).toEqual(["clientRequestVersion", "clientReplay"]);
    expect(fork!.sent[1]).toEqual({ netCommandId: "clientReplay", gameId: 7, replayToCommandNr: 0, coach: null });
    expect(fork!.closed).toBe(true);
    expect(taps).toHaveLength(2);
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.derivation.moments.map((m) => `${m.half}/${m.turn} ${m.text}`)).toEqual(["1/2 Touchdown: Grak", "1/2 Touchdown: Grak"]);
  });

  it("REPLAY join when a coach is configured: challenge -> clientJoin replay -> user settings -> clientReplay; the digest never leaves as clear text", async () => {
    const md5 = createHash("md5").update("pw").digest("hex");
    let fork: FakeFork | undefined;
    const script = (cmd: Record<string, unknown>): unknown[] => {
      if (cmd.netCommandId === "clientPasswordChallenge") return [{ netCommandId: "serverPasswordChallenge", challenge: null }];
      if (cmd.netCommandId === "clientJoin") return [{ netCommandId: "serverUserSettings" }];
      return replayScript(cmd);
    };
    const r = await readReplay("7", { url: "ws://fork/command", coach: "ReplayBot", passwordMd5: md5, socket: () => (fork = new FakeFork(script)) });
    expect(r.status).toBe("ready");
    expect(fork!.sent.map((c) => c.netCommandId)).toEqual(["clientRequestVersion", "clientPasswordChallenge", "clientJoin", "clientReplay"]);
    expect(fork!.sent[2]).toMatchObject({ clientMode: "replay", coach: "ReplayBot", password: md5, gameId: 7 });
    expect(JSON.stringify(fork!.sent)).not.toContain('"pw"');
  });

  it("the fork's Replay Unavailable / Unknown Game Id answer is 'unavailable'; other statuses and a bad id are not", async () => {
    const status = (s: string) => (cmd: Record<string, unknown>) => (cmd.netCommandId === "clientReplay" ? [{ netCommandId: "serverStatus", serverStatus: s }] : replayScript(cmd));
    expect(await readReplay("1072", { url: "x", socket: () => new FakeFork(status("Replay Unavailable")) })).toEqual({ status: "unavailable", reason: "Replay Unavailable" });
    expect(await readReplay("5", { url: "x", socket: () => new FakeFork(status("Unknown Game Id")) })).toEqual({ status: "unavailable", reason: "Unknown Game Id" });
    await expect(readReplay("5", { url: "x", socket: () => new FakeFork(status("Wrong Password")) })).rejects.toThrow(ReplayReadError);
    expect(await readReplay("abc", { url: "x", socket: () => { throw new Error("never opened"); } })).toEqual({ status: "unavailable", reason: "not a fork game id" });
  });

  it("transient failures reject (never cached): silence past the idle deadline, a socket closed mid-replay, a frame over budget, the wrong game", async () => {
    await expect(readReplay("7", { url: "x", idleMs: 30, socket: () => new FakeFork(() => []) })).rejects.toThrow(/no answer/);
    const closing = (cmd: Record<string, unknown>) => (cmd.netCommandId === "clientReplay" ? [] : replayScript(cmd));
    let fork: FakeFork | undefined;
    const p = readReplay("7", { url: "x", socket: () => (fork = new FakeFork(closing)) });
    await new Promise((r) => setTimeout(r, 20));
    fork!.close();
    await expect(p).rejects.toThrow(/closed before the replay ended/);
    await expect(readReplay("7", { url: "x", maxFrameBytes: 10, socket: () => new FakeFork(replayScript) })).rejects.toThrow(/byte budget/);
    await expect(readReplay("8", { url: "x", socket: () => new FakeFork(replayScript) })).rejects.toThrow(/not game 8/);
    await expect(readReplay("7", { url: "x", maxCommands: 1, socket: () => new FakeFork(replayScript) })).rejects.toThrow(/exceeds 1 commands/);
  });

  it("options from the env: the fork game port, compression on unless turned off, the join only with both coach and digest", () => {
    expect(replayOptionsFromEnv({})).toEqual({ url: "ws://127.0.0.1:22227/command", compression: true });
    expect(replayOptionsFromEnv({ FORK_GAME_PORT: "23000", FORK_REPLAY_COMPRESSION: "false", FORK_REPLAY_COACH: "Bot" })).toEqual({ url: "ws://127.0.0.1:23000/command", compression: false });
    expect(replayOptionsFromEnv({ FORK_REPLAY_URL: "ws://fork:1/command", FORK_REPLAY_COACH: "Bot", FORK_REPLAY_PASSWORD_MD5: "a".repeat(32) }))
      .toEqual({ url: "ws://fork:1/command", compression: true, coach: "Bot", passwordMd5: "a".repeat(32) });
  });
});
