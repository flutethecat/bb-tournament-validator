<script lang="ts">
import type { TournamentBuilder as KeptBuilder, BuilderTab as KeptTab } from "../teams/builder";
/** Page-session handoff: the shell keys RouterView by path, so when this page moves its own address (a save gets its
 *  /<saveId>, a new ruleset or race leaves it) the view remounts. The outgoing view leaves its controller and tab here,
 *  addressed to the path it navigates to; only the mount at that path, straight after, takes them. */
type Handoff = { builder: KeptBuilder; tab: KeptTab; path: string; at: number };
let handoff: Handoff | null = null;
const HANDOFF_MS = 5000;
/** Take the handoff addressed to `path` (consumed either way). */
function takeHandoff(path: string): Handoff | null {
  const h = handoff;
  handoff = null;
  return h && h.path === path && Date.now() - h.at < HANDOFF_MS ? h : null;
}
function leaveHandoff(h: Handoff): void { handoff = h; }
</script>

<script setup lang="ts">
// Tournament Builder (/app/tournament-team-builder[/:saveId], owner 10-30): the coach-facing team builder against a
// tournament ruleset, migrated from public/tournament-team-builder.html (which keeps serving unchanged). Design: the
// shell's left nav, a top row of band tabs (Ruleset · Roster · Sheet) and a centred pane of bezel-and-lift panels. The
// Roster tab is the one working pane: three columns on desktop (left: an accordion of hireable players, sideline staff,
// inducements and star players; centre: the roster table; right: team controls with the skill-pack list or the save line
// in their footer, the validator), stacked in that order on a phone. Browsing and building are public, as on the vanilla page (the preview runs as a
// guest); saving, sharing and creating on the Fork need the Discord session. Deep links: /:saveId (or ?save=) opens a
// saved team, ?package=<name>[&race=<rosterId>] preselects the ruleset (and race). League mode (registration spec 11-02, lane L7):
// ?league=<id>&season=<id>[&race=] builds under that league season's team-building rules (the Ruleset tab becomes the league's
// rules and race picker; a save keeps the league season with the team).
import { computed, inject, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import "../../../public/team-view.css";
import "../teams/teams.css";
import "../teams/builder.css";
import { API_KEY } from "../app";
import { discordLoginUrl, SESSION_KEY } from "../session";
import { fmtK } from "../shared/format";
import {
  BUILDER_TABS, createTournamentBuilder, SAVE_ID_RE, TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY, toBuilderTab, type BuilderTab, type TournamentBuilder,
  type TournamentBuilderUi,
} from "../teams/builder";
import TournamentBuilderRuleset from "../components/TournamentBuilderRuleset.vue";
import TournamentBuilderAccordion from "../components/TournamentBuilderAccordion.vue";
import TournamentBuilderRoster from "../components/TournamentBuilderRoster.vue";
import TournamentBuilderTeam from "../components/TournamentBuilderTeam.vue";
import TournamentBuilderValidator from "../components/TournamentBuilderValidator.vue";
import TournamentBuilderSheet from "../components/TournamentBuilderSheet.vue";
import TournamentBuilderLeague from "../components/TournamentBuilderLeague.vue";
import { leaguePackageName, parseLeaguePackageName } from "../../../src/leagueBuilderMarker";

const props = defineProps<{ saveId?: string }>();
const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const taken = takeHandoff(route.path);
const builder: TournamentBuilder = inject(TOURNAMENT_BUILDER_KEY, null) ?? taken?.builder ?? createTournamentBuilder({
  api: fetcher,
  coach: () => session.coach(),
  organizer: () => session.state.info?.organizer === true,
  onSignedOut: () => void session.load(true),
  print: printFallback,
});
provide(TOURNAMENT_BUILDER_KEY, builder);
const { state } = builder;
/** The name gate: hiring a player or a star needs a named team. The message shows in the save line's issues list until the
 *  team is named, and focus goes to the team name field in the Team controls. `added` tells the roster a hire landed. */
const ui: TournamentBuilderUi = reactive({
  nameGate: false,
  requireName(): boolean {
    if (builder.named()) return true;
    ui.nameGate = true;
    if (typeof document !== "undefined") document.getElementById("tb-team-name")?.focus();
    return false;
  },
  added: 0,
  noteAdded(): void { ui.added += 1; },
  packPicking: false,
  pickingPack(): boolean { return Boolean(builder.raceRules()?.packs.length) && (!state.skillPack || ui.packPicking); },
});
provide(TOURNAMENT_BUILDER_UI_KEY, ui);
watch(() => builder.named(), (named) => { if (named) ui.nameGate = false; });

const asked = toBuilderTab(route.query.tab);
const tab = ref<BuilderTab>(taken ? taken.tab : asked && (asked === "ruleset" || state.roster) ? asked : state.roster ? "roster" : "ruleset");
/** Move this page's own address, handing the controller to the remount the shell makes for the new path. */
function moveTo(saveId: string): void {
  const target = router.resolve({ name: "tournament-team-builder", params: { saveId }, query: saveId ? {} : route.query });
  leaveHandoff({ builder, tab: tab.value, path: target.path, at: Date.now() });
  void router.replace(target);
}
/** Print fallback: html.tb-printing scopes the print rule to the builder's sheet host only while printing. */
function printFallback(): void {
  if (typeof window === "undefined") return;
  window.setTimeout(() => {
    const root = document.documentElement;
    root.classList.add("tb-printing");
    // Afterwards the host (and its A4 @page rule) goes, so later prints of this page are unaffected.
    const done = (): void => { root.classList.remove("tb-printing"); window.removeEventListener("afterprint", done); state.printHtml = ""; };
    window.addEventListener("afterprint", done);
    try { window.print(); } finally { window.setTimeout(done, 1000); }
  }, 0);
}
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
const lockedLine = computed(() => [builder.rulesetLabel(), state.roster?.raceName, builder.tierLabel(), state.roster && builder.capped() ? `TV cap ${fmtK(builder.totals().budget)}` : "", builder.ignoring() ? "In-game limits ignored" : ""].filter(Boolean).join(" · "));
const signInHref = computed(() => discordLoginUrl(route.fullPath.startsWith("/") ? `/app${route.fullPath}` : "/app/tournament-team-builder"));

/** League mode's deep link (?league=<id>&season=<id>), when both ids are valid. */
const leagueLink = computed(() => parseLeaguePackageName(leaguePackageName(String(route.query.league ?? ""), String(route.query.season ?? ""))));
/** The league line over the pane: "<League> · Season N · rules", linking back to the league. */
const leagueLine = computed(() => (builder.leagueMode() && state.leagueCtx ? state.leagueCtx : null));
/** The save id in the address bar: the route param, else the vanilla page's ?save= deep link. */
const linkedSave = computed(() => {
  const id = props.saveId ?? (typeof route.query.save === "string" ? route.query.save : "");
  return id && SAVE_ID_RE.test(id) ? id : "";
});
// Where the step tabs go (owner 10-31): the shell header from 640 px (after mount, so server rendering keeps them inline);
// below 640 px nowhere.
const inHeader = ref(false);
const phone = ref(false);
let narrowMq: MediaQueryList | null = null;
function placeTabs(): void {
  const narrow = Boolean(narrowMq?.matches);
  phone.value = narrow;
  inHeader.value = !narrow && Boolean(typeof document !== "undefined" && document.getElementById("sf-header-slot"));
}
onMounted(() => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  narrowMq = window.matchMedia("(max-width: 639.98px)");
  narrowMq.addEventListener?.("change", placeTabs);
  placeTabs();
});
onBeforeUnmount(() => { narrowMq?.removeEventListener?.("change", placeTabs); narrowMq = null; });
onBeforeUnmount(() => { if (typeof document !== "undefined") document.documentElement.classList.remove("tb-printing"); });
onMounted(async () => {
  await session.load();
  if (taken) return; // the same page session, picked back up after this page moved its address
  const opened = await builder.init({
    saveId: linkedSave.value || undefined,
    packageName: typeof route.query.package === "string" ? route.query.package : typeof route.query.preset === "string" ? route.query.preset : undefined,
    race: typeof route.query.race === "string" ? route.query.race : undefined,
    league: leagueLink.value ?? undefined,
  });
  // Loading has finished: the asked tab (old ids already mapped, e.g. ?tab=stars -> roster) wins when the page can show it,
  // else the tab init picked. Before this the roster was not loaded, so the first guess fell back to Ruleset.
  tab.value = asked && (asked === "ruleset" || ready.value) ? asked : opened;
});
// Saving gives the team its own address (/tournament-team-builder/<saveId>); the old ?save= link is replaced by it.
watch(() => state.currentSave?.id, (id) => {
  if (id && id !== props.saveId) moveTo(id);
  else if (!id && props.saveId) moveTo("");
});
watch(() => props.saveId, (id) => {
  if (id && id !== state.currentSave?.id && SAVE_ID_RE.test(id)) void builder.loadSave(id).then((ok) => { if (ok) tab.value = "roster"; });
});
// A new ruleset or race sends the coach to the matching tab; a race picked on the Ruleset tab opens the Roster tab.
async function pickRace(rosterId: string): Promise<void> {
  if (state.roster && state.roster.rosterId !== rosterId && state.slots.length && typeof window !== "undefined" && !window.confirm("Discard the current roster and start over?")) return;
  if (await builder.chooseRace(rosterId)) { tab.value = "roster"; scrollToTop(); }
}
/** The next screen opens at its top: the page (and the shell's scrolling main, when it is the scroller) goes back to 0. */
function scrollToTop(): void {
  if (typeof window === "undefined") return;
  void nextTick(() => {
    window.scrollTo?.({ top: 0 });
    document.querySelector("main")?.scrollTo?.({ top: 0 });
    document.getElementById("tb-tab-roster")?.focus({ preventScroll: true });
  });
}
async function pickPackage(name: string): Promise<void> {
  if (name !== state.packageName && state.slots.length && typeof window !== "undefined" && !window.confirm("Discard the current roster and start over?")) return;
  await builder.choosePackage(name);
}
</script>

