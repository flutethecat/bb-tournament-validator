<script setup lang="ts">
// Create a league (/app/leagues/new[?draft=<id>], registration spec 11-02 §4 (b), lane L5). Site organisers and admins
// (Q1); anyone else gets the "organisers only" note with the way to ask. Five steps in the Roster Builder's header-tab
// pattern (teleported into #sf-header-slot from 640 px): Identity, Rules, Season 1, Connections, Review. The step pane
// sits left, the LEAGUE SUMMARY side panel right; at 1920x1080 the page never scrolls (design.md §6), the panes do.
// Every Next saves its step to the server (the first one creates the draft league); Create league finishes the wizard and
// the league stays a draft until Publish in League settings.
import { computed, inject, onBeforeUnmount, onMounted, provide, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { usePageTitle } from "../shell/pageTitle";
import LeagueWizardConnections from "../components/LeagueWizardConnections.vue";
import LeagueWizardIdentity from "../components/LeagueWizardIdentity.vue";
import LeagueWizardReview from "../components/LeagueWizardReview.vue";
import LeagueWizardRules from "../components/LeagueWizardRules.vue";
import LeagueWizardSeason from "../components/LeagueWizardSeason.vue";
import LeagueWizardSummary from "../components/LeagueWizardSummary.vue";
import { canCreateLeague, createLeagueWizard, LEAGUE_WIZARD_KEY, stepIndex, WIZARD_STEPS } from "../leagues/wizard";
import "../leagues/leagues.css";
import "../leagues/wizard.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const wizard = inject(LEAGUE_WIZARD_KEY, null) ?? createLeagueWizard({ api: fetcher });
provide(LEAGUE_WIZARD_KEY, wizard);
const { state } = wizard;

const allowed = computed(() => canCreateLeague(session.state.info));
const current = computed(() => WIZARD_STEPS[stepIndex(state.step)]!);
const last = computed(() => state.step === "review");
const draftId = computed(() => (typeof route.query.draft === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(route.query.draft) ? route.query.draft : ""));

// Step tabs in the shell header from 640 px (after mount), like the Roster Builder; inline below that.
const inHeader = ref(false);
let narrowMq: MediaQueryList | null = null;
const placeTabs = (): void => {
  inHeader.value = !narrowMq?.matches && Boolean(typeof document !== "undefined" && document.getElementById("sf-header-slot"));
};
onMounted(async () => {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    narrowMq = window.matchMedia("(max-width: 639.98px)");
    narrowMq.addEventListener?.("change", placeTabs);
    placeTabs();
  }
  await session.load();
  if (!state.loaded || (draftId.value && state.draft?.id !== draftId.value)) await wizard.start(draftId.value || undefined);
});
onBeforeUnmount(() => { narrowMq?.removeEventListener?.("change", placeTabs); narrowMq = null; });
usePageTitle(() => "Create a league");

async function next(): Promise<void> {
  const firstSave = !state.draft;
  if (!(await wizard.next())) return;
  // The draft has an address now: a refresh or a later visit picks it back up.
  if (firstSave && state.draft) void router.replace({ query: { draft: state.draft.id } });
}
async function create(): Promise<void> {
  if (await wizard.create()) void router.push({ name: "league-detail", params: { id: state.draft!.id } });
}
const leave = (): void => { if (state.draft) void router.push({ name: "league-detail", params: { id: state.draft.id } }); };
</script>

<template>
  <div class="hm-page lw-page" :class="{ 'lw-fit sf-fit': allowed && state.loaded && !state.error }">
    <Teleport to="#sf-header-slot" :disabled="!inHeader">
      <ol v-if="allowed" class="lw-steps" :class="{ 'lw-steps-header': inHeader }" aria-label="Create a league: steps">
        <li v-for="s in WIZARD_STEPS" :key="s.id">
          <button
            type="button" class="lw-step" :data-step="s.id" :aria-current="state.step === s.id ? 'step' : undefined" :disabled="!wizard.canGo(s.id) || Boolean(state.busy)"
            @click="wizard.go(s.id)"
          ><span class="lw-step-n">{{ s.n }}</span>{{ s.label }}</button>
        </li>
      </ol>
    </Teleport>

    <section v-if="session.state.status === 'ready' && !allowed" class="hm-panel" aria-labelledby="lw-denied-h">
      <header class="hm-band"><h2 id="lw-denied-h">Organisers only</h2></header>
      <p class="lw-pad">Site organisers and admins create leagues. Ask to become an organiser and an admin will answer.</p>
      <p class="lw-pad"><RouterLink class="sf-btn" to="/organiser/request">Ask to become an organiser</RouterLink></p>
    </section>
    <p v-else-if="state.error && !state.loaded" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.loaded" class="hm-empty" role="status">Loading...</p>
    <template v-else>
      <div class="lw-grid sf-fill">
        <section class="hm-panel lw-pane" :aria-labelledby="`lw-h-${state.step}`">
          <header class="hm-band">
            <h2 :id="`lw-h-${state.step}`">{{ current.label }}</h2>
            <span class="hm-cap">Step {{ current.n }} of {{ WIZARD_STEPS.length }}<template v-if="state.draft"> · Draft<template v-if="state.draft.test"> · Test</template></template></span>
          </header>
          <div class="lw-pane-body">
            <LeagueWizardIdentity v-if="state.step === 'identity'" />
            <LeagueWizardRules v-else-if="state.step === 'rules'" />
            <LeagueWizardSeason v-else-if="state.step === 'season'" />
            <LeagueWizardConnections v-else-if="state.step === 'connections'" />
            <LeagueWizardReview v-else />
          </div>
          <footer class="lw-foot">
            <button class="sf-btn" type="button" :disabled="state.step === 'identity' || Boolean(state.busy)" @click="wizard.back()">Back</button>
            <p v-if="state.error" class="sf-error lw-msg" role="alert">{{ state.error }}</p>
            <p v-else-if="state.notice" class="sf-notice lw-msg" role="status">{{ state.notice }}</p>
            <span v-else class="lw-msg"></span>
            <template v-if="last">
              <button class="sf-btn" type="button" :disabled="!state.draft || Boolean(state.busy)" @click="leave">Save draft</button>
              <button class="sf-btn primary" type="button" :disabled="!state.draft || Boolean(state.busy)" @click="create">Create league</button>
            </template>
            <button v-else class="sf-btn primary" type="button" :disabled="Boolean(state.busy)" @click="next">{{ state.busy ? "Saving..." : "Next" }}</button>
          </footer>
        </section>
        <LeagueWizardSummary />
      </div>
    </template>
  </div>
</template>
