// Player portraits for the shared team summary (league team page): the generated sprite set (public/sprites/manifest.json,
// the same manifest and lookup the Roster Builder and the share page use: builderCore resolveSprite). Loaded once per
// page session; until it is in (or when it cannot be read) every row shows its initials frame.
import { reactive } from "vue";
import type { Fetcher } from "../session";
import { core, type SpriteManifest } from "./builderCore";
import { artSrc } from "./summary";

const cache = reactive({ manifest: null as SpriteManifest | null, asked: false });

const isManifest = (v: unknown): v is SpriteManifest =>
  Boolean(v && typeof v === "object" && (v as { races?: unknown }).races && typeof (v as { races?: unknown }).races === "object");

/** Fetch the sprite manifest once (a failure leaves the initials). */
export function loadSpriteManifest(api: Fetcher | null | undefined): void {
  if (!api || cache.asked) return;
  cache.asked = true;
  void api<unknown>("/sprites/manifest.json").then((m) => { if (isManifest(m)) cache.manifest = m; }, () => { cache.asked = false; });
}
export const spriteManifest = (): SpriteManifest | null => cache.manifest;

/** A position's portrait for a race ("/sprites/..."), "" when the set has none (custom positions, unknown races). */
export function spriteSrc(manifest: SpriteManifest | null, race: string, position: string): string {
  if (!manifest || !race || !position) return "";
  try { return artSrc(core.resolveSprite(manifest, race, position)); } catch { return ""; }
}
