/**
 * PDF → positioned text lines via pdfjs-dist (works in Node via the legacy build
 * and in browsers, which is why it was chosen — the same adapter can run in the
 * FUMBBL40k webview later).
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfItem {
  x: number;
  str: string;
}

export interface PdfLine {
  y: number;
  /** Items joined left-to-right with single spaces. */
  text: string;
  items: PdfItem[];
}

export interface PdfPage {
  lines: PdfLine[];
}

const Y_TOLERANCE = 2;

export async function extractPdfPages(bytes: Uint8Array): Promise<PdfPage[]> {
  const doc = await getDocument({ data: bytes, useSystemFonts: true }).promise;
  const pages: PdfPage[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = new Map<number, PdfItem[]>();
    for (const it of tc.items) {
      if (!("str" in it) || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] as number);
      let key: number | null = null;
      for (const k of rows.keys()) {
        if (Math.abs(k - y) <= Y_TOLERANCE) {
          key = k;
          break;
        }
      }
      if (key === null) {
        key = y;
        rows.set(key, []);
      }
      rows.get(key)!.push({ x: it.transform[4] as number, str: it.str });
    }
    const lines: PdfLine[] = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, items]) => {
        items.sort((a, b) => a.x - b.x);
        return { y, items, text: items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim() };
      });
    pages.push({ lines });
  }
  await doc.destroy();
  return pages;
}