<template>
  <div class="hm-page tm-page tb-page sf-fit" :class="{ 'tb-wide': tab === 'roster' || tab === 'ruleset' }">
    <!-- The step tabs live in the shell header (owner 10-31) once mounted on a screen 640 px and wider; until then (and in
         server rendering) they render here. Phones get no tabs at all: the summary bar below returns to Ruleset. -->
    <Teleport to="#sf-header-slot" :disabled="!inHeader">
      <div v-if="!phone" ref="tabsEl" class="tl-seg tb-tabs" :class="{ 'tb-tabs-header': inHeader }" role="tablist" aria-label="Roster Builder steps" @keydown="onTabKey">
        <button
          v-for="t in BUILDER_TABS" :id="`tb-tab-${t.id}`" :key="t.id" type="button" role="tab" class="tl-seg-btn" :data-tab="t.id"
          :aria-selected="tab === t.id ? 'true' : 'false'" :aria-controls="`tb-pane-${t.id}`" :tabindex="tab === t.id ? 0 : -1"
          :disabled="t.id !== 'ruleset' && !ready" @click="go(t.id)"
        >{{ t.label }}</button>
      </div>
    </Teleport>

    <!-- league mode: the full league line on the Ruleset tab; the Roster and Sheet tabs keep only the locked line (with a League chip) so
         the Roster pane still fits 1920x1080 without page scroll (design.md §6) -->
    <p v-if="leagueLine && (tab === 'ruleset' || !ready)" class="tb-league-line">
      <span class="sf-chip" data-tone="info">League</span>
      <RouterLink :to="`/leagues/${encodeURIComponent(leagueLine.league.id)}`">{{ leagueLine.label }} · rules</RouterLink>
    </p>
    <button v-if="ready && phone && tab !== 'ruleset'" type="button" class="tb-locked tb-locked-btn" aria-label="Change ruleset or race" @click="go('ruleset')">
      <img v-if="crest" class="tb-locked-crest" :src="crest" alt="" aria-hidden="true" />
      <span v-if="leagueLine" class="sf-chip" data-tone="info">League</span>
      <span>{{ lockedLine }}</span>
    </button>
    <p v-else-if="ready" class="tb-locked">
      <img v-if="crest" class="tb-locked-crest" :src="crest" alt="" aria-hidden="true" />
      <span v-if="leagueLine" class="sf-chip" data-tone="info">League</span>
      <span>{{ lockedLine }}</span>
    </p>

    <p v-if="state.bootError" class="lobby-error" role="alert">{{ state.bootError }}</p>
    <p v-else-if="!state.booted" class="hm-empty" role="status">Loading rulesets...</p>
    <p v-if="state.status" :class="state.statusError ? 'lobby-error' : 'hm-empty'" role="status">{{ state.status }}</p>

    <div v-if="state.booted" :id="`tb-pane-${tab}`" class="tb-pane sf-fill" role="tabpanel" :aria-labelledby="`tb-tab-${tab}`">
      <TournamentBuilderLeague v-if="tab === 'ruleset' && builder.leagueMode()" @race="pickRace" @next="go('roster')" />
      <TournamentBuilderRuleset v-else-if="tab === 'ruleset'" @package="pickPackage" @race="pickRace" @next="go('roster')" />
      <div v-else-if="tab === 'roster'" class="tb-work">
        <!-- Source order is the phone reading order: the left accordion (hireable players, sideline staff, inducements, star
             players), the roster, team controls (with the skill-pack list or the save line), the validator. Desktop places the
             three groups as columns (left 1 : centre 2 : right 1.3). -->
        <div class="tb-col tb-col-left">
          <TournamentBuilderAccordion />
        </div>
        <div class="tb-col tb-col-centre">
          <TournamentBuilderRoster />
        </div>
        <div class="tb-col tb-col-right">
          <TournamentBuilderTeam :sign-in-href="signInHref" :sso-enabled="session.ssoEnabled()" />
          <TournamentBuilderValidator />
        </div>
      </div>
      <TournamentBuilderSheet v-else />
    </div>

    <!-- Print fallback (Export PDF unavailable): only this sheet prints. -->
    <section v-if="state.printHtml" class="tb-print-host" aria-hidden="true" v-html="state.printHtml"></section>
  </div>
</template>
