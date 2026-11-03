<script setup lang="ts">
// Swap team (team page cog, organisers; spec-team-management-2026-11-02 "Team libraries and swaps"): the coach's library
// (Roster Builder saves, library teams, their other league teams) judged against this season by the server. Teams that
// don't fit are greyed with the reason and can't be picked. The entry keeps its standings and fixtures; only the team
// behind it changes. The server re-checks everything on Swap.
import { computed, inject, onMounted, ref } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import { API_KEY } from "../app";
import { createTeamLibrary, libraryGroups, librarySub } from "../leagues/takeover";
import "../tournaments/registration.css";
import "../leagues/takeover.css";

const props = defineProps<{ leagueId: string; seasonId: string; teamId: string; teamName: string; revision: number }>();
const emit = defineEmits<{ close: []; swapped: [] }>();
const fetcher = inject(API_KEY)!;
const lib = createTeamLibrary({ api: fetcher });
const { state } = lib;
const picked = ref("");
const groups = computed(() => libraryGroups(state.view?.items ?? []));
const choice = computed(() => state.view?.items.find((i) => i.ref === picked.value && i.ok));
const games = computed(() => state.view?.team.games ?? 0);
onMounted(() => { void lib.load(props.leagueId, props.seasonId, props.teamId); });

async function swap(): Promise<void> {
  if (!choice.value || state.busy) return;
  if (await lib.swap(props.leagueId, props.seasonId, props.teamId, choice.value.ref, props.revision)) emit("swapped");
}
</script>

<template>
  <LeagueDialog id="tk-swap-h" class="tk-swap" wide :title="`Swap ${teamName}`" :cap="state.view?.coach ? `${state.view.coach}'s teams` : ''" tag="form" :busy="state.busy" @close="emit('close')" @submit="swap">
    <p class="tr-help">
      The entry keeps its standings and fixtures{{ games ? ` (${games} ${games === 1 ? "game" : "games"} played)` : "" }}. The team you pick plays its games from now on.
    </p>
    <p v-if="state.status === 'loading' || state.status === 'idle'" class="tr-help" role="status">Loading the coach's teams...</p>
    <p v-else-if="state.status === 'error'" class="sf-error" role="alert">{{ state.error }}</p>
    <template v-else-if="state.view">
      <p v-if="state.view.block" class="sf-notice" role="status" data-swap-block>{{ state.view.block }}</p>
      <p v-if="state.view.reason" class="hm-empty">{{ state.view.reason }}</p>
      <p v-else-if="!state.view.items.length" class="hm-empty">This coach has no other teams yet.</p>
      <div v-for="g in groups" :key="g.kind" class="tk-group">
        <h3 class="tb-k">{{ g.label }} <span class="muted">({{ g.items.length }})</span></h3>
        <div class="tr-cards tk-cards" role="radiogroup" :aria-label="g.label">
          <button
            v-for="i in g.items" :key="i.ref" type="button" role="radio" class="tr-card tk-card" :data-ref="i.ref" :data-ok="i.ok ? 'true' : 'false'"
            :aria-checked="picked === i.ref ? 'true' : 'false'" :aria-disabled="i.ok ? undefined : 'true'" :disabled="!i.ok || Boolean(state.view.block)"
            @click="picked = i.ref"
          >
            <strong>{{ i.name }}</strong>
            <small>{{ librarySub(i) }}</small>
            <small v-if="!i.ok" class="tk-why" data-why>{{ i.reason }}</small>
          </button>
        </div>
      </div>
    </template>
    <p v-if="state.status === 'ok' && state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="state.busy" @click="emit('close')">Cancel</button>
      <span class="tr-foot-gap" />
      <button type="submit" class="sf-btn primary" :disabled="state.busy || !choice || Boolean(state.view?.block)" data-swap-go>{{ state.busy ? "Swapping..." : choice ? `Swap in ${choice.name}` : "Swap" }}</button>
    </template>
  </LeagueDialog>
</template>
