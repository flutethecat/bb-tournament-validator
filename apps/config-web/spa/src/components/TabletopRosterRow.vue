<script setup lang="ts">
// One player row in the Team Builder's roster language, shared by the Rosters pane and the recorder's pickers (TD, CAS,
// Injury, Other, MVP, the casualty victim): sprite frame, seat-tinted display-font name, uppercase position, five stat
// boxes and categorised skill chips. `variant="pick"` is the compact picker row (no slot number, no SPP; a button).
// `obscured` hides the player's name and shows "#3 · Position" instead (an opponent's player to a participant).
import { computed } from "vue";
import type { PlayerLineView, RosterPlayerView, Side } from "../tabletop/recorder";

const props = withDefaults(defineProps<{
  player: RosterPlayerView; side: Side; line?: PlayerLineView; variant?: "roster" | "pick"; obscured?: boolean; open?: boolean; active?: boolean;
}>(), { variant: "roster", obscured: false, open: false, active: false });
const emit = defineEmits<{ (e: "select"): void }>();

const STATS = ["ma", "st", "ag", "pa", "av"] as const;
type StatKey = (typeof STATS)[number];
const STAT_NAMES: Record<StatKey, string> = { ma: "Movement Allowance", st: "Strength", ag: "Agility", pa: "Passing Ability", av: "Armour Value" };
const p = computed(() => props.player);
const position = computed(() => p.value.positionName ?? p.value.position ?? p.value.positionId ?? "");

/** Status badge, in the client's order: dead (RIP), injury this game, MNG, niggles. */
const badge = computed((): string => {
  const inj = props.line?.injury?.result;
  if (p.value.dead || inj === "DEAD") return "RIP";
  if (inj) return inj === "stat loss" ? "STAT" : inj;
  if (p.value.mng) return "MNG";
  if (p.value.niggles) return "NI";
  return "";
});
const BADGE_NAMES: Record<string, string> = { RIP: "Dead", KO: "Knocked out", stunned: "Stunned", BH: "Badly Hurt", MNG: "Miss Next Game", NI: "Niggling Injury", STAT: "Characteristic reduced" };
/** MA and ST are plain values; AG, PA and AV are target numbers ("3+"); null / missing = "-". */
const stat = (k: StatKey): string => {
  const v = p.value[k];
  if (v === undefined || v === null || (k !== "ma" && k !== "st" && v <= 0)) return "-"; // a target number of 0 is "no value", never "0+"
  return k === "ma" || k === "st" ? String(v) : `${v}+`;
};
/** +1 when the stat is better than the position's printed one, -1 when worse (AG / PA improve downwards). */
function change(k: StatKey): number {
  const base = p.value.printedStats?.[k];
  const now = p.value[k];
  if (base === undefined || base === null || now === undefined || now === null || base === now || (k !== "ma" && k !== "st" && now <= 0)) return 0;
  const better = k === "ag" || k === "pa" ? now < base : now > base;
  return better ? 1 : -1;
}
const statTip = (k: StatKey): string => {
  const base = p.value.printedStats?.[k];
  return `${STAT_NAMES[k]}${change(k) && base !== undefined && base !== null ? ` (printed ${k === "ma" || k === "st" ? base : `${base}+`})` : ""}`;
};
const spp = computed(() => p.value.spp + (props.line?.sppEarned ?? 0));
const gained = computed(() => props.line?.sppEarned ?? 0);
const sppTip = computed(() => `${spp.value} SPP${gained.value ? `, +${gained.value} this match` : ""}`);
const skillClass = (category: string): string => {
  const c = category.toLowerCase();
  return ["general", "agility", "strength", "passing", "mutation"].includes(c) ? `skill-${c}` : "skill-trait";
};
const skillTip = (sk: { name: string; category: string }, isAdded: boolean): string => `${sk.name}: ${sk.category} skill${isAdded ? ", added" : ""}`;
/** Printed then added skills with their category; a team file without the split lists its skills as traits. */
const printed = computed(() => p.value.printed ?? (p.value.added ? [] : (p.value.skills ?? []).map((name) => ({ name, category: "Trait" }))));
const added = computed(() => p.value.added ?? []);
const initials = computed(() => (position.value || p.value.name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?");
const spriteSrc = computed(() => (typeof p.value.sprite === "string" && /^sprites\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.png$/.test(p.value.sprite) ? `/${p.value.sprite}` : ""));
const num = computed(() => (p.value.number !== undefined ? `#${p.value.number}` : ""));
/** The heading line: the player's name, or "#3 · Position" when obscured (the name never reaches the markup). */
const heading = computed(() => (props.obscured ? [num.value, position.value || "Player"].filter(Boolean).join(" · ") : p.value.name));
const isPick = computed(() => props.variant === "pick");
</script>

<template>
  <li
    class="roster-row roster-grid tt-rp" :class="{ 'tt-rp-pick': isPick }" :data-out="p.dead || p.mng ? 'true' : null" :data-dead="p.dead ? 'true' : null"
    :data-active="open || active ? 'true' : null" :role="isPick ? 'button' : undefined" :tabindex="isPick ? 0 : undefined"
    @click="emit('select')" @keydown.enter.prevent="emit('select')" @keydown.space.prevent="emit('select')"
  >
    <span class="slot-number tt-roster-nr">{{ num }}</span>
    <div class="player-cell">
      <span class="sprite-frame roster-sprite" aria-hidden="true"><span class="sprite-fallback">{{ initials }}</span><img v-if="spriteSrc" class="sprite-image" :src="spriteSrc" alt="" loading="lazy" decoding="async" /></span>
      <span class="player-copy">
        <strong class="tt-roster-name" :data-seat="side"><b v-if="isPick && !obscured && num" class="tt-num-badge">{{ num }}</b>{{ heading }}</strong>
        <small v-if="!obscured" class="tt-roster-pos">{{ position }}</small>
        <span class="tt-lvl" :data-injury="badge || null" :data-tip="BADGE_NAMES[badge] ?? null">{{ badge }}</span>
      </span>
    </div>
    <div class="row-stats">
      <span v-for="k in STATS" :key="k" :class="{ improved: change(k) > 0, worse: change(k) < 0 }" :data-tip="statTip(k)"><b>{{ stat(k) }}</b><small>{{ k.toUpperCase() }}</small></span>
    </div>
    <div class="row-skills">
      <span v-for="(sk, i) in printed" :key="`${sk.name}-${i}`" class="skill" :class="skillClass(sk.category)" :data-tip="skillTip(sk, false)">{{ sk.name }}</span>
      <span v-for="(sk, i) in added" :key="`a-${sk.name}-${i}`" class="skill tv-added" :class="skillClass(sk.category)" :data-tip="skillTip(sk, true)">{{ sk.name }}</span>
    </div>
    <span v-if="!isPick" class="cost tt-roster-spp" :data-zero="spp === 0" :data-tip="sppTip">{{ spp }} SPP<b v-if="gained" class="tt-gain"> (+{{ gained }})</b></span>
    <span v-if="!isPick && (open || p.injuries?.length)" class="tt-roster-inj">
      <template v-if="p.injuries?.length">&#9877; {{ p.injuries.join(" · ") }}</template>
      <template v-if="open"><span class="muted"> {{ p.unavailableReason ?? (p.available === false ? "Unavailable" : "Available") }}<template v-if="p.niggles"> · {{ p.niggles }} niggling</template></span></template>
    </span>
  </li>
</template>
