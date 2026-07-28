/**
 * Minimal `multipart/form-data` part extractor — just enough to receive the fork's `xml:result`
 * upload, which the game server builds in `UtilServerHttpClient.postMultipartXml`:
 *   - text part `response`  = the challenge-response string,
 *   - binary part `f`       = the result XML bytes (filename `result.xml`, ContentType.TEXT_XML).
 *
 * We do NOT pull in a framework/parser dependency (config-web is deliberately zero-framework — see
 * server.ts header). This reads the raw request Buffer, splits on the boundary from the Content-Type,
 * and returns each part's name → { value (utf8), raw (bytes) }. It intentionally handles only what the
 * fork actually sends (Content-Disposition with a `name`, optional filename, CRLF line endings). Any
 * shape it can't parse ⇒ it returns what it found; the caller FAILS LOUD on a missing `f` part (TP-4),
 * never banks a truncated upload.
 */

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  /** The part body as UTF-8 text (for the `response` part). */
  value: string;
  /** The part body as raw bytes (for the `f` XML part — value === raw.toString('utf8')). */
  raw: Buffer;
}

/** Pull the boundary token out of a `multipart/form-data; boundary=...` Content-Type header. */
export function boundaryFromContentType(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const m = contentType.match(/boundary=("?)([^";]+)\1/i);
  return m?.[2];
}

/**
 * Parse a multipart body into parts keyed by field name. `boundary` is the token WITHOUT the leading
 * `--`. Returns an empty map if the body has no recognizable parts (caller fails loud on what's missing).
 */
export function parseMultipart(body: Buffer, boundary: string): Map<string, MultipartPart> {
  const parts = new Map<string, MultipartPart>();
  if (!boundary) return parts;
  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const segments = splitBuffer(body, delimiter);
  for (const seg of segments) {
    // Skip the preamble/epilogue and the closing `--` marker.
    if (seg.length === 0) continue;
    // A part starts after the CRLF that follows the delimiter; its headers end at the first CRLFCRLF.
    const headerEnd = indexOfBuffer(seg, Buffer.from("\r\n\r\n", "utf8"));
    if (headerEnd < 0) continue;
    const headerText = seg.slice(0, headerEnd).toString("utf8");
    // Body is between the header terminator and the trailing CRLF that precedes the next delimiter.
    let bodyStart = headerEnd + 4;
    let bodyEnd = seg.length;
    if (bodyEnd >= 2 && seg[bodyEnd - 2] === 0x0d && seg[bodyEnd - 1] === 0x0a) bodyEnd -= 2; // strip trailing CRLF
    const disposition = headerText.match(/content-disposition:[^\r\n]*/i)?.[0] ?? "";
    const name = disposition.match(/\bname="([^"]*)"/i)?.[1];
    if (!name) continue;
    const raw = seg.slice(bodyStart, bodyEnd);
    parts.set(name, {
      name,
      filename: disposition.match(/\bfilename="([^"]*)"/i)?.[1],
      contentType: headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim(),
      value: raw.toString("utf8"),
      raw,
    });
  }
  return parts;
}

/** Split `buf` on every occurrence of `sep`, dropping the separators. */
function splitBuffer(buf: Buffer, sep: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  let idx: number;
  while ((idx = indexOfBuffer(buf, sep, start)) >= 0) {
    out.push(buf.slice(start, idx));
    start = idx + sep.length;
  }
  out.push(buf.slice(start));
  return out;
}

function indexOfBuffer(haystack: Buffer, needle: Buffer, from = 0): number {
  return haystack.indexOf(needle, from);
}
