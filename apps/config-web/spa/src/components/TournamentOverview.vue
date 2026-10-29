<script setup lang="ts">
// Overview tab: the facts the server sent about the tournament, as a card grid (single column on a phone).
import { computed } from "vue";
import type { TournamentSummary } from "../shared/api";
import { remainingRounds, roundProgress, startDate } from "../tournaments/detail";
import { FORMAT_LABEL, STATUS_LABEL } from "../tournaments/list";

const props = defineProps<{ tournament: TournamentSummary }>();
const ruleset = computed(() => props.tournament.rulesetPackName || props.tournament.packageName || "");
const entrants = computed(() => {
  const n = props.tournament.entrantCount ?? 0;
  return props.tournament.maxPlayers > 0 ? `${n} of ${props.tournament.maxPlayers}` : String(n);
});
const left = computed(() => remainingRounds(props.tournament));
</script>

<template>
  <div class="tn-facts">
    <div class="tn-fact"><span class="tn-fact-k">Format</span><strong>{{ FORMAT_LABEL[tournament.format] ?? tournament.format }}</strong></div>
    <div class="tn-fact"><span class="tn-fact-k">Status</span><strong><span class="tn-chip" :data-status="tournament.status">{{ STATUS_LABEL[tournament.status] ?? tournament.status }}</span></strong></div>
    <div class="tn-fact"><span class="tn-fact-k">Round</span><strong>{{ roundProgress(tournament) }}</strong></div>
    <div class="tn-fact"><span class="tn-fact-k">Starts</span><strong>{{ startDate(tournament.startsAt) || "Not set" }}</strong></div>
    <div v-if="tournament.endsAt" class="tn-fact"><span class="tn-fact-k">Ends</span><strong>{{ startDate(tournament.endsAt) }}</strong></div>
    <div class="tn-fact"><span class="tn-fact-k">Ruleset</span><strong>{{ ruleset || "Not set" }}</strong></div>
    <div class="tn-fact"><span class="tn-fact-k">Entrants</span><strong>{{ entrants }}</strong></div>
    <div class="tn-fact"><span class="tn-fact-k">Rounds left</span><strong>{{ left }}</strong></div>
    <div v-if="tournament.ownerCoachId" class="tn-fact"><span class="tn-fact-k">Organisers</span><strong>{{ [tournament.ownerCoachId, ...(tournament.organizerCoachIds ?? [])].join(", ") }}</strong></div>
  </div>
</template>
