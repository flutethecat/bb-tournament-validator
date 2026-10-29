/**
 * Small request helpers shared by the league routes (api.ts settings, redraftApi.ts): the JSON body reader and the
 * revision a write names (body.revision, else If-Match).
 */

export interface BodyDeps {
  readBody?(max: number): Promise<Buffer | undefined>;
  declaredTooLarge?(max: number): boolean;
}

export type JsonBodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; status: number; error: string; close?: boolean };

/** Reads a JSON object body of at most `max` bytes ({} when empty). */
export async function readJsonObject(deps: BodyDeps, max: number): Promise<JsonBodyResult> {
  if (deps.declaredTooLarge?.(max)) return { ok: false, status: 413, error: "Request too large.", close: true };
  const raw = await deps.readBody?.(max);
  if (raw === undefined) return { ok: false, status: 413, error: "Request too large.", close: true };
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw.toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, status: 400, error: "Send a JSON object." };
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: "Send valid JSON." };
  }
}

/** The revision a write names: body.revision, else the If-Match header ("3", W/"3" or 3). */
export function requestRevision(input: Record<string, unknown>, ifMatch: string | undefined): number | "missing" | "bad" {
  if (input.revision !== undefined) return typeof input.revision === "number" && Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : "bad";
  const raw = ifMatch?.trim();
  if (!raw) return "missing";
  const m = /^(?:W\/)?"?(\d{1,15})"?$/.exec(raw);
  return m ? Number(m[1]) : "bad";
}
