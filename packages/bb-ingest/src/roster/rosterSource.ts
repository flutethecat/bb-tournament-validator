/**
 * SKETCH (unbuilt). RosterSource — the adapter seam every ingestion format plugs
 * into. Designed up front for the whole roadmap:
 *   M2  bbtc.pl PDF          (pdf bytes → text → Roster)
 *   M4  bbroster.com PDF/text
 *   M5  screenshot OCR       (image bytes → OCR text → Roster)
 *   M6  BB3 game-export JSON (json → Roster) + BB3 screenshot OCR
 * Adapters run in Node (bot/service) or the webview — they receive BYTES/TEXT,
 * never file paths, so the same adapter works in both.
 */

import type { Roster } from "@bb/validator";

export type IngestInputKind = "pdf" | "image" | "json" | "text";

export interface IngestInput {
  kind: IngestInputKind;
  /** Raw bytes for pdf/image; decoded string for json/text. */
  bytes?: Uint8Array;
  text?: string;
  /** Original filename, when known — used only for format sniffing hints. */
  filename?: string;
}

export interface IngestResult {
  roster?: Roster;
  /** Which adapter produced it. */
  sourceId: string;
  /** Parse problems. A roster with problems should be confirmed by the coach (OCR path). */
  problems: string[];
}

export interface RosterSource {
  /** Stable id, e.g. "bbtc-pdf", "bb3-json". */
  id: string;
  accepts: IngestInputKind[];
  /** Cheap sniff: can this adapter plausibly parse the input? */
  canParse(input: IngestInput): boolean | Promise<boolean>;
  /** Full parse. MUST fail loudly (problems / no roster) on unrecognized layouts — never mis-parse. */
  parse(input: IngestInput): Promise<IngestResult>;
}

/** Try adapters in registration order; first canParse wins. */
export async function ingestRoster(
  input: IngestInput,
  sources: RosterSource[],
): Promise<IngestResult> {
  for (const source of sources) {
    if (!source.accepts.includes(input.kind)) continue;
    if (await source.canParse(input)) return source.parse(input);
  }
  return {
    sourceId: "none",
    problems: [
      `No ingestion adapter recognized this ${input.kind}${input.filename ? ` (${input.filename})` : ""}. ` +
        "Supported formats: bbtc.pl PDF export (more coming — see docs/roadmap.md).",
    ],
  };
}
