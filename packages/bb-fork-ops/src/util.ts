/** Shared internal helpers for fork-ops (XML escaping, filesystem-safe tokens). */

export const xmlEscape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Filesystem-safe token (prevents path traversal from an external coach/game/team name). */
export const safe = (s: string): string => s.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "unknown";
