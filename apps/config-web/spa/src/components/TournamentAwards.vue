<script setup lang="ts">
// Tournament Awards tab (GET /api/tournaments/:id/awards): the podium once the tournament is finished (Champion,
// Runner-up, Consolation from the final standings), then the awards organisers gave. Organisers of this tournament and
// site admins (the server sends `recipients` only to them) get Give award (the league dialog) and Remove.
import { computed, inject, onMounted, provide, ref } from "vue";
import AwardItem from "./AwardItem.vue";
import LeagueGiveAward from "./LeagueGiveAward.vue";
import { AWARD_GIVER_KEY, awardIcon } from "../leagues/honours";
import { asAwardView, asGiver, PODIUM_LABEL, TOURNAMENT_HONOURS_KEY, type TournamentAwardView } from "../tournaments/honours";
import "../leagues/honours.css";
import "../leagues/leagues.css";

const props = withDefaults(defineProps<{ id: string; writes?: boolean }>(), { writes: true });
const ctl = inject(TOURNAMENT_HONOURS_KEY)!;
provide(AWARD_GIVER_KEY, asGiver(ctl));
const { state } = ctl;
const view = computed(() => (state.id === props.id ? state.awards : null));
const manage = computed(() => Boolean(view.value?.recipients) && props.writes);
const giving = ref(false);
const confirming = ref("");
async function remove(a: TournamentAwardView): Promise<void> {
  if (confirming.value !== a.id) { confirming.value = a.id; return; }
  confirming.value = "";
  await ctl.removeAward(a.id);
}
const removeLabel = (a: TournamentAwardView): string => (state.busy === `award:${a.id}` ? "Removing..." : confirming.value === a.id ? "Confirm remove" : "Remove");
onMounted(() => void ctl.loadAwards(props.id));
</script>

<template>
  <p v-if="state.awardsStatus === 'error' && !view" class="sf-error" role="alert">{{ state.awardsError }}</p>
  <p v-else-if="!view" class="hm-empty" role="status">Loading awards...</p>
  <div v-else class="lg-stack tn-awards">
    <section class="hm-panel" aria-labelledby="tn-podium-h">
      <header class="hm-band"><h2 id="tn-podium-h">Podium</h2><span class="hm-cap">{{ view.finished ? "Final" : "In progress" }}</span></header>
      <p v-if="!view.finished" class="hm-empty">The podium fills in when the tournament finishes.</p>
      <p v-else-if="!view.podium.length" class="hm-empty">No results were recorded, so there is no podium.</p>
      <ul v-else class="lg-podium tn-podium">
        <li v-for="p in view.podium" :key="p.id" :data-slot="p.id.replace('podium-', '')" :data-award="p.title">
          <img class="tn-podium-icon" :src="awardIcon(p.icon)" alt="" width="48" height="48" />
          <span class="tn-podium-text">
            <span class="lg-award-type">{{ PODIUM_LABEL[p.id] ?? p.title }}<span v-if="p.star" class="aw-star" title="Champion"> ★</span></span>
            <strong class="tn-podium-team">{{ p.toTeam }}</strong>
            <small>{{ [p.toCoach, p.race].filter(Boolean).join(" · ") }}</small>
          </span>
        </li>
      </ul>
    </section>

    <section class="hm-panel" aria-labelledby="tn-aw-h">
      <header class="hm-band"><h2 id="tn-aw-h">Awards</h2><span class="hm-cap">({{ view.awards.length }})</span></header>
      <div v-if="manage" class="aw-tools">
        <button type="button" class="sf-btn primary small" :disabled="Boolean(state.busy)" @click="giving = true">Give award</button>
      </div>
      <p v-if="state.notice && !giving" class="sf-notice aw-status" role="status">{{ state.notice }}</p>
      <p v-if="state.writeError && !giving" class="sf-error aw-status" role="alert">{{ state.writeError }}</p>
      <p v-if="!view.awards.length" class="hm-empty">No awards given yet.</p>
      <ul v-else class="aw-list" aria-label="Awards">
        <AwardItem v-for="a in view.awards" :key="a.id" :award="asAwardView(a)">
          <template v-if="manage" #default><button
            type="button" class="sf-btn small" :class="{ danger: confirming === a.id }" :disabled="Boolean(state.busy)"
            :aria-label="confirming === a.id ? `Confirm: remove ${a.title}` : `Remove ${a.title}`" @click="remove(a)"
          >{{ removeLabel(a) }}</button></template>
        </AwardItem>
      </ul>
      <LeagueGiveAward v-if="giving" scope="tournament" @close="giving = false" />
    </section>
  </div>
</template>
