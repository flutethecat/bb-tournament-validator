// Feature registry = the ⚖ admission mechanism (keystone §4). A feature exists on the Super channel
// ONLY as an entry here. Each entry carries:
//   - plane / presentation-only classification (charter law: nothing here may carry game state)
//   - a payload validator (SM-2: peer payloads are UNTRUSTED — authed ≠ trusted; validate at admission,
//     DROP non-conforming, never relay)
//   - whether the payload carries coordinates that the service must frame-normalize (SM-1/RC-1)
//
// SC-5: the registry is the operational KILL SWITCH. Remove a feature's key from ACTIVE_FEATURES (or
// flip `enabled:false`) and it empties out of every capability intersection → field-inert with NO client
// release. That is the prod rollback answer for "S1 misbehaves, now what?".

export interface FeatureEntry {
  readonly key: string;
  readonly plane: 1 | 2 | 3;
  readonly enabled: boolean;
  /** true ⇒ payload has {x,y} the service un-mirrors publisher→global and mirrors global→recipient. */
  readonly coordFramed: boolean;
  /** Validate a client-supplied payload. Return the SANITIZED payload to relay, or null to DROP it. */
  readonly validate: (payload: unknown) => Record<string, unknown> | null;
}

// Pitch is 26 wide (x 0..25) × 15 tall (y 0..14) in the server/global frame.
const PITCH_W = 26;
const PITCH_H = 15;

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

/** MVP registry. S1 kick-aim only; S2/policy/watch are post-MVP (own stage-2) and NOT admitted here. */
const REGISTRY: Record<string, FeatureEntry> = {
  "s1.kickAim": {
    key: "s1.kickAim",
    plane: 1,
    enabled: true,
    coordFramed: true,
    validate: (p) => {
      if (typeof p !== "object" || p === null) return null;
      const { x, y } = p as { x?: unknown; y?: unknown };
      // Clamp/reject to the pitch bounds — a hostile peer's {x:9999,y:NaN} is dropped, never relayed
      // and never drawn off-pitch. Coords here are still in the PUBLISHER's local frame; the service
      // normalizes after validation (see service.ts).
      if (!isInt(x) || !isInt(y)) return null;
      if (x < 0 || x >= PITCH_W || y < 0 || y >= PITCH_H) return null;
      return { x, y };
    },
  },
};

/** Feature keys the SERVICE advertises as available right now (SC-5 kill switch: edit this set). */
export function serviceCapabilities(): string[] {
  return Object.values(REGISTRY)
    .filter((f) => f.enabled)
    .map((f) => f.key);
}

export function getFeature(key: string): FeatureEntry | undefined {
  const f = REGISTRY[key];
  return f && f.enabled ? f : undefined;
}

export { PITCH_W };
