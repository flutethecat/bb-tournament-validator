// Client-side prep of a team avatar: centre-crop to a square, downscale to at most 512 px, encode under the server's
// 512 KB cap. The server validates again (magic bytes, size, dimensions); this just keeps normal photos acceptable.

export const AVATAR_OUT_MAX_PX = 512;
export const AVATAR_MIN_PX = 64;
export const AVATAR_MAX_BYTES = 512 * 1024;

export interface SquareCrop { sx: number; sy: number; side: number; out: number }

/** The centred square of a w x h image and the output edge (<= 512, never upscaled). */
export function squareCrop(w: number, h: number): SquareCrop {
  const side = Math.min(w, h);
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), side, out: Math.min(side, AVATAR_OUT_MAX_PX) };
}

/** Browser only: crop + downscale `file` and encode it (WebP, then JPEG) under the byte cap. */
export async function prepareAvatar(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    if (Math.min(bitmap.width, bitmap.height) < AVATAR_MIN_PX) throw new Error(`The image must be at least ${AVATAR_MIN_PX} x ${AVATAR_MIN_PX} pixels.`);
    const { sx, sy, side, out } = squareCrop(bitmap.width, bitmap.height);
    let edge = out;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = edge;
      canvas.height = edge;
      canvas.getContext("2d")!.drawImage(bitmap, sx, sy, side, side, 0, 0, edge, edge);
      for (const [type, quality] of [["image/webp", 0.9], ["image/jpeg", 0.88], ["image/jpeg", 0.7]] as const) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
        if (blob && blob.type === type && blob.size <= AVATAR_MAX_BYTES) return blob;
      }
      edge = Math.max(AVATAR_MIN_PX, Math.floor(edge * 0.75));
    }
    throw new Error("The image is too large even after shrinking. Try a simpler picture.");
  } finally {
    bitmap.close();
  }
}
