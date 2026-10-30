<script lang="ts">
import type { TournamentBuilder as KeptBuilder, BuilderTab as KeptTab } from "../teams/builder";
// Survives one remount (see reuseKept below).
let kept: { builder: KeptBuilder } | null = null;
let keptTab: KeptTab | null = null;
</script>

<script setup lang="ts">
// Tournament Builder (/app/tournament-team-builder[/:saveId], owner 10-30): the coach-facing team builder against a
// tournament ruleset, migrated from public/tournament-team-builder.html (which keeps serving unchanged). Design: the
// shell's left nav, a top row of band tabs (Ruleset · Roster · Skills · Staff & Inducements · Sheet) and a centred
// working pane of bezel-and-lift panels. Browsing and building are public, as on the vanilla page (the preview runs as a
// guest); saving, sharing and creating on the Fork need the Discord session. Deep links: /:saveId (or ?save=) opens a
// saved team, ?package=<name>[&race=<rosterId>] preselects the ruleset (and race).
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import "../../../public/team-view.css";
import "../teams/teams.css";
import "../teams/builder.css";
import { API_KEY } from "../app";
import { discordLoginUrl, SESSION_KEY } from "../session";
import { fmtK } from "../shared/format";
import { BUILDER_TABS, createTournamentBuilder, isBuilderTab, SAVE_ID_RE, TOURNAMENT_BUILDER_KEY, type BuilderTab, type TournamentBuilder } from "../teams/builder";
import TournamentBuilderRuleset from "../components/TournamentBuilderRuleset.vue";
import TournamentBuilderRoster from "../components/TournamentBuilderRoster.vue";
import TournamentBuilderSkills from "../components/TournamentBuilderSkills.vue";
import TournamentBuilderStaff from "../components/TournamentBuilderStaff.vue";
import TournamentBuilderSheet from "../components/TournamentBuilderSheet.vue";
import TournamentBuilderValueBar from "../components/TournamentBuilderValueBar.vue";

const props = defineProps<{ saveId?: string }>();
// The shell keys RouterView by path, so saving (which moves the address to /tournament-team-builder/<saveId>) remounts
// this view: the remount picks the same controller (and tab) back up instead of reloading the save.
function reuseKept(): TournamentBuilder | null {
  const k = kept;
  kept = null;
  return k && props.saveId && k.builder.state.currentSave?.id === props.saveId ? k.builder : null;
}
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const builder = inject(TOURNAMENT_BUILDER_KEY, null) ?? reuseKept() ?? createTournamentBuilder({
  api: fetcher,
  coach: () => session.coach(),
  organizer: () => session.state.info?.organizer === true,
  onSignedOut: () => void session.load(true),
  print: () => { if (typeof window !== "undefined") window.setTimeout(() => window.print(), 0); },
});
provide(TOURNAMENT_BUILDER_KEY, builder);
const { state } = builder;

const asked = typeof route.query.tab === "string" && isBuilderTab(route.query.tab) ? route.query.tab : null;
const tab = ref<BuilderTab>(asked && (asked === "ruleset" || state.roster) ? asked : keptTab && state.roster ? keptTab : state.roster ? "roster" : "ruleset");
keptTab = null;
const ready = computed(() => Boolean(state.packageName && state.roster));
function go(t: BuilderTab): void {
  if (t !== "ruleset" && !ready.value) return;
  tab.value = t;
}
// Band tabs = a tablist: one tab stop; arrows / Home / End move between the enabled tabs.
const tabsEl = ref<HTMLElement | null>(null);
function onTabKey(e: KeyboardEvent): void {
  const enabled = BUILDER_TABS.filter((t) => t.id === "ruleset" || ready.value);
  const i = enabled.findIndex((t) => t.id === tab.value);
  const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? enabled.length - 1 : null;
  if (next === null) return;
  e.preventDefault();
  const t = enabled[(next + enabled.length) % enabled.length]!;
  go(t.id);
  tabsEl.value?.querySelector<HTMLElement>(`[data-tab="${t.id}"]`)?.focus();
}

const crest = computed(() => (state.roster ? builder.crestPath(state.roster.raceName) : ""));
const lockedLine = computed(() => [state.packageName, state.roster?.raceName, builder.tierLabel(), state.roster ? `TV cap ${fmtK(builder.totals().budget)}` : ""].filter(Boolean).join(" · "));
const signInHref = computed(() => discordLoginUrl(route.fullPath.startsWith("/") ? `/app${route.fullPath}` : "/app/tournament-team-builder"));

