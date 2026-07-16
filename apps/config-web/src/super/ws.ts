// Minimal, self-contained RFC 6455 WebSocket server — Node built-ins only (crypto + net).
//
// Why hand-rolled (not the `ws` npm package): config-web is deliberately zero-external-dep and the
// owner mandate is that :4310 must NEVER wobble — adding a dependency means an install that touches the
// running deploy. This codec adds nothing to install. Scope is intentionally small: we control both
// ends (Tarkin's superClient), so we support single-frame TEXT + PING/PONG + CLOSE and reject anything
// exotic (fragmentation, binary) with a clean close rather than trying to be a general WS stack.
//
// SM-3 isolation: NOTHING in here throws into config-web's HTTP path. The caller attaches us to the
// http.Server 'upgrade' event; every socket is its own try/caught island (see service.ts).

import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Compute the Sec-WebSocket-Accept response for the handshake. */
export function acceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

/** A single connected socket. All writes are best-effort; a dead socket never throws upward. */
export class WsConnection {
  private closed = false;
  private buf: Buffer = Buffer.alloc(0);
  onMessage: (text: string) => void = () => {};
  onClose: () => void = () => {};
  /** Opaque per-connection state the service hangs auth/membership off of. */
  data: Record<string, unknown> = {};

  constructor(private readonly socket: Duplex) {
    socket.on("data", (chunk: Buffer) => this.ingest(chunk));
    socket.on("close", () => this.fireClose());
    socket.on("error", () => this.fireClose()); // errors are terminal, never propagate
  }

  private ingest(chunk: Buffer): void {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // Drain as many complete frames as are buffered.
    for (;;) {
      const frame = this.tryReadFrame();
      if (!frame) return; // need more bytes
      const { opcode, payload } = frame;
      if (opcode === 0x8) { this.close(); return; }            // close
      else if (opcode === 0x9) this.writeFrame(0xA, payload);  // ping -> pong (echo)
      else if (opcode === 0x1) {                               // text
        try { this.onMessage(payload.toString("utf8")); }
        catch { /* a handler fault kills nothing but this frame */ }
      } else if (opcode === 0xA) { /* pong: ignore */ }
      else { this.close(); return; }                            // binary/fragmented: unsupported
    }
  }

  /** Parse one masked client frame from the buffer, or return null if incomplete. Consumes bytes. */
  private tryReadFrame(): { opcode: number; payload: Buffer } | null {
    const b = this.buf;
    if (b.length < 2) return null;
    const opcode = b[0]! & 0x0f;
    const masked = (b[1]! & 0x80) !== 0;
    let len = b[1]! & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset); offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      const big = b.readBigUInt64BE(offset); offset += 8;
      if (big > 1_000_000n) { this.close(); return null; } // oversized frame -> drop the connection
      len = Number(big);
    }
    if (len > 1_000_000) { this.close(); return null; }
    if (!masked) { this.close(); return null; } // client frames MUST be masked (RFC 6455)
    if (b.length < offset + 4 + len) return null;
    const mask = b.subarray(offset, offset + 4); offset += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = b[offset + i]! ^ mask[i & 3]!;
    offset += len;
    this.buf = b.subarray(offset);
    return { opcode, payload };
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.closed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.socket.write(Buffer.concat([header, payload])); }
    catch { this.fireClose(); }
  }

  /** Send a UTF-8 text frame (server frames are unmasked). Best-effort. */
  send(text: string): void {
    this.writeFrame(0x1, Buffer.from(text, "utf8"));
  }

  close(): void {
    if (this.closed) return;
    try { this.writeFrame(0x8, Buffer.alloc(0)); } catch { /* ignore */ }
    try { this.socket.end(); } catch { /* ignore */ }
    this.fireClose();
  }

  private fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.onClose(); } catch { /* ignore */ }
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}

/**
 * Complete the upgrade handshake and hand back a WsConnection, or null if this isn't a valid WS
 * upgrade (caller then leaves the socket alone). Never throws.
 */
export function handshake(req: IncomingMessage, socket: Duplex): WsConnection | null {
  try {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      socket.destroy();
      return null;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    return new WsConnection(socket);
  } catch {
    try { socket.destroy(); } catch { /* ignore */ }
    return null;
  }
}
