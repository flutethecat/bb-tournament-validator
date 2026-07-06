/** Public API of @bb/ingest — roster + tournament-package ingestion adapters. */

export type { IngestInput, IngestInputKind, IngestResult, RosterSource } from "./roster/rosterSource";
export { ingestRoster } from "./roster/rosterSource";
export { bbtcPdfSource } from "./roster/bbtcPdf";
export type { PackageIngestResult } from "./package/packageSource";
export { ingestPackageDocument, parsePackageDocument } from "./package/packageSource";
export { extractPdfPages } from "./pdf/extractText";
export type { PdfItem, PdfLine, PdfPage } from "./pdf/extractText";