/** The save id in the address bar: the route param, else the vanilla page's ?save= deep link. */
const linkedSave = computed(() => {
  const id = props.saveId ?? (typeof route.query.save === "string" ? route.query.save : "");
  return id && SAVE_ID_RE.test(id) ? id : "";
});
onBeforeUnmount(() => {
  if (typeof window === "undefined") return;
  kept = { builder };
  keptTab = tab.value;
});
onMounted(async () => {
  await session.load();
  if (state.booted && props.saveId && state.currentSave?.id === props.saveId) return; // picked back up after a save
  const opened = await builder.init({
    saveId: linkedSave.value || undefined,
    packageName: typeof route.query.package === "string" ? route.query.package : typeof route.query.preset === "string" ? route.query.preset : undefined,
    race: typeof route.query.race === "string" ? route.query.race : undefined,
  });
  if (!asked || (asked !== "ruleset" && !ready.value)) tab.value = opened;
});
// Saving gives the team its own address (/tournament-team-builder/<saveId>); the old ?save= link is replaced by it.
watch(() => state.currentSave?.id, (id) => {
  if (id && id !== props.saveId) void router.replace({ name: "tournament-team-builder", params: { saveId: id } });
  else if (!id && props.saveId) void router.replace({ name: "tournament-team-builder", params: { saveId: "" }, query: route.query });
});
watch(() => props.saveId, (id) => {
  if (id && id !== state.currentSave?.id && SAVE_ID_RE.test(id)) void builder.loadSave(id).then((ok) => { if (ok) tab.value = "roster"; });
});
// A new ruleset or race sends the coach to the matching tab; a race picked on the Ruleset tab opens the Roster tab.
async function pickRace(rosterId: string): Promise<void> {
  if (state.roster && state.roster.rosterId !== rosterId && state.slots.length && typeof window !== "undefined" && !window.confirm("Discard the current roster and start over?")) return;
  if (await builder.chooseRace(rosterId)) tab.value = "roster";
}
async function pickPackage(name: string): Promise<void> {
  if (name !== state.packageName && state.slots.length && typeof window !== "undefined" && !window.confirm("Discard the current roster and start over?")) return;
  await builder.choosePackage(name);
}
</script>

<template>
  <div class="hm-page tm-page tb-page">
    <h1 class="hm-title">Tournament Builder <span v-if="state.currentSave" class="hm-led">{{ state.currentSave.name }}</span></h1>

    <div ref="tabsEl" class="tl-seg tb-tabs" role="tablist" aria-label="Tournament Builder steps" @keydown="onTabKey">
      <button
        v-for="t in BUILDER_TABS" :id="`tb-tab-${t.id}`" :key="t.id" type="button" role="tab" class="tl-seg-btn" :data-tab="t.id"
        :aria-selected="tab === t.id ? 'true' : 'false'" :aria-controls="`tb-pane-${t.id}`" :tabindex="tab === t.id ? 0 : -1"
        :disabled="t.id !== 'ruleset' && !ready" @click="go(t.id)"
      >{{ t.label }}</button>
    </div>

    <p v-if="ready" class="tb-locked">
      <img v-if="crest" class="tb-locked-crest" :src="crest" alt="" aria-hidden="true" />
      <span>{{ lockedLine }}</span>
    </p>

    <TournamentBuilderValueBar v-if="ready && tab !== 'ruleset' && tab !== 'sheet'" />

    <p v-if="state.bootError" class="lobby-error" role="alert">{{ state.bootError }}</p>
    <p v-else-if="!state.booted" class="hm-empty" role="status">Loading tournament rulesets...</p>
    <p v-if="state.status" :class="state.statusError ? 'lobby-error' : 'hm-empty'" role="status">{{ state.status }}</p>

    <div v-if="state.booted" :id="`tb-pane-${tab}`" class="tb-pane" role="tabpanel" :aria-labelledby="`tb-tab-${tab}`">
      <TournamentBuilderRuleset v-if="tab === 'ruleset'" @package="pickPackage" @race="pickRace" @next="go('roster')" />
      <TournamentBuilderRoster v-else-if="tab === 'roster'" />
      <TournamentBuilderSkills v-else-if="tab === 'skills'" />
      <TournamentBuilderStaff v-else-if="tab === 'staff'" />
      <TournamentBuilderSheet v-else :sign-in-href="signInHref" :sso-enabled="session.ssoEnabled()" />
    </div>

    <!-- Print fallback (Export PDF unavailable): only this sheet prints. -->
    <section v-if="state.printHtml" class="tb-print-host" aria-hidden="true" v-html="state.printHtml"></section>
  </div>
</template>
