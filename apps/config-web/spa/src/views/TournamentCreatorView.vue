<script setup lang="ts">
// Tournament Creator (/app/tournament-creator?package=<name>&tab=, ?new=1 for an unsaved document): the organiser's ruleset-package editor, migrated
// from the vanilla page (public/tournament-rules.html keeps serving). The shell's side nav on the left; a package shelf,
// a top row of tabs in the Tournaments band style, and one centred working pane under them. Organisers and site admins
// only (the server's package-write gate); anyone else gets the friendly "not one of yours" note. The packages it saves
// (tournament-packages/*.json) are what the Tournament Builder's ruleset table reads.
import { computed, inject, onMounted, provide, ref, watch } from "vue";
import { usePageTitle } from "../shell/pageTitle";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import CreatorAdvanced from "../components/CreatorAdvanced.vue";
import CreatorInducements from "../components/CreatorInducements.vue";
import CreatorOverview from "../components/CreatorOverview.vue";
import CreatorPreview from "../components/CreatorPreview.vue";
import CreatorSkills from "../components/CreatorSkills.vue";
import CreatorStars from "../components/CreatorStars.vue";
import CreatorTeamRules from "../components/CreatorTeamRules.vue";
import CreatorTiers from "../components/CreatorTiers.vue";
import {
  CREATOR_TABS, createTournamentCreator, creatorAllowed, creatorDocQuery, isCreatorTab, syncCreatorToQuery, TOURNAMENT_CREATOR_KEY, type CreatorTab,
} from "../tournaments/creator";
import "../tournaments/creator.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
// One route record, the package in the query (?package=<name>, ?new=1 for an unsaved document): the shell keys the
// RouterView by path, so switching packages, New blank, Duplicate and presets keep this instance and its controller.
const creator = inject(TOURNAMENT_CREATOR_KEY, null) ?? createTournamentCreator({ api: fetcher, onSignedOut: () => void session.load(true) });
provide(TOURNAMENT_CREATOR_KEY, creator);
const { state } = creator;

const allowed = computed(() => session.signedIn() && creatorAllowed(session.state.info));
const tab = computed<CreatorTab>(() => (isCreatorTab(route.query.tab) ? route.query.tab : "overview"));
const docQuery = computed(() => creatorDocQuery(route.query));
const here = (t: CreatorTab = tab.value) => ({ name: "tournament-creator", query: { ...docQuery.value, ...(t === "overview" ? {} : { tab: t }) } });
const withTab = (doc: Record<string, string>) => ({ name: "tournament-creator", query: { ...doc, ...(tab.value === "overview" ? {} : { tab: tab.value }) } });
const title = computed(() => (state.pkg?.name?.trim() ? state.pkg.name : state.selected || "New package"));
const dirty = computed(() => creator.dirty());
const presetPick = ref("");

/** Bring the editor in line with the URL (see syncCreatorToQuery); a first visit with no package lands on one. */
async function sync(): Promise<void> {
  if (!state.loaded) return;
  const landOn = await syncCreatorToQuery(creator, route.query);
  if (landOn) await router.replace(withTab({ package: landOn }));
}

onMounted(async () => {
  if (!allowed.value) return;
  if (!state.loaded) await creator.init();
  await sync();
});
watch(() => [route.query.package, route.query.new], () => void sync());

const goUnsaved = (): void => void router.push(withTab({ new: "1" }));
function newBlank(): void { creator.newBlank(); goUnsaved(); }
function duplicate(): void { creator.duplicate(); goUnsaved(); }
function pickPreset(e: Event): void {
  const id = (e.target as HTMLSelectElement).value;
  presetPick.value = "";
  if (id && creator.loadPreset(id)) goUnsaved();
}
async function save(): Promise<void> {
  await creator.save();
  if (state.selected && state.selected !== route.query.package && !state.conflict) await router.replace(withTab({ package: state.selected }));
}
function reload(): void { if (state.selected) void creator.open(state.selected); }
usePageTitle(() => (allowed.value && state.pkg ? `Tournament Creator · ${title.value}` : ""));
</script>

