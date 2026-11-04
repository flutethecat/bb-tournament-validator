/**
 * TourPlay import upload (lane L8): the organiser's own export, read in memory and nothing else (law 20a: completely
 * inert, no network, no file system). Two shapes, both inside one JSON body:
 *
 *   { zip: "<base64>" }                       a .zip of the export folder(s) the organiser downloaded from TourPlay
 *   { files: [{ name, text }, ...] }          several .csv files picked one by one (or a folder picked in the browser)
 *
 * Safety (both shapes): only .csv files (macOS __MACOSX/ and .DS_Store entries are skipped); paths are relative and
 * "/"-separated, and absolute paths, drive letters, "..", "." and NUL refuse the upload; duplicate paths refuse it; at most
 * UPLOAD_MAX_FILES files, UPLOAD_MAX_FILE_BYTES each and UPLOAD_MAX_TOTAL_BYTES in all. The zip reader understands stored
 * and deflated entries only (no zip64, no encryption), inflates each entry with an output cap equal to its declared size
 * (a zip bomb stops at the cap), and checks the result is exactly that size and its CRC-32 matches.
 *
 * Seasons: every folder holding a `*-fixtures.csv` is one season export (tourplay.ts tourplayFilesFrom); its files are the
 * ones under that folder that no deeper season folder claims.
 */
import { inflateRawSync } from "node:zlib";
import { tourplayFilesFrom, type TourplayEntry, type TourplayFiles } from "./tourplay.js";

export const UPLOAD_MAX_ZIP_BYTES = 8 * 1024 * 1024;
/** The JSON body: the base64 zip (4/3 of the bytes) plus a little room for the decisions. */
export const UPLOAD_MAX_BODY_BYTES = Math.ceil((UPLOAD_MAX_ZIP_BYTES * 4) / 3) + 256 * 1024;
export const UPLOAD_MAX_FILES = 2000;
export const UPLOAD_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const UPLOAD_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Season folders in one upload. */
export const UPLOAD_MAX_SEASONS = 30;

export class UploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const SKIP = (path: string): boolean => path.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(path) || /(^|\/)Thumbs\.db$/i.test(path);

/** A safe relative path ("a/b.csv"), or an UploadError naming the entry. Backslashes count as separators. */
export function safeUploadPath(raw: string): string {
  const shown = raw.slice(0, 120);
  if (typeof raw !== "string" || !raw) throw new UploadError("A file in the upload has no name.");
  if (raw.includes("\0")) throw new UploadError(`Refused "${shown.replace(/\0/g, "")}": the name holds a NUL character.`);
  const path = raw.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) throw new UploadError(`Refused "${shown}": only relative paths are accepted.`);
  const parts = path.split("/");
  // a trailing "/" (directory entry) leaves one empty part; empty parts elsewhere ("a//b") are refused
  const inner = path.endsWith("/") ? parts.slice(0, -1) : parts;
  if (inner.some((p) => p === "" || p === "." || p === "..")) throw new UploadError(`Refused "${shown}": paths may not contain "..", "." or empty parts.`);
  if (path.length > 400) throw new UploadError(`Refused "${shown}...": the path is too long.`);
  return path;
}

const decode = (b: Buffer): string => new TextDecoder("utf-8").decode(b);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
/** CRC-32 (zip / IEEE 802.3). */
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i += 1) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * The .csv files of a zip held in memory. Throws UploadError for anything unsafe or unsupported; never touches the disk.
 */
export function unzipCsv(zip: Buffer): TourplayEntry[] {
  if (zip.length < 22) throw new UploadError("That is not a zip file.");
  if (zip.length > UPLOAD_MAX_ZIP_BYTES) throw new UploadError(`The zip must be at most ${UPLOAD_MAX_ZIP_BYTES / (1024 * 1024)} MB.`, 413);
  // End of central directory: the last 0x06054b50 within the final 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new UploadError("That is not a zip file.");
  const count = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new UploadError("Large (zip64) archives are not supported. Zip the export folder again.");
  if (count > UPLOAD_MAX_FILES) throw new UploadError(`The zip holds more than ${UPLOAD_MAX_FILES} files.`, 413);
  if (cdOffset + cdSize > eocd) throw new UploadError("The zip is damaged (central directory).");
  const out: TourplayEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > eocd || zip.readUInt32LE(p) !== 0x02014b50) throw new UploadError("The zip is damaged (entry list).");
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    if (p + 46 + nameLen > eocd) throw new UploadError("The zip is damaged (entry name).");
    const rawName = flags & 0x800 ? decode(zip.subarray(p + 46, p + 46 + nameLen)) : zip.subarray(p + 46, p + 46 + nameLen).toString("latin1");
    p += 46 + nameLen + extraLen + commentLen;
    const path = safeUploadPath(rawName);
    if (path.endsWith("/") || SKIP(path)) continue;
    if (!/\.csv$/i.test(path)) throw new UploadError(`Only .csv files are accepted: "${path.slice(0, 120)}" is not one.`);
    if (flags & 0x1) throw new UploadError(`"${path}" is encrypted. Zip the export without a password.`);
    if (method !== 0 && method !== 8) throw new UploadError(`"${path}" uses a compression the import does not read. Zip it again with your system's zip tool.`);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new UploadError("Large (zip64) archives are not supported.");
    if (size > UPLOAD_MAX_FILE_BYTES) throw new UploadError(`"${path}" is larger than ${UPLOAD_MAX_FILE_BYTES / (1024 * 1024)} MB.`, 413);
    total += size;
    if (total > UPLOAD_MAX_TOTAL_BYTES) throw new UploadError(`The export unpacks to more than ${UPLOAD_MAX_TOTAL_BYTES / (1024 * 1024)} MB.`, 413);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new UploadError(`"${path}" is in the zip twice.`);
    seen.add(key);
    if (localOffset + 30 > cdOffset || zip.readUInt32LE(localOffset) !== 0x04034b50) throw new UploadError(`The zip is damaged ("${path}").`);
    const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    if (start + compSize > cdOffset) throw new UploadError(`The zip is damaged ("${path}").`);
    const data = zip.subarray(start, start + compSize);
    let bytes: Buffer;
    if (method === 0) {
      if (compSize !== size) throw new UploadError(`The zip is damaged ("${path}").`);
      bytes = data;
    } else {
      try {
        bytes = size === 0 ? Buffer.alloc(0) : inflateRawSync(data, { maxOutputLength: size });
      } catch {
        throw new UploadError(`"${path}" could not be unpacked (damaged, or larger than it says).`);
      }
      if (bytes.length !== size) throw new UploadError(`"${path}" could not be unpacked (its size does not match).`);
    }
    if (crc32(bytes) !== crc) throw new UploadError(`"${path}" is damaged (its checksum does not match). Zip the export again.`);
    out.push({ path, text: decode(bytes) });
  }
  return out;
}

