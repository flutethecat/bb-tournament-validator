<script setup lang="ts">
// The player portrait card, in the Super FUMBBL client's player-card language (SpectateView .player-card): the roster sprite in a portrait box beside
// the five stat boxes, a seat-tinted bold name, the position in white, categorised skill chips (added skills highlighted), SPP with the match gain,
// the status line and the injuries. One component, fed by the same RosterPlayerView the roster rows use. An obscured player (a participant's opponent)
// shows "#3 · Position" with no name and no skills.
import { computed } from "vue";
import type { PlayerLineView, RosterPlayerView, Side } from "../tabletop/recorder";

const props = withDefaults(defineProps<{ player: RosterPlayerView; side: Side; line?: PlayerLineView; obscured?: boolean; x?: number; y?: number }>(), { obscured: false, x: 0, y: 0 });

const STATS = ["ma", "st", "ag", "pa", "av"] as const;
type StatKey = (typeof STATS)[number];
const p = computed(() => props.player);
const position = computed(() => p.value.positionName ?? p.value.position ?? p.value.positionId ?? "");
const num = computed(() => (p.value.number !== undefined ? `#${p.value.number}` : ""));
const heading = computed(() => (props.obscured ? [num.value, position.value].filter(Boolean).join(" · ") || "Player" : p.value.name));
const stat = (k: StatKey): string => {
  const v = p.value[k];
  if (v === undefined || v === null || (k !== "ma" && k !== "st" && v <= 0)) return "-";
  return k === "ma" || k === "st" ? String(v) : `${v}+`;
};
/** 1 = better than the position's printed value, -1 = worse (AG and PA improve downwards). */
function change(k: StatKey): number {
  const base = p.value.printedStats?.[k];
  const now = p.value[k];
  if (base === undefined || base === null || now === undefined || now === null || base === now || (k !== "ma" && k !== "st" && now <= 0)) return 0;
  return (k === "ag" || k === "pa" ? now < base : now > base) ? 1 : -1;
}
const spp = computed(() => p.value.spp + (props.line?.sppEarned ?? 0));
const gain = computed(() => props.line?.sppEarned ?? 0);
/** The client's status words: KO'd, Badly Hurt, Dead ...; an injury this game wins over a standing absence. */
const status = computed((): string => {
  const r = props.line?.injury?.result;
  if (p.value.dead || r === "DEAD") return "Dead";
  if (r === "KO") return "KO'd";
  if (r === "stunned") return "Stunned";
  if (r === "BH") return "Badly Hurt";
  if (r === "MNG") return "Miss Next Game";
  if (r === "NI") return "Niggled";
  if (r === "stat loss") return "Characteristic reduced";
  if (p.value.mng) return "Miss Next Game";
  if (p.value.available === false) return "Reserves";
  return "";
});
const skillClass = (category: string): string => {
  const c = category.toLowerCase();
  return ["general", "agility", "strength", "passing", "mutation"].includes(c) ? `skill-${c}` : "skill-trait";
};
const printed = computed(() => (props.obscured ? [] : p.value.printed ?? (p.value.added ? [] : (p.value.skills ?? []).map((name) => ({ name, category: "Trait" })))));
const added = computed(() => (props.obscured ? [] : p.value.added ?? []));
const sprite = computed(() => (typeof p.value.sprite === "string" && /^sprites\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.png$/.test(p.value.sprite) ? `/${p.value.sprite}` : ""));
const initials = computed(() => (position.value || p.value.name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?");
</script>

<template>
  <aside class="tt-pcard" role="tooltip" :style="{ left: `${x}px`, top: `${y}px` }" :data-obscured="obscured ? 'true' : null">
    <div class="tt-pcard-name" :data-side="side">{{ heading }}</div>
    <div v-if="!obscured && position" class="tt-pcard-position">{{ [num, position].filter(Boolean).join(" · ") }}</div>
    <div v-if="status" class="tt-pcard-status" :data-status="status">{{ status }}</div>
    <div v-if="!obscured && p.injuries?.length" class="tt-pcard-injuries">&#9877; {{ p.injuries.join(" · ") }}</div>
    <div class="tt-pcard-body">
      <div class="tt-pcard-stats">
        <span v-for="k in STATS" :key="k" class="tt-pcard-stat"><em>{{ k.toUpperCase() }}</em><span :data-increased="change(k) > 0 ? 'true' : null" :data-reduced="change(k) < 0 ? 'true' : null">{{ stat(k) }}</span></span>
      </div>
      <div class="tt-pcard-portrait">
        <img v-if="sprite" :src="sprite" alt="" decoding="async" />
        <span v-else class="tt-pcard-missing">{{ initials }}</span>
      </div>
    </div>
    <div v-if="printed.length || added.length" class="tt-pcard-skills">
      <span v-for="(sk, i) in printed" :key="`${sk.name}-${i}`" class="tt-pcard-skill" :class="skillClass(sk.category)">{{ sk.name }}</span>
      <span v-for="(sk, i) in added" :key="`a-${sk.name}-${i}`" class="tt-pcard-skill tt-pcard-added" :class="skillClass(sk.category)">{{ sk.name }}</span>
    </div>
    <div class="tt-pcard-spp">{{ spp }} SPP<b v-if="gain" class="tt-pcard-gain"> (+{{ gain }})</b></div>
  </aside>
</template>
