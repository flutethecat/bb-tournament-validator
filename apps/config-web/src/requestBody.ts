export const DEFAULT_JSON_BODY_CAP = 1024 * 1024;
export const MUTATION_JSON_BODY_CAP = 64 * 1024;

export class JsonBodyError extends Error {
  constructor(message: string, readonly status: 400 | 413) {
    super(message);
    this.name = "JsonBodyError";
  }
}

/** Read one bounded JSON request. The cap is enforced while streaming, before concatenation. */
export async function readJsonBody(
  source: AsyncIterable<unknown>,
  maxBytes = DEFAULT_JSON_BODY_CAP,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string);
    total += buffer.byteLength;
    if (total > maxBytes) throw new JsonBodyError(`JSON request body exceeds ${maxBytes} bytes.`, 413);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks, total).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new JsonBodyError("Invalid JSON request body.", 400);
  }
}
