<script setup lang="ts">
// One team tab in the Rosters pane's notebook style, shared by the Rosters pane and the player picker's team tabs (organisers): a crest frame, the
// team name in the display font, the coach under it, and the chip row (rerolls, apothecary, staff, fans, team value) when the team file has them.
import { computed } from "vue";
import { resolveCrest, type ArtManifests } from "../tabletop/art";
import { uiIcon } from "../tabletop/feed";
import type { MatchView, Side, TeamView } from "../tabletop/recorder";

const props = defineProps<{
  match: MatchView; teams: Record<Side, TeamView | undefined>; side: Side; active: boolean; art?: ArtManifests; inducementIcons?: Record<string, string>;
  /** Optional "eligible/size" count shown at the tab's corner, with its tip. */
  count?: string; countTip?: string;
}>();
const emit = defineEmits<{ (e: "select"): void }>();

const team = computed(() => props.teams[props.side]);
/** The uploaded avatar (same-origin paths only) when the team has one, else the race crest. */
const crest = computed((): string => {
  const a = team.value?.avatarUrl;
  if (typeof a === "string" && /^\/(?!\/)[\w./-]+$/.test(a)) return a;
  return props.art ? resolveCrest(props.art, team.value?.rosterId ?? team.value?.race) : "";
});
const initials = computed(() => (props.match[props.side].teamName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase());

interface Chip { key: string; src: string; label: string; qty: number }
const iconPath = (key: string, fallback: string): string => (props.inducementIcons?.[key] ? `/${props.inducementIcons[key]}` : fallback);
/** Icon chips: rerolls, apothecary, assistant coaches, cheerleaders, dedicated fans; a zero count hides the chip. */
const chips = computed((): Chip[] => {
  const t = team.value;
  if (!t) return [];
  return ([
    { key: "rr", src: uiIcon("re_roll"), label: "Team rerolls", qty: t.rerolls ?? 0 },
    { key: "apo", src: uiIcon("apothecary"), label: "Apothecary", qty: t.apothecary === true ? 1 : 0 },
    { key: "ac", src: iconPath("part_time_assistant_coaches", "/icons/inducements/part_time_assistant_coaches.png"), label: "Assistant coaches", qty: t.assistantCoaches ?? 0 },
    { key: "ch", src: iconPath("temp_agency_cheerleaders", "/icons/inducements/temp_agency_cheerleaders.png"), label: "Cheerleaders", qty: t.cheerleaders ?? 0 },
    { key: "fans", src: uiIcon("dedicated_fans"), label: "Dedicated fans", qty: t.dedicatedFans ?? 0 },
  ] as Chip[]).filter((c) => c.qty > 0);
});
const chipTip = (c: Chip): string => (c.key === "apo" ? c.label : `${c.label}: ${c.qty}`);
</script>

<template>
  <button type="button" class="tt-roster-tab tt-team-tab" :data-seat="side" :data-active="active" @click="emit('select')">
    <span class="sprite-frame crest-frame tt-crest-frame" aria-hidden="true"><span class="sprite-fallback">{{ initials }}</span><img v-if="crest" class="crest-image" :src="crest" alt="" /></span>
    <span class="tt-roster-tab-main">
      <span class="tt-roster-tab-name">{{ match[side].teamName }}</span>
      <small class="tt-roster-coach">{{ match[side].coach }}</small>
      <span class="tt-roster-chips">
        <span v-for="c in chips" :key="c.key" class="tt-rchip" :data-tip="chipTip(c)"><img class="tt-rchip-img" :src="c.src" alt="" /><b v-if="c.key !== 'apo'" class="tt-qty">{{ c.qty }}</b></span>
        <span v-if="team?.teamValue" class="tt-roster-chip" data-tip="Team value">TV {{ Math.round((team?.teamValue ?? 0) / 1000) }}k</span>
      </span>
    </span>
    <span v-if="count" class="tt-roster-count" :data-tip="countTip">{{ count }}</span>
  </button>
</template>
