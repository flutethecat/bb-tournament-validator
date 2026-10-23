<script setup lang="ts">
// Tabletop (/app/tabletop): my recorded matches and the New match form.
import { computed, inject, onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { COACH_SEARCH_KEY, createCoachSearch } from "../tabletop/coachSearch";
import { fmtK } from "../shared/format";
import { createTabletopList, TABLETOP_LIST_KEY, teamKind, type TeamOption } from "../tabletop/list";
import type { PostMatchOption } from "../tabletop/recorder";

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const router = useRouter();
const list = inject(TABLETOP_LIST_KEY, null)
  ?? createTabletopList({ api: fetcher, coach: () => session.coach(), onSignedOut: () => void session.load(true) });
const { state } = list;
const teamLabel = (t: TeamOption): string =>
  `${t.name}${t.race || t.tv !== undefined ? ` (${[t.race, t.tv !== undefined ? `TV ${fmtK(t.tv)}` : ""].filter(Boolean).join(", ")})` : ""} · ${teamKind(t.ref)}`;

const myTeams = computed(() => state.myTeams);
const myTeamsErr = computed(() => state.myTeamsError);
const myTeam = ref("");
const opponent = ref("");
const theirTeam = ref("");
const postMatch = ref<PostMatchOption>("full");
const err = ref("");
const creating = ref(false);
const saves = ref<TeamOption[]>([]);
const looking = ref(false);
const lookedUp = ref(false);

const search = inject(COACH_SEARCH_KEY, null) ?? createCoachSearch({ api: fetcher, coach: () => session.coach() });
const sState = search.state;
const lookupErr = ref("");

function onType(text: string): void {
  opponent.value = "";
  saves.value = [];
  theirTeam.value = "";
  lookedUp.value = false;
  lookupErr.value = "";
  search.input(text);
}

async function pickCoach(name: string): Promise<void> {
  opponent.value = name;
  search.pick(name);
  saves.value = [];
  theirTeam.value = "";
  lookedUp.value = false;
  lookupErr.value = "";
  looking.value = true;
  try {
    saves.value = await list.lookupSaves(name);
    lookedUp.value = true;
    if (saves.value.length === 1) theirTeam.value = saves.value[0]!.ref;
  } catch (e) {
    lookupErr.value = (e as Error).message;
  } finally {
    looking.value = false;
  }
}

const pickFirst = (): void => { const first = sState.matches[0]; if (first) void pickCoach(first); };

const POST_MATCH_LABELS: Record<PostMatchOption, string> = {
  none: "None (record the score only)",
  "spp-only": "SPP only",
  full: "Full post-match (SPP, winnings, fans)",
};

async function onCreate(): Promise<void> {
  err.value = "";
  if (!myTeam.value) return void (err.value = "Pick your team first.");
  if (!opponent.value.trim()) return void (err.value = "Pick your opponent from the matches.");
  if (!theirTeam.value.trim()) return void (err.value = "Find and pick your opponent's team.");
  creating.value = true;
  try {
    const id = await list.create({ myTeam: myTeam.value, opponent: opponent.value, theirTeam: theirTeam.value, postMatch: postMatch.value });
    await router.push({ name: "tabletop-match", params: { id } });
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    creating.value = false;
  }
}

const fixtureErr = ref("");
async function onFixture(fixtureRef: string): Promise<void> {
  fixtureErr.value = "";
  creating.value = true;
  try {
    const id = await list.createFromFixture(fixtureRef, postMatch.value);
    await router.push({ name: "tabletop-match", params: { id } });
  } catch (e) {
    fixtureErr.value = (e as Error).message;
  } finally {
    creating.value = false;
  }
}

const stateLabel = (s: string): string => (s === "recording" ? "Recording" : s === "submitted" ? "Waiting for confirmation" : s === "confirmed" ? "Confirmed" : s);

onMounted(() => {
  void list.loadMyTeams().then(() => { if (!myTeam.value && state.myTeams.length) myTeam.value = state.myTeams[0]!.ref; });
  void list.refresh();
  void list.loadFixtures();
});
</script>

<template>
  <section class="lobby-card">
    <h2>Your fixtures</h2>
    <p v-if="state.fixturesError" class="lobby-error" role="alert">{{ state.fixturesError }}</p>
    <p v-else-if="state.fixturesLoaded && !state.fixtures.length" class="muted">No fixtures scheduled for you.</p>
    <ul v-else class="tt-fixtures">
      <li v-for="f in state.fixtures" :key="f.fixtureRef">
        <button class="lobby-btn tt-tap tt-fixture" type="button" :disabled="creating" @click="onFixture(f.fixtureRef)">
          <b>{{ f.tournament.name }}</b> round {{ f.round }}<br />
          {{ f.home.teamName ?? f.home.coach }} ({{ f.home.coach }}) vs {{ f.away.teamName ?? f.away.coach }} ({{ f.away.coach }})
        </button>
      </li>
    </ul>
    <p v-if="fixtureErr" class="lobby-error" role="alert">{{ fixtureErr }}</p>
  </section>

  <section class="lobby-card">
    <h2>Casual match</h2>
    <p class="muted">Record a tabletop game. You are home; your opponent is away.</p>
    <form class="lobby-form tt-form" @submit.prevent="onCreate">
      <label for="tt-mine">Your team</label>
      <select id="tt-mine" v-model="myTeam" aria-label="Your team">
        <option v-if="!myTeams.length" value="">No teams found</option>
        <option v-for="t in myTeams" :key="t.ref" :value="t.ref">{{ teamLabel(t) }}</option>
      </select>
      <p v-if="myTeamsErr" class="lobby-error" role="alert">{{ myTeamsErr }}</p>
      <label for="tt-opp">Opponent coach</label>
      <input
        id="tt-opp"
        :value="sState.query"
        type="text"
        maxlength="40"
        autocomplete="off"
        placeholder="Type 2 or more letters"
        role="combobox"
        aria-expanded="false"
        aria-controls="tt-opp-list"
        @input="onType(($event.target as HTMLInputElement).value)"
        @keydown.enter.prevent="pickFirst"
      />
      <ul v-if="sState.matches.length" id="tt-opp-list" class="tt-matches" role="listbox" aria-label="Matching coaches">
        <li v-for="c in sState.matches" :key="c" role="option">
          <button class="lobby-btn tt-tap tt-match" type="button" @click="pickCoach(c)">{{ c }}</button>
        </li>
      </ul>
      <p v-else-if="sState.searched" class="muted" role="status">No coaches match</p>
      <p v-if="sState.error" class="lobby-error" role="alert">{{ sState.error }}</p>
      <p v-if="opponent" class="muted" role="status">Opponent: <strong>{{ opponent }}</strong></p>
      <p v-if="lookupErr" class="lobby-error" role="alert">{{ lookupErr }}</p>
      <select id="tt-theirs" v-model="theirTeam" aria-label="Their team" :disabled="looking">
        <option value="">{{ lookedUp ? (saves.length ? "Pick their team" : "No saved teams found") : "Pick an opponent first" }}</option>
        <option v-for="t in saves" :key="t.ref" :value="t.ref">{{ teamLabel(t) }}</option>
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
    <RouterLink v-if="session.state.info?.organizer === true" class="tt-tap-link" to="/tabletop/organiser">Organiser console</RouterLink>
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
