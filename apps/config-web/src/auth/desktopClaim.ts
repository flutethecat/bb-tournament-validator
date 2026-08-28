import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const DESKTOP_CLAIM_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_DESKTOP_CLAIMS = 1_024;

const FLOW_ID_PATTERN = /^[a-f0-9]{64}$/i;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type PendingClaim = {
  stateHash: Buffer;
  codeChallenge: string;
  coach: string;
  expiry: number;
  authorizationStarted: boolean;
  result?: { token: string; coach: string; expiresAt: string };
};

type Tombstone = { kind: "cancelled" | "claimed"; expiry: number };

export type DesktopClaimResult =
  | { kind: "pending" }
  | { kind: "complete"; token: string; coach: string; expiresAt: string }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "cancelled" }
  | { kind: "replayed" };

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function pkceChallenge(verifier: string): string {
  return sha256(verifier).toString("base64url");
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function validCoach(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 40;
}

export function validateDesktopClaimStart(body: unknown):
  | { state: string; codeChallenge: string; coach: string }
  | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  if (
    typeof value.state !== "string" || !STATE_PATTERN.test(value.state) ||
    typeof value.codeChallenge !== "string" || !PKCE_CHALLENGE_PATTERN.test(value.codeChallenge) ||
    value.codeChallengeMethod !== "S256" ||
    !validCoach(value.coach)
  ) return undefined;
  return { state: value.state, codeChallenge: value.codeChallenge, coach: value.coach.trim() };
}

export function validateDesktopClaimProof(body: unknown):
  | { flowId: string; state: string; codeVerifier: string }
  | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  if (
    typeof value.flowId !== "string" || !FLOW_ID_PATTERN.test(value.flowId) ||
    typeof value.state !== "string" || !STATE_PATTERN.test(value.state) ||
    typeof value.codeVerifier !== "string" || !PKCE_VERIFIER_PATTERN.test(value.codeVerifier)
  ) return undefined;
  return { flowId: value.flowId, state: value.state, codeVerifier: value.codeVerifier };
}

/**
 * Process-local, short-lived desktop authorization handoff. Config-web sessions are
 * process-local too, so persisting a bearer across a restart would create an unusable
 * (and unnecessarily exposed) credential. Consumed/cancelled tombstones retain only a
 * flow id long enough to distinguish replay from expiry; no bearer is retained there.
 */
export class DesktopClaimStore {
  private claims = new Map<string, PendingClaim>();
  private tombstones = new Map<string, Tombstone>();

  constructor(private readonly discardSession: (token: string) => void = () => undefined) {}

  create(input: { state: string; codeChallenge: string; coach: string }, now = Date.now()): {
    flowId: string;
    expiresAt: string;
  } {
    this.prune(now);
    if (this.claims.size >= MAX_PENDING_DESKTOP_CLAIMS) {
      throw new Error("Too many desktop sign-ins are pending.");
    }
    const flowId = randomBytes(32).toString("hex");
    const expiry = now + DESKTOP_CLAIM_TTL_MS;
    this.claims.set(flowId, {
      stateHash: sha256(input.state),
      codeChallenge: input.codeChallenge,
      coach: input.coach.trim(),
      expiry,
      authorizationStarted: false,
    });
    return { flowId, expiresAt: new Date(expiry).toISOString() };
  }

  beginAuthorization(flowId: string | null | undefined, now = Date.now()):
    | { flowId: string; coach: string }
    | undefined {
    this.prune(now);
    if (!flowId || !FLOW_ID_PATTERN.test(flowId)) return undefined;
    const claim = this.claims.get(flowId);
    if (!claim || claim.authorizationStarted || claim.result) return undefined;
    claim.authorizationStarted = true;
    return { flowId, coach: claim.coach };
  }

  expectedCoach(flowId: string | undefined, now = Date.now()): string | undefined {
    this.prune(now);
    return flowId ? this.claims.get(flowId)?.coach : undefined;
  }

  complete(
    flowId: string,
    result: { token: string; coach: string; expiresAt: string },
    now = Date.now(),
  ): boolean {
    this.prune(now);
    const claim = this.claims.get(flowId);
    if (!claim || !claim.authorizationStarted || claim.result ||
      claim.coach.toLocaleLowerCase() !== result.coach.trim().toLocaleLowerCase()) return false;
    claim.result = { ...result, coach: result.coach.trim() };
    return true;
  }

  claim(proof: { flowId: string; state: string; codeVerifier: string }, now = Date.now()): DesktopClaimResult {
    const expired = this.prune(now);
    if (expired.has(proof.flowId)) return { kind: "expired" };
    const tombstone = this.tombstones.get(proof.flowId);
    if (tombstone) return { kind: tombstone.kind === "claimed" ? "replayed" : "cancelled" };
    const claim = this.claims.get(proof.flowId);
    if (!claim || !this.proofMatches(claim, proof)) return { kind: "invalid" };
    if (!claim.result) return { kind: "pending" };
    this.claims.delete(proof.flowId);
    this.tombstones.set(proof.flowId, { kind: "claimed", expiry: claim.expiry });
    return { kind: "complete", ...claim.result };
  }

  cancel(proof: { flowId: string; state: string; codeVerifier: string }, now = Date.now()): DesktopClaimResult {
    const expired = this.prune(now);
    if (expired.has(proof.flowId)) return { kind: "expired" };
    const tombstone = this.tombstones.get(proof.flowId);
    if (tombstone) return { kind: tombstone.kind === "claimed" ? "replayed" : "cancelled" };
    const claim = this.claims.get(proof.flowId);
    if (!claim || !this.proofMatches(claim, proof)) return { kind: "invalid" };
    this.claims.delete(proof.flowId);
    if (claim.result) this.discardSession(claim.result.token);
    this.tombstones.set(proof.flowId, { kind: "cancelled", expiry: claim.expiry });
    return { kind: "cancelled" };
  }

  private proofMatches(claim: PendingClaim, proof: { state: string; codeVerifier: string }): boolean {
    return safeEqual(claim.stateHash, sha256(proof.state)) &&
      safeEqual(Buffer.from(claim.codeChallenge), Buffer.from(pkceChallenge(proof.codeVerifier)));
  }

  private prune(now: number): Set<string> {
    const expired = new Set<string>();
    for (const [flowId, claim] of this.claims) {
      if (claim.expiry <= now) {
        this.claims.delete(flowId);
        expired.add(flowId);
        if (claim.result) this.discardSession(claim.result.token);
      }
    }
    for (const [flowId, tombstone] of this.tombstones) {
      if (tombstone.expiry <= now) this.tombstones.delete(flowId);
    }
    return expired;
  }
}
