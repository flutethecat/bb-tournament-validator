// Roboto for the on-screen team sheet (owner 10-30: the sheet reads as the exported PDF). The only Roboto on the site is
// the OFL copy inside the vendored pdfmake font bundle (/vendor/pdfmake/vfs_fonts.js, licence in its LICENSE), the same
// file Export PDF loads. It is fetched as TEXT and the base64 TTFs are read out with a regex (never evaluated), then
// registered as the "Sheet Roboto" family through the FontFace API. No other font files, no CDN. Until it is ready (or
// when it fails, or with no FontFace API: SSR, tests) the sheet uses its fallback stack.
export const SHEET_FONT_FAMILY = "Sheet Roboto";
export const SHEET_FONT_SOURCE = "/vendor/pdfmake/vfs_fonts.js";
const FACES: Array<{ file: string; weight: string; style: string }> = [
  { file: "Roboto-Regular.ttf", weight: "400", style: "normal" },
  { file: "Roboto-Medium.ttf", weight: "700", style: "normal" }, // pdfmake's "bold" is Roboto Medium
  { file: "Roboto-Italic.ttf", weight: "400", style: "italic" },
  { file: "Roboto-MediumItalic.ttf", weight: "700", style: "italic" },
];

/** The base64 payload of one file in the vfs_fonts.js text ("" when absent). */
export function vfsEntry(source: string, file: string): string {
  const at = source.indexOf(`"${file}"`);
  if (at < 0) return "";
  const m = /^"[^"]+"\s*:\s*"([A-Za-z0-9+/=]+)"/.exec(source.slice(at));
  return m ? m[1]! : "";
}
function toBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

let loading: Promise<boolean> | null = null;
/** Registers the sheet's Roboto once per page; resolves true when the faces are in document.fonts. */
export function loadSheetFonts(fetcher: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  if (loading) return loading;
  const g = globalThis as unknown as { FontFace?: typeof FontFace; document?: Document };
  if (typeof g.FontFace !== "function" || !g.document?.fonts) return Promise.resolve(false);
  loading = (async () => {
    const response = await fetcher(SHEET_FONT_SOURCE, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const source = await response.text();
    let added = 0;
    for (const face of FACES) {
      const b64 = vfsEntry(source, face.file);
      if (!b64) continue;
      const font = new g.FontFace!(SHEET_FONT_FAMILY, toBytes(b64), { weight: face.weight, style: face.style });
      await font.load();
      (g.document!.fonts as unknown as { add(face: FontFace): void }).add(font);
      added++;
    }
    return added > 0;
  })().catch(() => { loading = null; return false; });
  return loading;
}
