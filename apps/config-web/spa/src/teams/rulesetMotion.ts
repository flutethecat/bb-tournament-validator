// Ruleset tab motion: which transition the first ruleset pick plays. Pure so it is testable without a DOM.
//   slide: two-column layout, motion allowed: the rulesets panel slides right while Pick a race pops in on the left.
//   fade:  stacked layout (phone / narrow), motion allowed: Pick a race fades in under the summary and scrolls into view.
//   quick: prefers-reduced-motion: the layout switches at once; Pick a race gets an opacity fade of at most QUICK_MS.
export type RulesetMotion = "slide" | "fade" | "quick";
export const WIDE_QUERY = "(min-width: 1180px)";
export const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
export const SLIDE_MS = 380;
export const POP_MS = 300;
export const POP_DELAY_MS = 90;
export const FADE_MS = 220;
export const QUICK_MS = 100;

export function pickMotion(wide: boolean, reduced: boolean): RulesetMotion {
  if (reduced) return "quick";
  return wide ? "slide" : "fade";
}

export function currentMotion(): RulesetMotion {
  if (typeof window === "undefined" || !window.matchMedia) return "quick";
  return pickMotion(window.matchMedia(WIDE_QUERY).matches, window.matchMedia(REDUCED_QUERY).matches);
}
