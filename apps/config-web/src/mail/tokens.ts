// Signed mail links: base64url(JSON payload) + "." + base64url(HMAC-SHA256). The payload names a purpose, a coach key and
// an expiry; it never carries an email address. Verification tokens carry a nonce that must match the pending request;
// unsubscribe tokens are bound to a keyed hash of the address and the coach's consent generation.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";

export type LinkPurpose = "unsub" | "verify";

export interface LinkPayload {
  v: 1;
  p: LinkPurpose;
  /** Coach key (lower-cased coach name). */
  c: string;
  /** Expiry, epoch seconds. */
  e: number;
  /** League id (unsubscribe links from a league message; informational: the opt-out covers all league mail). */
  l?: string;
  /** Verification: nonce of the pending request. */
  n?: string;
  /** Unsubscribe: short keyed hash of the address the message went to (a changed address voids the link). */
  h?: string;
  /** Unsubscribe: the coach's consent generation when issued (re-consent voids older links). */
  g?: number;
  /** Issued at, epoch seconds. */
  i?: number;
}

export const UNSUBSCRIBE_TTL_S = 60 * 24 * 3600;
export const VERIFY_TTL_S = 24 * 3600;

const b64 = (buf: Buffer): string => buf.toString("base64url");

export function signLink(secret: string, payload: LinkPayload): string {
  const body = b64(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = b64(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

export type LinkCheck = { ok: true; payload: LinkPayload } | { ok: false; reason: "malformed" | "signature" | "expired" | "purpose" };

export function verifyLink(secret: string, token: string, purpose: LinkPurpose, nowMs = Date.now()): LinkCheck {
  if (typeof token !== "string" || token.length > 2048) return { ok: false, reason: "malformed" };
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return { ok: false, reason: "malformed" };
  const want = createHmac("sha256", secret).update(body).digest();
  let got: Buffer;
  try { got = Buffer.from(mac, "base64url"); } catch { return { ok: false, reason: "malformed" }; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "signature" };
  let payload: LinkPayload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LinkPayload; } catch { return { ok: false, reason: "malformed" }; }
  if (!payload || payload.v !== 1 || typeof payload.c !== "string" || !payload.c || typeof payload.e !== "number") return { ok: false, reason: "malformed" };
  if (payload.p !== purpose) return { ok: false, reason: "purpose" };
  if (payload.e * 1000 < nowMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/** A random host key kept in a file (MAIL_LINK_SECRET unset); created on first use with mode 0600. */
export function hostKey(file: string): string {
  try {
    if (existsSync(file)) {
      const k = readFileSync(file, "utf8").trim();
      if (k.length >= 32) return k;
    }
  } catch { /* regenerate */ }
  const key = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteTextFile(file, `${key}\n`);
  return key;
}
