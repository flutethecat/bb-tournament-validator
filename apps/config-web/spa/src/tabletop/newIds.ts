// Which log events just appeared: the first list is the initial render (nothing animates), later ids not seen before are "new" for a moment, so a
// card (and its timeline marker) pops in after a local post or a poll / push update but never on first load.
import { onBeforeUnmount, reactive, watch } from "vue";

export function useNewIds(ids: () => string[], ms = 450): Set<string> {
  const fresh = reactive(new Set<string>());
  const seen = new Set<string>();
  let primed = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  watch(ids, (list) => {
    if (!primed) { list.forEach((id) => seen.add(id)); primed = true; return; }
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      fresh.add(id);
      timers.push(setTimeout(() => fresh.delete(id), ms));
    }
  }, { immediate: true });
  onBeforeUnmount(() => timers.forEach(clearTimeout));
  return fresh;
}
