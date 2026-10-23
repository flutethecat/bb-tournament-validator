<script setup lang="ts">
// Tabletop (/app/tabletop): my recorded matches and the New match form.
import { inject, onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { API_KEY } from "../app";
import TeamSelect from "../components/TeamSelect.vue";
import { LIBRARY_KEY } from "../lobby/library";
import { SESSION_KEY } from "../session";
import { createTabletopList, TABLETOP_LIST_KEY, type SaveOption } from "../tabletop/list";
import type { PostMatchOption } from "../tabletop/recorder";

const session = inject(SESSION_KEY)!;
const library = inject(LIBRARY_KEY)!;
const fetcher = inject(API_KEY)!;
const router = useRouter();
const list = inject(TABLETOP_LIST_KEY, null)
  ?? createTabletopList({ api: fetcher, coach: () => session.coach(), onSignedOut: () => void session.load(true) });
const { state } = list;
const teams = library.teams;

const mySaveId = ref("");
const opponent = ref("");
const theirSaveId = ref("");
const postMatch = ref<PostMatchOption>("full");
const err = ref("");
const creating = ref(false);
const saves = ref<SaveOption[]>([]);
const looking = ref(false);
const lookedUp = ref(false);

async function onLookup(): Promise<void> {
  err.value = "";
  saves.value = [];
  theirSaveId.value = "";
  lookedUp.value = false;
  if (!opponent.value.trim()) return void (err.value = "Enter your opponent's coach name first.");
  looking.value = true;
  try {
    saves.value = await list.lookupSaves(opponent.value);
    lookedUp.value = true;
    if (saves.value.length === 1) theirSaveId.value = saves.value[0]!.id;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    looking.value = false;
  }
}

const POST_MATCH_LABELS: Record<PostMatchOption, string> = {
  none: "None (record the score only)",
  "spp-only": "SPP only",
  full: "Full post-match (SPP, winnings, fans)",
};

async function onCreate(): Promise<void> {
  err.value = "";
  if (!mySaveId.value) return void (err.value = "Pick your team first.");
  if (!opponent.value.trim()) return void (err.value = "Enter your opponent's coach name.");
  if (!theirSaveId.value.trim()) return void (err.value = "Find and pick your opponent's team.");
  creating.value = true;
  try {
    const id = await list.create({ mySaveId: mySaveId.value, opponent: opponent.value, theirSaveId: theirSaveId.value, postMatch: postMatch.value });
    await router.push({ name: "tabletop-match", params: { id } });
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    creating.value = false;
  }
}

const stateLabel = (s: string): string => (s === "recording" ? "Recording" : s === "submitted" ? "Waiting for confirmation" : s === "confirmed" ? "Confirmed" : s);

onMounted(() => {
  void library.load(session.coach());
  void list.refresh();
});
</script>

<template>
  <section class="lobby-card">
    <h2>New match</h2>
    <p class="muted">Record a tabletop game. You are home; your opponent is away.</p>
    <form class="lobby-form tt-form" @submit.prevent="onCreate">
      <label for="tt-mine">Your team</label>
      <TeamSelect id="tt-mine" v-model="mySaveId" :teams="teams" />
      <label for="tt-opp">Opponent coach</label>
      <input id="tt-opp" v-model="opponent" type="text" @input="lookedUp = false" maxlength="40" autocomplete="off" placeholder="Coach name" />
      <label for="tt-theirs">Their team</label>
      <button class="lobby-btn tt-tap" type="button" :disabled="looking" @click="onLookup">Find their teams</button>
      <select id="tt-theirs" v-model="theirSaveId" aria-label="Their team">
        <option value="">{{ lookedUp ? (saves.length ? "Pick their team" : "No saved teams found") : "Find their teams first" }}</option>
        <option v-for="sv in saves" :key="sv.id" :value="sv.id">{{ sv.name }}</option>
      </select>
      <label for="tt-post">After the match</label>
      <select id="tt-post" v-model="postMatch">
        <option v-for="(label, key) in POST_MATCH_LABELS" :key="key" :value="key">{{ label }}</option>
      </select>
      <button class="lobby-btn primary tt-tap" type="submit" :disabled="creating">New match</button>
    </form>
    <p v-if="err" class="lobby-error" role="alert">{{ err }}</p>
  </section>

  <section class="lobby-card">
    <h2>My matches</h2>
    <div class="lobby-list">
      <p v-if="state.error" class="lobby-error" role="alert">{{ state.error }}</p>
      <template v-else-if="state.loaded">
        <p v-if="!state.matches.length" class="muted">No matches yet.</p>
        <div v-for="m in state.matches" :key="m.id" class="lobby-row">
          <RouterLink class="tt-tap-link" :to="{ name: 'tabletop-match', params: { id: m.id } }">{{ m.home.teamName }} vs {{ m.away.teamName }}</RouterLink>
          <span class="muted">{{ stateLabel(m.state) }}</span>
        </div>
      </template>
    </div>
  </section>
</template>
