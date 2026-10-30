// The fork replay reader: one WebSocket to the fork's game port, the game's replay requested and consumed, the socket
// closed. A client of the existing protocol only (upstream-parity doctrine): nothing on the server changes.
//
// Wire (ffb-common / ffb-server, read 10-30):
//   -> clientRequestVersion                 <- serverVersion
//   [optional REPLAY join, when a coach is configured: ServerCommandHandlerJoin accepts clientMode "replay" with the
//    coach's password challenge response (standalone fork: no challenge, the response is hex md5(password));
//    -> clientPasswordChallenge {coach}     <- serverPasswordChallenge {challenge}
//    -> clientJoin {clientMode:"replay"}    <- serverUserSettings]
//   -> clientReplay {gameId, replayToCommandNr:0, coach}
//   <- serverGameState {game}               (UtilServerReplay.startServerReplay: the game's state, players included)
//   <- serverReplay {commandArray[<=100], totalNrOfCommands, lastCommand} ... until lastCommand (ServerReplayer)
//   <- serverStatus "Replay Unavailable" / "Unknown Game Id" when the fork has no log for the game (e.g. 1072)
// The fork's ServerCommandHandlerReplay does not require the join (the REPLAY join only authenticates for user
// settings), so the reader works without a coach; FORK_REPLAY_COACH + FORK_REPLAY_PASSWORD_MD5 turn the join on.
//
// Frames: JSON text, LZ-String compressToUTF16 when the server runs server.command.compression=true (the fork does).
// Incoming frames are detected per frame (plain JSON starts with "{"); outgoing follow FORK_REPLAY_COMPRESSION.
//
// Bounded: an overall deadline, an idle deadline, a per-frame and a total byte budget, a command cap and the
// deriver's moment cap. Moments are derived while the stream arrives; the stream itself is never held.

import { createHash } from "node:crypto";
import { compressToUTF16, decompressFromUTF16 } from "./lzString.js";
import { createMomentDeriver, type ReplayDerivation } from "./moments.js";

/** The slice of the WHATWG WebSocket the reader uses (Node 22+ global WebSocket fits; tests inject a fake). */
export interface ReplaySocket {
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void;
}

export interface ReplayReadOptions {
  /** ws://host:port/command */
  url: string;
  /** Compress outgoing frames (the fork's server.command.compression). Default true. */
  compression?: boolean;
  /** Optional REPLAY-mode join: the coach and hex md5(password). Never logged. */
  coach?: string;
  passwordMd5?: string;
  timeoutMs?: number;
  idleMs?: number;
  maxFrameBytes?: number;
  maxTotalBytes?: number;
  maxCommands?: number;
  maxMoments?: number;
  socket?: (url: string) => ReplaySocket;
  /** Sees every replayed command in order (fixture capture). */
  tap?: (command: unknown, gameState?: unknown) => void;
}

export type ReplayReadResult =
  | { status: "ready"; derivation: ReplayDerivation }
  | { status: "unavailable"; reason: string };

/** A failure worth retrying later (timeout, socket error, a closed socket): never cached. */
export class ReplayReadError extends Error {}

const UNAVAILABLE_STATUSES = new Set(["Replay Unavailable", "Unknown Game Id"]);

/** upstream PasswordChallenge.createResponse over hex md5(password); an empty challenge answers the digest itself. */
export function challengeResponse(challenge: string | null | undefined, passwordMd5: string): string {
  const pwd = Buffer.from(passwordMd5, "hex");
  if (!challenge) return pwd.toString("hex");
  const xor = (mask: number) => Buffer.from(pwd.map((b) => b ^ mask));
  const md5 = (b: Buffer) => createHash("md5").update(b).digest();
  return md5(Buffer.concat([xor(0x5c), md5(Buffer.concat([xor(0x36), Buffer.from(challenge, "hex")]))])).toString("hex");
}

function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as Uint8Array);
  throw new ReplayReadError("unreadable frame");
}

/** One frame -> its command (plain JSON, or LZ-String UTF-16). */
export function decodeFrame(data: unknown): Record<string, unknown> {
  const text = frameText(data);
  const json = text.trimStart().startsWith("{") ? text : decompressFromUTF16(text);
  if (!json) throw new ReplayReadError("undecodable frame");
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ReplayReadError("frame is not a command");
  return parsed as Record<string, unknown>;
}

