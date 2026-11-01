<script setup lang="ts">
// Tournament Honours tab: the honour boards (top five per stat, the rest behind "All N") of the tournament's results,
// with Team / Player / Coach toggles. Same boards as a league season's Honours (HonourBoards).
import { computed, inject, onMounted, ref } from "vue";
import HonourBoards from "./HonourBoards.vue";
import SegToggle from "./SegToggle.vue";
import { BOARD_KINDS, boardGroups, TOURNAMENT_HONOURS_KEY, type BoardKind } from "../tournaments/honours";
import "../leagues/leagues.css";

const props = defineProps<{ id: string }>();
const ctl = inject(TOURNAMENT_HONOURS_KEY)!;
const { state } = ctl;
const stats = computed(() => (state.id === props.id ? state.stats : null));
const kind = ref<BoardKind>("team");
const groups = computed(() => boardGroups(stats.value?.honours ?? [], kind.value));
const value = (v: unknown): string => String(v);
onMounted(() => void ctl.loadStats(props.id));
</script>

<template>
  <p v-if="state.statsStatus === 'error' && !stats" class="sf-error" role="alert">{{ state.statsError }}</p>
  <p v-else-if="!stats" class="hm-empty" role="status">Loading honours...</p>
  <div v-else class="lg-stack tn-honours">
    <SegToggle v-model="kind" :options="BOARD_KINDS" label="Honours for" />
    <HonourBoards v-if="groups.length" :groups="groups" :value="value" />
    <section v-else class="hm-panel" aria-label="Honours">
      <p class="hm-empty">{{ stats.totals.games ? (kind === "player" ? "These results carry no player stats." : "No honours yet.") : "No results yet. Honours fill in as games are played." }}</p>
    </section>
  </div>
</template>
