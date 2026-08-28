import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_CLAIM_TTL_MS,
  DesktopClaimStore,
  validateDesktopClaimProof,
  validateDesktopClaimStart,
} from "../src/auth/desktopClaim.js";

const state = "s".repeat(43);
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

function startInput() {
  return { state, codeChallenge: challenge, codeChallengeMethod: "S256", coach: "Tarkin" };
}

function newFlow(store: DesktopClaimStore, now = 1_000) {
  const created = store.create({ state, codeChallenge: challenge, coach: "Tarkin" }, now);
  const proof = { flowId: created.flowId, state, codeVerifier: verifier };
  return { created, proof };
}

describe("desktop OAuth claim validation", () => {
  it("accepts only a named fork coach, opaque state, and S256 PKCE", () => {
    expect(validateDesktopClaimStart(startInput())).toEqual({
      state,
      codeChallenge: challenge,
      coach: "Tarkin",
    });
    expect(validateDesktopClaimStart({ ...startInput(), coach: "" })).toBeUndefined();
    expect(validateDesktopClaimStart({ ...startInput(), codeChallengeMethod: "plain" })).toBeUndefined();
    expect(validateDesktopClaimStart({ ...startInput(), state: "short" })).toBeUndefined();
  });

  it("validates the complete client proof shape before store lookup", () => {
    const { proof } = newFlow(new DesktopClaimStore());
    expect(validateDesktopClaimProof(proof)).toEqual(proof);
    expect(validateDesktopClaimProof({ ...proof, codeVerifier: "short" })).toBeUndefined();
    expect(validateDesktopClaimProof({ ...proof, flowId: "../flow" })).toBeUndefined();
  });
});

describe("one-time desktop OAuth claim", () => {
  it("stays pending, then returns the completed session exactly once", () => {
    const store = new DesktopClaimStore();
    const { created, proof } = newFlow(store);
    expect(store.beginAuthorization(created.flowId, 1_001)).toEqual({
      flowId: created.flowId,
      coach: "Tarkin",
    });
    expect(store.beginAuthorization(created.flowId, 1_002)).toBeUndefined();
    expect(store.claim(proof, 1_003)).toEqual({ kind: "pending" });
    expect(store.complete(created.flowId, {
      token: "session-token",
      coach: "Tarkin",
      expiresAt: "2026-08-29T00:00:00.000Z",
    }, 1_004)).toBe(true);
    expect(store.claim(proof, 1_005)).toEqual({
      kind: "complete",
      token: "session-token",
      coach: "Tarkin",
      expiresAt: "2026-08-29T00:00:00.000Z",
    });
    expect(store.claim(proof, 1_006)).toEqual({ kind: "replayed" });
  });

  it("rejects mismatched state and PKCE without consuming the valid claim", () => {
    const store = new DesktopClaimStore();
    const { created, proof } = newFlow(store);
    store.beginAuthorization(created.flowId, 1_001);
    expect(store.claim({ ...proof, state: "x".repeat(43) }, 1_002)).toEqual({ kind: "invalid" });
    expect(store.claim({ ...proof, codeVerifier: "z".repeat(43) }, 1_003)).toEqual({ kind: "invalid" });
    expect(store.claim(proof, 1_004)).toEqual({ kind: "pending" });
  });

  it("expires a pending claim and destroys any unclaimed completed session", () => {
    const discarded: string[] = [];
    const store = new DesktopClaimStore((token) => discarded.push(token));
    const { created, proof } = newFlow(store);
    store.beginAuthorization(created.flowId, 1_001);
    store.complete(created.flowId, {
      token: "orphan-session",
      coach: "Tarkin",
      expiresAt: "2026-08-29T00:00:00.000Z",
    }, 1_002);
    expect(store.claim(proof, 1_000 + DESKTOP_CLAIM_TTL_MS)).toEqual({ kind: "expired" });
    expect(discarded).toEqual(["orphan-session"]);
  });

  it("cancels pending and completed flows and never releases their bearer", () => {
    const discarded: string[] = [];
    const store = new DesktopClaimStore((token) => discarded.push(token));
    const pending = newFlow(store);
    expect(store.cancel(pending.proof, 1_001)).toEqual({ kind: "cancelled" });
    expect(store.claim(pending.proof, 1_002)).toEqual({ kind: "cancelled" });

    const completed = newFlow(store, 2_000);
    store.beginAuthorization(completed.created.flowId, 2_001);
    store.complete(completed.created.flowId, {
      token: "cancelled-session",
      coach: "Tarkin",
      expiresAt: "2026-08-29T00:00:00.000Z",
    }, 2_002);
    expect(store.cancel(completed.proof, 2_003)).toEqual({ kind: "cancelled" });
    expect(discarded).toEqual(["cancelled-session"]);
  });

  it("refuses to complete a flow for a different fork coach", () => {
    const store = new DesktopClaimStore();
    const { created } = newFlow(store);
    store.beginAuthorization(created.flowId, 1_001);
    expect(store.complete(created.flowId, {
      token: "wrong-session",
      coach: "Fives",
      expiresAt: "2026-08-29T00:00:00.000Z",
    }, 1_002)).toBe(false);
  });
});