/** Reads the replay of one finished fork game. Resolves "unavailable" for a game the fork has no log for. */
export function readReplay(gameId: string, opts: ReplayReadOptions): Promise<ReplayReadResult> {
  const id = Number(gameId);
  if (!Number.isSafeInteger(id) || id <= 0) return Promise.resolve({ status: "unavailable", reason: "not a fork game id" });
  const compression = opts.compression ?? true;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const idleMs = opts.idleMs ?? 15_000;
  const maxFrameBytes = opts.maxFrameBytes ?? 16 * 1024 * 1024;
  const maxTotalBytes = opts.maxTotalBytes ?? 128 * 1024 * 1024;
  const maxCommands = opts.maxCommands ?? 100_000;
  const join = !!(opts.coach && opts.passwordMd5 && /^[0-9a-f]{32}$/i.test(opts.passwordMd5));
  const coach = opts.coach ?? "";

  return new Promise<ReplayReadResult>((resolve, reject) => {
    let settled = false;
    let socket: ReplaySocket | undefined;
    let deriver: ReturnType<typeof createMomentDeriver> | undefined;
    let gameState: unknown;
    let commands = 0;
    let bytes = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const overall = setTimeout(() => fail(new ReplayReadError(`replay of game ${gameId} timed out`)), timeoutMs);

    function cleanup(): void {
      clearTimeout(overall);
      if (idle) clearTimeout(idle);
      if (ping) clearInterval(ping);
      try { socket?.close(1000, "done"); } catch { /* already closed */ }
    }
    function finish(r: ReplayReadResult): void { if (settled) return; settled = true; cleanup(); resolve(r); }
    function fail(e: Error): void { if (settled) return; settled = true; cleanup(); reject(e); }
    function touch(): void {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => fail(new ReplayReadError(`replay of game ${gameId}: no answer for ${idleMs} ms`)), idleMs);
    }
    function send(command: Record<string, unknown>): void {
      const json = JSON.stringify(command);
      socket!.send(new TextEncoder().encode(compression ? compressToUTF16(json) : json));
    }
    const requestReplay = (): void => send({ netCommandId: "clientReplay", gameId: id, replayToCommandNr: 0, coach: coach || null });

    try {
      socket = (opts.socket ?? ((u) => new WebSocket(u) as unknown as ReplaySocket))(opts.url);
      socket.binaryType = "arraybuffer";
    } catch (e) {
      fail(new ReplayReadError(`replay socket could not open: ${(e as Error).message}`));
      return;
    }
    touch();
    socket.addEventListener("open", () => {
      touch();
      try { send({ netCommandId: "clientRequestVersion" }); } catch (e) { fail(new ReplayReadError((e as Error).message)); }
    });
    socket.addEventListener("error", () => fail(new ReplayReadError(`replay socket error (game ${gameId})`)));
    socket.addEventListener("close", () => fail(new ReplayReadError(`replay socket closed before the replay ended (game ${gameId})`)));
    socket.addEventListener("message", (event) => {
      if (settled) return;
      touch();
      try {
        const size = typeof event.data === "string" ? event.data.length * 2 : (event.data as ArrayBuffer | Uint8Array)?.byteLength ?? 0;
        bytes += size;
        if (size > maxFrameBytes || bytes > maxTotalBytes) throw new ReplayReadError(`replay of game ${gameId} exceeds the byte budget`);
        const cmd = decodeFrame(event.data);
        switch (cmd.netCommandId) {
          case "serverVersion":
            ping = setInterval(() => { try { send({ netCommandId: "clientPing", timestamp: Date.now() }); } catch { /* closing */ } }, 8_000);
            if (join) send({ netCommandId: "clientPasswordChallenge", coach });
            else requestReplay();
            break;
          case "serverPasswordChallenge":
            send({
              netCommandId: "clientJoin", clientMode: "replay", coach,
              password: challengeResponse(typeof cmd.challenge === "string" ? cmd.challenge : null, opts.passwordMd5!),
              gameId: id, gameName: null, teamId: null, teamName: null,
            });
            break;
          case "serverUserSettings":
            if (join && !deriver) requestReplay();
            break;
          case "serverStatus": {
            const status = String(cmd.serverStatus ?? "");
            if (UNAVAILABLE_STATUSES.has(status)) finish({ status: "unavailable", reason: status });
            else fail(new ReplayReadError(`fork answered ${status || "an unknown status"}`));
            break;
          }
          case "serverGameState": {
            const game = cmd.game as { gameId?: unknown } | undefined;
            if (!game || Number(game.gameId) !== id) throw new ReplayReadError(`replay game state is not game ${gameId}`);
            gameState = game;
            deriver = createMomentDeriver(game, { maxMoments: opts.maxMoments });
            break;
          }
          case "serverReplay": {
            if (!deriver) throw new ReplayReadError("replay commands before the game state");
            const list = Array.isArray(cmd.commandArray) ? cmd.commandArray : [];
            for (const c of list) {
              if (++commands > maxCommands) throw new ReplayReadError(`replay of game ${gameId} exceeds ${maxCommands} commands`);
              opts.tap?.(c, gameState);
              deriver.feed(c);
            }
            if (cmd.lastCommand === true) finish({ status: "ready", derivation: deriver.result() });
            break;
          }
          default: break;
        }
      } catch (e) {
        fail(e instanceof ReplayReadError ? e : new ReplayReadError(`replay of game ${gameId}: ${(e as Error).message}`));
      }
    });
  });
}

/** FORK_REPLAY_* (and FORK_GAME_PORT) -> reader options; secrets stay in memory only. */
export function replayOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ReplayReadOptions {
  const port = Number(env.FORK_GAME_PORT || 22227);
  const coach = env.FORK_REPLAY_COACH?.trim();
  const passwordMd5 = env.FORK_REPLAY_PASSWORD_MD5?.trim();
  return {
    url: env.FORK_REPLAY_URL?.trim() || `ws://127.0.0.1:${port}/command`,
    compression: !/^(false|0|no|off)$/i.test((env.FORK_REPLAY_COMPRESSION ?? "").trim()),
    ...(coach && passwordMd5 ? { coach, passwordMd5 } : {}),
  };
}
