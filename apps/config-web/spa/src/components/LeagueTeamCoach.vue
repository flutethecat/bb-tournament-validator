<script setup lang="ts">
// League page, Teams tab, a team's roster, organisers and site admins: Assign coach account. A coach lookup against the
// identities (the Administration tab's lookup) sets the team's coach account for this season, or for every season of
// the team (same team id); the server also seats it on the team's unplayed fixtures and logs it on the season. Used to
// put a fork account on an imported team for a test league game.
import { computed, inject, ref, watch } from "vue";
import { LEAGUE_DETAIL_KEY } from "../leagues/league";
import type { LeagueTeam, SeasonRecord } from "../leagues/types";

const props = defineProps<{ season: SeasonRecord; team: LeagueTeam }>();
const detail = inject(LEAGUE_DETAIL_KEY)!;
const { state } = detail;
const key = computed(() => `coach:${props.team.id}`);
const busy = computed(() => state.editBusy === key.value);
const mine = ref(false);
const name = ref(props.team.coachId ?? "");
const allSeasons = ref(false);
const hits = ref<string[]>([]);
watch(() => `${props.season.id}|${props.team.id}|${props.team.coachId ?? ""}`, () => { name.value = props.team.coachId ?? ""; });
const listId = computed(() => `lg-coach-hits-${props.team.id}`);
const unchanged = computed(() => name.value.trim().toLowerCase() === (props.team.coachId ?? "").trim().toLowerCase());

async function lookup(): Promise<void> { hits.value = await detail.lookupCoaches(name.value); }
async function save(): Promise<void> {
  const want = name.value.trim();
  if (!want || unchanged.value) return;
  mine.value = true;
  await detail.assignCoach(props.season.id, props.team.id, want, allSeasons.value);
}
async function clear(): Promise<void> {
  mine.value = true;
  await detail.assignCoach(props.season.id, props.team.id, null, allSeasons.value);
}
</script>

<template>
  <form class="lg-assign" data-assign-coach novalidate @submit.prevent="save">
    <div class="ls-inline">
      <label class="ls-field">
        <span>Assign coach account</span>
        <input v-model="name" type="text" maxlength="40" autocomplete="off" placeholder="Coach name" :list="listId" :disabled="busy" @input="lookup" />
      </label>
      <label class="ls-check"><input v-model="allSeasons" type="checkbox" :disabled="busy" /> All seasons of this team</label>
      <div class="ls-actions">
        <button class="sf-btn primary" type="submit" :disabled="busy || !name.trim() || unchanged">Assign</button>
        <button v-if="team.coachId" class="sf-btn" type="button" :disabled="busy" @click="clear">Clear</button>
      </div>
    </div>
    <datalist :id="listId"><option v-for="h in hits" :key="h" :value="h" /></datalist>
    <p class="hm-small hm-empty">
      <template v-if="team.coachId">Account: <strong>{{ team.coachId }}</strong><template v-if="team.coachAssigned"> (assigned by {{ team.coachAssigned.by }})</template>.</template>
      <template v-else>No Super FUMBBL account linked.</template>
      The account is seated on this team's fixtures without a result.
    </p>
    <p v-if="mine && state.editError" class="sf-error" role="alert">{{ state.editError }}</p>
    <p v-else-if="mine && state.editNotice" class="hm-notice" role="status">{{ state.editNotice }}</p>
  </form>
</template>