<template>
  <div class="hm-page cr-page">
    <RouterLink class="tn-back" to="/tournaments">All tournaments</RouterLink>

    <section v-if="!allowed" class="hm-panel" aria-labelledby="cr-denied-h">
      <header class="hm-band"><h2 id="cr-denied-h">Not one of yours</h2></header>
      <p>The Tournament Creator is for tournament organisers and site admins: only they can create and change ruleset packages.</p>
      <p class="hm-links"><RouterLink to="/tournaments">Back to the tournaments</RouterLink></p>
    </section>
    <p v-else-if="state.loadError" class="lobby-error" role="alert">{{ state.loadError }}</p>
    <p v-else-if="!state.loaded || !state.pkg" class="hm-empty" role="status">Loading the Tournament Creator...</p>
    <template v-else>
      <section class="hm-panel cr-shelf" aria-labelledby="cr-shelf-h">
        <header class="hm-band"><h2 id="cr-shelf-h">Tournament packages</h2><span class="hm-cap">{{ state.packageNames.length }} saved</span></header>
        <ul v-if="state.packageNames.length" class="cr-cards" aria-label="Saved packages">
          <li v-for="name in state.packageNames" :key="name">
            <RouterLink
              class="cr-card" :aria-current="name === state.selected ? 'page' : undefined"
              :to="withTab({ package: name })"
            >{{ name }}</RouterLink>
          </li>
        </ul>
        <p v-else class="hm-empty">No saved packages yet.</p>
        <div class="cr-row">
          <label class="cr-field cr-inline">
            <span class="cr-label">New from preset</span>
            <select :value="presetPick" aria-label="New from preset" @change="pickPreset">
              <option value="">—</option>
              <option v-for="p in state.presets" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </label>
          <button type="button" class="cr-btn" @click="newBlank">New blank package</button>
          <button type="button" class="cr-btn" :disabled="state.busy" @click="duplicate">Duplicate</button>
        </div>
      </section>

      <nav class="tl-seg cr-tabs" aria-label="Package editor sections">
        <RouterLink
          v-for="(t, i) in CREATOR_TABS" :key="t.id" class="tl-seg-btn" :aria-current="tab === t.id ? 'page' : undefined" :to="here(t.id)" replace
        ><b class="cr-num">{{ i + 1 }}</b>{{ t.label }}</RouterLink>
      </nav>

      <section class="hm-panel cr-actions" aria-labelledby="cr-actions-h">
        <header class="hm-band" :data-tone="state.problems.length ? 'admin' : undefined">
          <h2 id="cr-actions-h">{{ state.selected ? "Saved package" : "Unsaved package" }}</h2>
          <span class="hm-cap">{{ dirty ? "Unsaved changes" : state.selected ? "No changes" : "Not saved yet" }}</span>
        </header>
        <p v-if="state.readOnly" class="cr-notice" role="status">{{ state.readOnly }}</p>
        <div v-if="state.conflict" class="cr-problems" role="alert">
          <strong>Changed on the server</strong>
          <p>{{ state.conflict }}</p>
          <button type="button" class="cr-btn" @click="reload">Reload from the server</button>
        </div>
        <div class="cr-row">
          <button type="button" class="cr-btn primary" :disabled="state.busy || Boolean(state.readOnly)" @click="save">{{ state.busy ? "Working..." : "Save package" }}</button>
          <button type="button" class="cr-btn" :disabled="state.busy || !dirty" @click="creator.revert()">Revert</button>
          <button type="button" class="cr-btn" :disabled="state.busy" @click="creator.exportSheet()">Export printable rules sheet</button>
        </div>
        <div v-if="state.problems.length" class="cr-problems" role="alert">
          <strong>Validation: {{ state.problems.length }} problem{{ state.problems.length === 1 ? "" : "s" }}</strong>
          <ul><li v-for="(p, i) in state.problems" :key="i">{{ p }}</li></ul>
        </div>
        <p v-if="state.saved" class="hm-notice" role="status">Saved {{ state.saved.file }}: 0 problems. Coaches' teams will validate against this package.</p>
        <p v-if="state.exported" class="hm-notice" role="status">Printable rules sheet opened in a new tab.</p>
        <p v-for="n in state.catalogNotices" :key="n" class="cr-notice">{{ n }}</p>
      </section>

      <div class="cr-pane" role="region" :aria-label="`${CREATOR_TABS.find((t) => t.id === tab)?.label} section`">
        <CreatorOverview v-if="tab === 'overview'" />
        <CreatorTiers v-else-if="tab === 'tiers'" />
        <CreatorTeamRules v-else-if="tab === 'team-rules'" />
        <CreatorSkills v-else-if="tab === 'skills'" />
        <CreatorStars v-else-if="tab === 'stars'" />
        <CreatorInducements v-else-if="tab === 'inducements'" />
        <CreatorAdvanced v-else-if="tab === 'advanced'" />
        <CreatorPreview v-else />
      </div>
    </template>
  </div>
</template>
