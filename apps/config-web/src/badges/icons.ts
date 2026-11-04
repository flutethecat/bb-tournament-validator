/**
 * Badge icons (badges lane, 11-04): our own glyphs only (emoji and plain symbols drawn by the viewer's font), never FUMBBL or
 * GW art (laws 16). The catalog names a key; organisers pick a custom badge's icon from this same set. Pure data with no
 * node: imports, so the SPA imports it too (spa/src/badges/badges.ts).
 */

export interface BadgeIcon { glyph: string; label: string }

export const BADGE_ICONS: Readonly<Record<string, BadgeIcon>> = {
  trophy: { glyph: "\u{1F3C6}", label: "Trophy" },
  medal: { glyph: "\u{1F3C5}", label: "Medal" },
  crown: { glyph: "\u{1F451}", label: "Crown" },
  belt: { glyph: "\u{1F94B}", label: "Belt" },
  star: { glyph: "⭐", label: "Star" },
  spark: { glyph: "✨", label: "Sparkle" },
  fire: { glyph: "\u{1F525}", label: "Fire" },
  shield: { glyph: "\u{1F6E1}️", label: "Shield" },
  wall: { glyph: "\u{1F9F1}", label: "Wall" },
  skull: { glyph: "\u{1F480}", label: "Skull" },
  boot: { glyph: "\u{1F97E}", label: "Boot" },
  ball: { glyph: "\u{1F3C8}", label: "Ball" },
  target: { glyph: "\u{1F3AF}", label: "Target" },
  dice: { glyph: "\u{1F3B2}", label: "Dice" },
  clover: { glyph: "\u{1F340}", label: "Clover" },
  rocket: { glyph: "\u{1F680}", label: "Rocket" },
  mountain: { glyph: "⛰️", label: "Mountain" },
  hourglass: { glyph: "⌛", label: "Hourglass" },
  calendar: { glyph: "\u{1F4C5}", label: "Calendar" },
  road: { glyph: "\u{1F6E3}️", label: "Road" },
  globe: { glyph: "\u{1F30D}", label: "Globe" },
  hundred: { glyph: "\u{1F4AF}", label: "Hundred" },
  handshake: { glyph: "\u{1F91D}", label: "Handshake" },
  flag: { glyph: "\u{1F6A9}", label: "Flag" },
  heart: { glyph: "❤️", label: "Heart" },
  bolt: { glyph: "⚡", label: "Bolt" },
  gem: { glyph: "\u{1F48E}", label: "Gem" },
  scroll: { glyph: "\u{1F4DC}", label: "Scroll" },
  house: { glyph: "\u{1F3E0}", label: "House" },
  rising: { glyph: "\u{1F4C8}", label: "Rising" },
  swords: { glyph: "⚔️", label: "Swords" },
  one: { glyph: "1️⃣", label: "One" },
};

export const BADGE_ICON_KEYS = Object.keys(BADGE_ICONS);
export const isBadgeIcon = (v: unknown): v is string => typeof v === "string" && Object.prototype.hasOwnProperty.call(BADGE_ICONS, v);
/** The glyph of an icon key (a star for an unknown one). */
export const badgeGlyph = (key: string | undefined): string => (key && isBadgeIcon(key) ? BADGE_ICONS[key]!.glyph : BADGE_ICONS.star!.glyph);
