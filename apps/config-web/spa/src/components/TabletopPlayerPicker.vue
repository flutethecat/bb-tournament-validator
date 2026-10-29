<script setup lang="ts">
// The ONE player picker: every flow that picks a player (touchdown scorer, casualty causer and victim, injury victim, the Other-grid events
// including Throw Team-mate, MVP, the secret objective) opens this sheet. A title ("Touchdown - who?"), an optional caption ("Opponent"),
// team tabs when more than one roster is offered (organisers), a search box when the list is long, the scrollable list of roster rows
// (one tap picks) and Cancel. The caller says which rosters, which players (filter) and whether names are hidden (an opponent's players).
import { computed, ref } from "vue";
import type { MatchView, RosterPlayerView, Side, TeamView } from "../tabletop/recorder";
import TabletopRosterRow from "./TabletopRosterRow.vue";
import TabletopSheetHead from "./TabletopSheetHead.vue";
import TabletopTeamTab from "./TabletopTeamTab.vue";
import type { ArtManifests } from "../tabletop/art";

const props = withDefaults(defineProps<{
  title: string;
  caption?: string;
  match: MatchView;
  teams: Record<Side, TeamView | undefined>;
  /** The rosters offered: one for a participant, both (as tabs) for an organiser. */
  sides: Side[];
  /** Which players may be picked (the server's availability / eligibility); every player when absent. */
  filter?: (player: RosterPlayerView, side: Side) => boolean;
  /** Show "#3 - Position" instead of the player's name (an opponent's players to a participant). */
  obscureNames?: boolean;
  /** Rows to show before a search box appears. */
  searchAbove?: number;
  /** Crest manifest for the team tabs (initials when absent). */
  art?: ArtManifests;
}>(), { caption: "", filter: undefined, obscureNames: false, searchAbove: 12 });
const emit = defineEmits<{ (e: "pick", side: Side, id: string): void; (e: "cancel"): void }>();

const side = ref<Side>(props.sides[0] ?? "home");
const query = ref("");
const players = computed(() => (props.teams[side.value]?.players ?? []).filter((p) => (props.filter ? props.filter(p, side.value) : true)));
const searchable = computed(() => players.value.length > props.searchAbove);
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q || !searchable.value) return players.value;
  return players.value.filter((p) => {
    const hay = [p.number !== undefined ? `#${p.number}` : "", p.positionName ?? p.position ?? p.positionId ?? "", props.obscureNames ? "" : p.name].join(" ").toLowerCase();
    return hay.includes(q);
  });
});
</script>

<template>
  <div class="tt-sheet tt-picker" role="dialog" :aria-label="title">
    <TabletopSheetHead :title="title" @close="emit('cancel')" />
    <p v-if="caption" class="tt-pick-head tt-caption">{{ caption }}</p>
    <div v-if="sides.length > 1" class="tt-rosters tt-rosters-embed tt-picker-tabs">
      <div class="tt-roster-tabs" role="group" aria-label="Team">
        <TabletopTeamTab v-for="s in sides" :key="s" :match="match" :teams="teams" :side="s" :active="side === s" :art="art" @select="side = s" />
      </div>
    </div>
    <input v-if="searchable" v-model="query" class="tt-picker-search" type="search" placeholder="Search number, position or name" aria-label="Search players" autocomplete="off" />
    <p v-if="!players.length" class="muted">No available player.</p>
    <div class="tt-rosters tt-rosters-embed">
      <ul class="tt-roster-list tt-picker-list">
        <TabletopRosterRow v-for="p in shown" :key="p.id" variant="pick" :player="p" :side="side" :obscured="obscureNames" @select="emit('pick', side, p.id)" />
      </ul>
    </div>
    <button class="lobby-btn tt-tap" type="button" @click="emit('cancel')">Cancel</button>
  </div>
</template>
