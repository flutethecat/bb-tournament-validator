<script setup lang="ts">
// Rounds tab: per round, fixture rows (home team + coach, crest, score with TD / CAS sub-counts, away team + coach,
// crest; "vs" for an unplayed fixture). The server sends fixtures only to signed-in coaches (an entrant gets every
// fixture of the event, others only their own) and organisers, so an anonymous visitor sees the rounds with an empty
// state. An entrant can switch between all fixtures and their own; their fixtures are highlighted.
import { computed, ref } from "vue";
import Crest from "./Crest.vue";
import type { TournamentDetailState } from "../tournaments/detail";
import { onlyMine, remainingRounds, ROUND_TONE, roundViews } from "../tournaments/detail";

const props = defineProps<{ data: Pick<TournamentDetailState, "rounds" | "fixtures" | "entrants" | "tournament"> }>();
const all = computed(() => roundViews(props.data));
const myId = computed(() => (props.data.tournament?.myDroppedAt ? "" : props.data.tournament?.myEntrantId ?? ""));
const mineIds = computed(() => new Set(props.data.fixtures
  .filter((f) => myId.value && (f.home.entrantId === myId.value || f.away?.entrantId === myId.value)).map((f) => f.id)));
const filter = ref<"all" | "mine">("all");
const rounds = computed(() => (filter.value === "mine" && myId.value ? onlyMine(all.value, props.data.fixtures, myId.value) : all.value));
const fixtureCount = computed(() => all.value.reduce((n, r) => n + r.fixtures.length, 0));
const left = computed(() => (props.data.tournament ? remainingRounds(props.data.tournament) : 0));
</script>

<template>
  <div class="tn-rounds-head">
    <p v-if="data.tournament && data.tournament.status !== 'completed'" class="hm-cap tn-left">
      {{ left === 1 ? "1 round left" : `${left} rounds left` }}
    </p>
    <div v-if="mineIds.size" class="sf-tabs small tn-filter" role="group" aria-label="Fixtures shown">
      <button type="button" class="sf-tab" :aria-pressed="filter === 'all'" @click="filter = 'all'">All fixtures</button>
      <button type="button" class="sf-tab" :aria-pressed="filter === 'mine'" @click="filter = 'mine'">My fixtures</button>
    </div>
  </div>
  <p v-if="!all.length" class="hm-empty">No rounds have been drawn yet.</p>
  <template v-else>
    <p v-if="!fixtureCount" class="hm-empty">Fixtures are shown to signed-in participants and organisers. Nothing to show here yet.</p>
    <section v-for="r in rounds" :key="r.number" class="hm-panel tn-round" :aria-labelledby="`tn-round-${r.number}-h`">
      <header class="hm-band"><h2 :id="`tn-round-${r.number}-h`">Round {{ r.number }}</h2><span class="sf-chip" :data-tone="ROUND_TONE[r.status] ?? 'muted'" :data-status="r.status">{{ r.status }}</span></header>
      <ul v-if="r.fixtures.length" class="tn-fixtures">
        <li v-for="f in r.fixtures" :key="f.id" class="tn-fixture" :class="{ 'tn-mine': mineIds.has(f.id) }" :data-played="f.played">
          <div class="tn-side tn-home">
            <Crest :url="f.home.logoUrl" />
            <span class="tn-side-text"><strong>{{ f.home.team }}</strong><span class="muted">{{ f.home.coach }}</span></span>
          </div>
          <div class="tn-score">
            <template v-if="f.played && f.away">
              <strong class="tn-score-main">{{ f.home.score }} - {{ f.away.score }}</strong>
              <span v-if="f.home.cas !== null || f.away.cas !== null" class="muted tn-score-sub">CAS {{ f.home.cas ?? 0 }} - {{ f.away.cas ?? 0 }}</span>
            </template>
            <span v-else-if="f.away" class="muted">vs</span>
            <span v-else class="muted">Bye</span>
          </div>
          <div class="tn-side tn-away">
            <template v-if="f.away">
              <span class="tn-side-text"><strong>{{ f.away.team }}</strong><span class="muted">{{ f.away.coach }}</span></span>
              <Crest :url="f.away.logoUrl" />
            </template>
          </div>
        </li>
      </ul>
    </section>
  </template>
</template>
