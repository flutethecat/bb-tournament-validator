<script setup lang="ts">
// Rounds tab: per round, fixture rows (home team + coach, crest, score with TD / CAS sub-counts, away team + coach,
// crest; "vs" for an unplayed fixture). Read-only. The server sends fixtures only to signed-in participants and
// organisers, so an anonymous visitor sees the rounds with an empty state.
import { computed } from "vue";
import type { TournamentDetailState } from "../tournaments/detail";
import { roundViews } from "../tournaments/detail";

const props = defineProps<{ data: Pick<TournamentDetailState, "rounds" | "fixtures" | "entrants"> }>();
const rounds = computed(() => roundViews(props.data));
const fixtureCount = computed(() => rounds.value.reduce((n, r) => n + r.fixtures.length, 0));
</script>

<template>
  <p v-if="!rounds.length" class="muted">No rounds have been drawn yet.</p>
  <template v-else>
    <p v-if="!fixtureCount" class="muted">Fixtures are shown to signed-in participants and organisers. Nothing to show here yet.</p>
    <section v-for="r in rounds" :key="r.number" class="tn-round">
      <h3 class="tn-round-h">Round {{ r.number }} <span class="tn-chip" :data-status="r.status">{{ r.status }}</span></h3>
      <ul v-if="r.fixtures.length" class="tn-fixtures">
        <li v-for="f in r.fixtures" :key="f.id" class="tn-fixture" :data-played="f.played">
          <div class="tn-side tn-home">
            <img v-if="f.home.logoUrl" class="tn-crest" :src="f.home.logoUrl" alt="" loading="lazy" />
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
              <img v-if="f.away.logoUrl" class="tn-crest" :src="f.away.logoUrl" alt="" loading="lazy" />
            </template>
          </div>
        </li>
      </ul>
    </section>
  </template>
</template>
