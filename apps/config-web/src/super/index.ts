// Super Module entry point — constructs the service with its concrete fork-backed dependencies and
// exposes a single `upgrade` handler for config-web's http.Server.
//
// FLAG-GATED (owner mandate: :4310 must never wobble). If SUPER_ENABLED isn't set, attachSuper is a
// no-op — config-web serves exactly as today, zero Super code in any request path. If construction
// throws, we log and DISABLE Super rather than let it touch the HTTP server (SM-3).

import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { SuperService } from "./service.js";
import {
  verifyCoachChallenge,
  forkGameSeat,
  type ForkDbConfig,
  type ForkAdminConfig,
} from "@bb/fork-ops";

const SUPER_WS_PATH = "/super";

export interface AttachSuperOptions {
  dbCfg: ForkDbConfig;
  forkCfg: ForkAdminConfig;
  log?: (line: string) => void;
}

/**
 * Attach the Super WS endpoint to an existing http.Server, behind the SUPER_ENABLED flag. Only the
 * `/super` upgrade path is claimed; any other upgrade is left untouched (config-web has none today,
 * but this keeps us a good citizen). Returns the service handle (for health), or null when disabled.
 */
export function attachSuper(server: Server, opts: AttachSuperOptions): SuperService | null {
  if (process.env.SUPER_ENABLED !== "1") return null;
  const log = opts.log ?? ((l: string) => console.log(`[super] ${l}`));
  try {
    const service = new SuperService({
      log,
      // SM-5/RC-2: challenge-response over the coach's stored md5 — secret never leaves the fork store.
      verifyAuth: (coach, nonce, ts, response) =>
        verifyCoachChallenge(opts.dbCfg, coach, nonce, ts, response),
      // SM-6/RC-1: authoritative seat truth, with park-and-retry when the gamestate isn't queryable
      // at handshake time yet (client hellos "at game start"). Bounded — never admit-unverified.
      resolveSeat: async (gameId, coach) => {
        const attempts = 4;
        const delayMs = 750;
        for (let i = 0; i < attempts; i++) {
          try {
            const seat = await forkGameSeat(opts.forkCfg, gameId, coach);
            if (seat) return seat;
          } catch (e) {
            log(`seat resolve attempt ${i + 1} failed: ${(e as Error).message}`);
          }
          if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
        }
        return null; // not confirmable → reject the handshake (no admit-unverified)
      },
    });

    server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
      // SM-3: this listener can NEVER throw into the HTTP server. Only claim /super; anything else is
      // ignored (left for another handler / dropped by Node).
      try {
        const path = (req.url ?? "").split("?")[0];
        if (path !== SUPER_WS_PATH) return;
        service.onUpgrade(req, socket);
      } catch (e) {
        log(`upgrade dispatch error (contained): ${(e as Error).message}`);
        try { socket.destroy(); } catch { /* ignore */ }
      }
    });

    log(`Super Module enabled on ws path ${SUPER_WS_PATH}`);
    return service;
  } catch (e) {
    // Construction failure ⇒ Super stays OFF, config-web unaffected.
    log(`attach failed, Super DISABLED (config-web unaffected): ${(e as Error).message}`);
    return null;
  }
}