/** Loose CSV files ({ name, text }) under the same rules as zip entries. */
export function csvFilesFrom(raw: unknown): TourplayEntry[] {
  if (!Array.isArray(raw)) throw new UploadError("files must be a list of { name, text }.");
  if (raw.length > UPLOAD_MAX_FILES) throw new UploadError(`At most ${UPLOAD_MAX_FILES} files in one upload.`, 413);
  const out: TourplayEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of raw) {
    if (!f || typeof f !== "object" || typeof (f as { name?: unknown }).name !== "string" || typeof (f as { text?: unknown }).text !== "string")
      throw new UploadError("Each file needs a name and its text.");
    const path = safeUploadPath((f as { name: string }).name);
    if (path.endsWith("/") || SKIP(path)) continue;
    if (!/\.csv$/i.test(path)) throw new UploadError(`Only .csv files are accepted: "${path.slice(0, 120)}" is not one.`);
    const text = (f as { text: string }).text;
    const size = Buffer.byteLength(text, "utf8");
    if (size > UPLOAD_MAX_FILE_BYTES) throw new UploadError(`"${path}" is larger than ${UPLOAD_MAX_FILE_BYTES / (1024 * 1024)} MB.`, 413);
    total += size;
    if (total > UPLOAD_MAX_TOTAL_BYTES) throw new UploadError(`The files come to more than ${UPLOAD_MAX_TOTAL_BYTES / (1024 * 1024)} MB.`, 413);
    if (seen.has(path.toLowerCase())) throw new UploadError(`"${path}" is in the upload twice.`);
    seen.add(path.toLowerCase());
    out.push({ path, text });
  }
  return out;
}

/** The upload body's files: `zip` (base64) or `files`, exactly one. */
export function uploadEntries(body: Record<string, unknown>): TourplayEntry[] {
  const hasZip = body.zip !== undefined;
  const hasFiles = body.files !== undefined;
  if (hasZip === hasFiles) throw new UploadError("Send the export as a zip (zip) or as CSV files (files).");
  if (hasZip) {
    if (typeof body.zip !== "string" || !/^[A-Za-z0-9+/=\s]*$/.test(body.zip)) throw new UploadError("zip must be base64 text.");
    return unzipCsv(Buffer.from(body.zip, "base64"));
  }
  return csvFilesFrom(body.files);
}

/** One season export folder of the upload: its folder ("" = the top level) and its files. */
export interface UploadSeason { folder: string; files: TourplayFiles }

/** Splits the upload into season exports (one per folder holding a *-fixtures.csv). */
export function uploadSeasons(entries: readonly TourplayEntry[]): UploadSeason[] {
  const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const roots = [...new Set(entries.filter((e) => /-fixtures\.csv$/i.test(e.path)).map((e) => dirOf(e.path)))];
  if (!roots.length) throw new UploadError("No *-fixtures.csv in the upload. Upload the folder TourPlay's organiser export gave you.");
  if (roots.length > UPLOAD_MAX_SEASONS) throw new UploadError(`At most ${UPLOAD_MAX_SEASONS} seasons in one upload.`);
  const under = (path: string, root: string): boolean => root === "" || path.startsWith(`${root}/`);
  // deepest root first, so a file goes to the nearest season folder above it
  const ordered = [...roots].sort((a, b) => b.length - a.length);
  const owner = new Map<string, string>();
  for (const e of entries) {
    const root = ordered.find((r) => under(e.path, r));
    if (root !== undefined) owner.set(e.path, root);
  }
  return roots.sort((a, b) => a.localeCompare(b)).map((root) => {
    const mine = entries.filter((e) => owner.get(e.path) === root).map((e) => ({ path: root ? e.path.slice(root.length + 1) : e.path, text: e.text }));
    try {
      return { folder: root, files: tourplayFilesFrom(mine, root ? `"${root}"` : "the upload") };
    } catch (err) {
      throw new UploadError(err instanceof Error ? err.message : "The export could not be read.");
    }
  });
}
