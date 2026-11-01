// Screen-reader announcement of the newest EFFECTIVE event (never a removed one), once the match has loaded. An event
// that arrives together with its undo is not announced; an event already seen is never announced again when an undo
// makes it the latest; identical consecutive actions re-announce (the text carries the player and a zero-width counter).
import { ref, watch, type Ref } from "vue";
import type { FeedRow } from "./feed";

export const announceText = (r: Pick<FeedRow, "player" | "number" | "lead" | "rest">, n: number): string =>
  `${[r.player || r.number, `${r.lead}${r.rest}`.trim()].filter(Boolean).join(": ")}${"​".repeat(n % 2 + 1)}`;

export function useAnnouncer(rows: () => readonly FeedRow[], loaded: () => boolean): Ref<string> {
  const text = ref("");
  const seen = new Set<string>();
  let primed = false;
  let n = 0;
  const effective = (): FeedRow[] => rows().filter((r) => r.part === "main" && r.removed === null);
  watch([() => effective().map((r) => r.id).join("\n"), loaded], () => {
    if (!loaded()) return;
    const list = effective();
    const fresh = list.filter((r) => !seen.has(r.id));
    list.forEach((r) => seen.add(r.id));
    if (!primed) { primed = true; return; } // the first load (even an empty match) announces nothing
    const last = fresh.at(-1);
    if (last) text.value = announceText(last, ++n);
  }, { immediate: true });
  return text;
}
