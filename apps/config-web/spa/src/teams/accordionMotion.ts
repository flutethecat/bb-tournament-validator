// Collapse / expand motion for the Roster pane (owner 10-31): the left accordion's bodies and the Team panel's skill-pack list.
// Height + opacity for ACCORDION_MS; instant without window / matchMedia / the Web Animations API, or under
// prefers-reduced-motion. The hooks are Vue <Transition :css="false"> enter / leave handlers.
export const ACCORDION_MS = 200;
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

export function accordionMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return !window.matchMedia(REDUCED_QUERY).matches;
}

export function heightEnter(el: Element, done: () => void): void {
  const node = el as HTMLElement;
  if (!accordionMotion() || typeof node.animate !== "function") { done(); return; }
  const h = node.scrollHeight;
  node.style.overflow = "hidden";
  const a = node.animate([{ height: "0px", opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: ACCORDION_MS, easing: "ease-out" });
  const end = (): void => { node.style.overflow = ""; done(); };
  a.finished.then(end, end);
}

export function heightLeave(el: Element, done: () => void): void {
  const node = el as HTMLElement;
  if (!accordionMotion() || typeof node.animate !== "function") { done(); return; }
  const h = node.scrollHeight;
  node.style.overflow = "hidden";
  const a = node.animate([{ height: `${h}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: ACCORDION_MS, easing: "ease-in" });
  a.finished.then(done, done);
}
