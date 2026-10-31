<script setup lang="ts">
// Tournament Builder, the Roster pane's left accordion (owner 10-31): Hireable players, Sideline staff, Inducements and Star
// players, one open at a time. Hireable players is pinned first and is the open panel by default (on load, and whenever no
// other panel is open). The other collapsed header bars stack directly under it in that fixed order and another open panel
// sits last with its body (DOM order = visual order, so reading and tab order match the screen). Clicking a collapsed bar
// opens it and collapses the others; clicking an open bar other than Hireable players closes it, which reopens Hireable
// players. Headers are buttons (aria-expanded / aria-controls; Enter and Space work natively). The open panel lives on the controller (state.leftPanel), so it survives
// the page's own address moves for the page session. A race with no star access keeps its star bar, titled NO STAR ACCESS,
// muted and never expandable. Bodies open / close with a ~200 ms height + opacity animation, instant under reduced motion.
import { computed, inject, nextTick } from "vue";
import { LEFT_PANELS, TOURNAMENT_BUILDER_KEY, type LeftPanel } from "../teams/builder";
import { core } from "../teams/builderCore";
import { ACCORDION_MS, accordionMotion } from "../teams/accordionMotion";
import TournamentBuilderHire from "./TournamentBuilderHire.vue";
import TournamentBuilderStaff from "./TournamentBuilderStaff.vue";
import TournamentBuilderInducements from "./TournamentBuilderInducements.vue";
import TournamentBuilderStars from "./TournamentBuilderStars.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

const HEADING: Record<LeftPanel, string> = { hire: "tb-add-h", staff: "tb-staff-h", inducements: "tb-ind-h", stars: "tb-stars-h" };
const BODY = { hire: TournamentBuilderHire, staff: TournamentBuilderStaff, inducements: TournamentBuilderInducements, stars: TournamentBuilderStars };

const noStars = computed(() => !builder.starsAllowed());
const disabled = (p: LeftPanel): boolean => p === "stars" && noStars.value;
/** The open panel: Hireable players unless another one is open (a remembered Star players panel falls back to Hireable
 *  players for a race with no star access). */
const open = computed<LeftPanel>(() => (!state.leftPanel || disabled(state.leftPanel) ? "hire" : state.leftPanel));
/** Hireable players first, then the other collapsed bars (fixed order), then another open panel. */
const ordered = computed(() => ["hire" as const, ...LEFT_PANELS.filter((p) => p !== "hire" && p !== open.value), ...(open.value !== "hire" ? [open.value] : [])]);

function title(p: LeftPanel): string {
  if (p === "hire") return "Hireable players";
  if (p === "staff") return "Sideline staff";
  if (p === "inducements") return "Inducements";
  return noStars.value ? "NO STAR ACCESS" : "Star Players";
}
function cap(p: LeftPanel): string {
  const t = builder.totals();
  if (p === "hire") return ""; // the Roster header carries the player count (owner 10-31)
  if (p === "staff") return core.gold(t.sidelineCost);
  if (p === "inducements") return t.inducementsCost ? core.gold(t.inducementsCost) : "";
  if (noStars.value) return "";
  const c = builder.starCap();
  return c != null ? `${builder.starPickCount()} / ${c}` : "";
}

async function toggle(p: LeftPanel): Promise<void> {
  if (disabled(p) || (p === "hire" && open.value === "hire")) return; // Hireable players stays open until another panel opens
  state.leftPanel = open.value === p ? null : p;
  // The panels re-order (the clicked bar moves under the collapsed ones): keep focus on its button.
  await nextTick();
  if (typeof document !== "undefined") document.getElementById(`tb-acc-${p}`)?.focus?.({ preventScroll: true });
}

// Body open / close: height + opacity (Web Animations), instant under prefers-reduced-motion or without the API.
function onEnter(el: Element, done: () => void): void {
  const node = el as HTMLElement;
  if (!accordionMotion() || typeof node.animate !== "function") { done(); return; }
  const h = node.scrollHeight;
  node.style.overflow = "hidden";
  const a = node.animate([{ height: "0px", opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: ACCORDION_MS, easing: "ease-out" });
  const end = (): void => { node.style.overflow = ""; done(); };
  a.finished.then(end, end);
}
function onLeave(el: Element, done: () => void): void {
  const node = el as HTMLElement;
  if (!accordionMotion() || typeof node.animate !== "function") { done(); return; }
  const h = node.scrollHeight;
  node.style.overflow = "hidden";
  const a = node.animate([{ height: `${h}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: ACCORDION_MS, easing: "ease-in" });
  a.finished.then(done, done);
}
</script>

<template>
  <section
    v-for="p in ordered" :key="p" class="hm-panel tb-panel tb-acc" :class="{ open: open === p, off: disabled(p) }" :data-panel="p"
    :aria-labelledby="HEADING[p]"
  >
    <header class="hm-band tb-acc-band">
      <h2 :id="HEADING[p]">
        <button
          :id="`tb-acc-${p}`" type="button" class="tb-acc-btn" :aria-expanded="open === p ? 'true' : 'false'"
          :aria-controls="disabled(p) ? undefined : `tb-acc-body-${p}`" :aria-disabled="disabled(p) ? 'true' : undefined"
          :title="disabled(p) ? 'This race has no access to star players under this ruleset.' : undefined" @click="toggle(p)"
        >
          <span class="tb-acc-title">{{ title(p) }}</span>
          <span v-if="cap(p)" class="hm-cap">{{ cap(p) }}</span>
          <i v-if="!disabled(p)" class="tb-acc-chev" aria-hidden="true"></i>
        </button>
      </h2>
    </header>
    <Transition :css="false" @enter="onEnter" @leave="onLeave">
      <div v-if="open === p" :id="`tb-acc-body-${p}`" class="tb-acc-body" role="region" :aria-labelledby="`tb-acc-${p}`">
        <component :is="BODY[p]" />
      </div>
    </Transition>
  </section>
</template>
