<script setup lang="ts">
// Tournament Builder, the Roster pane's left accordion (owner 10-31): Hireable players, Sideline staff, Inducements and Star
// players, one open at a time. Hireable players is pinned first and is the open panel by default (on load, and whenever no
// other panel is open). The panels keep one fixed order (owner 10-31: a panel opens IN PLACE and pushes the bars below it
// down; nothing re-sorts), DOM order = visual order, so reading and tab order match the screen. Clicking a collapsed bar
// opens it and collapses the others; clicking an open bar other than Hireable players closes it, which reopens Hireable
// players. Headers are buttons (aria-expanded / aria-controls; Enter and Space work natively). The open panel lives on the controller (state.leftPanel), so it survives
// the page's own address moves for the page session. A race with no star access keeps its star bar, titled NO STAR ACCESS,
// muted and never expandable. Bodies open / close with a ~200 ms height + opacity animation, instant under reduced motion.
import { computed, inject, nextTick } from "vue";
import { LEFT_PANELS, TOURNAMENT_BUILDER_KEY, type LeftPanel } from "../teams/builder";
import { core } from "../teams/builderCore";
import { heightEnter, heightLeave } from "../teams/accordionMotion";
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
/** Fixed order; the open panel expands in place (owner 10-31). */
const ordered = computed(() => [...LEFT_PANELS]);

function title(p: LeftPanel): string {
  if (p === "hire") return "Hireable players";
  if (p === "staff") return "Sideline staff";
  if (p === "inducements") return "Inducements";
  // Blood Bowl Sevens has no Star Players or Mercenaries (the bar's tooltip says so).
  return noStars.value ? (builder.sevens() ? "NO STAR PLAYERS" : "NO STAR ACCESS") : "Star Players";
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
  // Keep focus on the clicked header after the bodies swap.
  await nextTick();
  if (typeof document !== "undefined") document.getElementById(`tb-acc-${p}`)?.focus?.({ preventScroll: true });
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
          :title="disabled(p) ? builder.starsOffReason() : undefined" @click="toggle(p)"
        >
          <span class="tb-acc-title">{{ title(p) }}</span>
          <span v-if="cap(p)" class="hm-cap">{{ cap(p) }}</span>
          <i v-if="!disabled(p)" class="tb-acc-chev" aria-hidden="true"></i>
        </button>
      </h2>
    </header>
    <Transition :css="false" @enter="heightEnter" @leave="heightLeave">
      <div v-if="open === p" :id="`tb-acc-body-${p}`" class="tb-acc-body" role="region" :aria-labelledby="`tb-acc-${p}`">
        <component :is="BODY[p]" />
      </div>
    </Transition>
  </section>
</template>
