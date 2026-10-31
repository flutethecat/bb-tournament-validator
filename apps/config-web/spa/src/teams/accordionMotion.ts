// The Roster pane's left accordion: body open / close animation length and whether it plays. No window, no matchMedia or
// prefers-reduced-motion -> instant.
export const ACCORDION_MS = 200;
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

export function accordionMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return !window.matchMedia(REDUCED_QUERY).matches;
}
