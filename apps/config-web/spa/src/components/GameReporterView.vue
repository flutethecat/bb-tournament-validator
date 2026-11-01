<script setup lang="ts">
// The match reporter in its completed state, read-only (game page, owner 10-30: "Clicking a game should open the Match
// reporter view that we currently have but with a completed state"). The recorder's own building blocks, driven by
// games/reporter.ts from the game page's GameDetail: breadcrumb, context bar, scoreboard (final score, CAS, "Final"),
// stripbar with the timeline, the Match log, each side's finished-game summary and the Rosters popout. No rail, clock,
// turn controls, edit / undo / confirm or pre-game: nothing here writes.
import { computed, inject, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import TabletopContextBar from "./TabletopContextBar.vue";
import TabletopFeed from "./TabletopFeed.vue";
import TabletopMatchSummary from "./TabletopMatchSummary.vue";
import TabletopRosters from "./TabletopRosters.vue";
import TabletopScoreboard from "./TabletopScoreboard.vue";
import TabletopTimeline from "./TabletopTimeline.vue";
import { THEME_KEY } from "../theme";
import { routerPathOf } from "../home/shell";
import { NO_LOG_NOTE, reporterModel } from "../games/reporter";
import { editedLine, type GameDetail } from "../games/detail";
import type { MatchContext, Side } from "../tabletop/recorder";

const props = defineProps<{ game: GameDetail; backTo: string }>();

const themeCtl = inject(THEME_KEY, null);
/** The recorder's theme: dark follows the site, light draws the SNES grey look. */
const theme = computed<"dark" | "light">(() => (!themeCtl || themeCtl.state.resolved === "dark" ? "dark" : "light"));
const model = computed(() => reporterModel(props.game));
const title = computed(() => `${props.game.card.home.name} vs ${props.game.card.away.name}`);
const context = computed<MatchContext>(() => ({
  kind: props.game.summary.tournament ? "tournament" : "casual",
  title: props.game.summary.competition,
  subtitle: props.game.summary.round !== null && props.game.summary.tournament ? `Round ${props.game.summary.round}` : "",
  ...(props.game.summary.playedAt ? { startedAt: props.game.summary.playedAt } : {}),
}));
const playedOn = computed(() => {
  const t = props.game.summary.playedAt ? Date.parse(props.game.summary.playedAt) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
});
const spaPath = (href: string) => routerPathOf(href) ?? href;
const sourceNote = computed(() => model.value.sourceNote);
// an online game's replay log has no recorder behind it
const recorderHref = computed(() => (props.game.reporter && props.game.reporter.source !== "replay" ? props.game.reporter.href : ""));

/** A finished game opens at the top: the start of the match, the log reading down to the final whistle. */
const feedEl = ref<HTMLElement | null>(null);
const toTop = (): void => { if (feedEl.value) feedEl.value.scrollTop = 0; };
onMounted(toTop);
watch(() => props.game.id, toTop, { flush: "post" });

const rosters = ref(false);
const rostersSide = ref<Side | undefined>(undefined);
function openRosters(side?: Side): void { rostersSide.value = side; rosters.value = true; }
</script>

<template>
  <div class="tt-rec tt-rec--final" :data-tt-theme="theme" :data-ordered="model.ordered ? 'true' : null">
    <div class="tt-top">
      <h2 class="tt-final-h">{{ title }}</h2>
      <div class="tt-crumbs">
        <span class="tt-crumb-brand">Super FUMBBL</span>
        <RouterLink :to="backTo">Past Games</RouterLink><span aria-hidden="true">/</span>
        <span class="tt-crumb-cur">{{ title }}</span>
        <span class="tt-crumb-actions">
          <button class="tt-crumb-btn" type="button" @click="openRosters()">Rosters</button>
        </span>
      </div>
      <RouterLink class="tt-final-back" :to="backTo">&#8249; Past Games</RouterLink>
      <TabletopContextBar :context="context" />
    </div>
    <TabletopScoreboard
      :match="model.match" :teams="model.teams" :tally="model.tally" :events="model.events" :pregame="{}"
      :local-side="null" :organiser="false" :can-act="false" :inducement-icons="{}" :art="{}" :final="model.final"
      @rosters="openRosters"
    />

    <div class="tt-stripbar">
      <span class="tt-stripbar-lead">{{ playedOn || "Final" }}</span>
      <TabletopTimeline :rows="model.rows" />
      <span class="tt-stripbar-end">Final</span>
      <button class="tt-stripbar-btn" type="button" @click="openRosters()">Rosters</button>
    </div>

    <div class="tt-mid">
      <h2 class="tt-label tt-log-h">{{ model.hasLog ? model.logTitle : "Match log" }}</h2>
      <main ref="feedEl" class="tt-feed">
        <TabletopTimeline :rows="model.rows" />
        <p class="tt-match-row" data-state="published" role="status">{{ model.finalLine }}</p>
        <TabletopMatchSummary v-for="s in model.summaries" :key="s.side" :heading="s.heading" :summary="s.summary" />
        <p v-if="sourceNote" class="muted tt-final-note">{{ sourceNote }}</p>
        <p v-if="game.summary.note" class="muted tt-final-note">{{ game.summary.note }}</p>
        <p v-if="game.summary.edited" class="tt-final-note gm-edited" role="note">
          <span class="sf-chip" data-tone="soon">Edited by organiser</span> {{ editedLine(game.summary.edited) }}
        </p>
        <p v-if="game.summary.tournament || recorderHref" class="tt-final-actions">
          <RouterLink v-if="game.summary.tournament" class="sf-btn" :to="spaPath(game.summary.tournament.href)">Tournament rounds</RouterLink>
          <RouterLink v-if="recorderHref" class="sf-btn" :to="spaPath(recorderHref)">Open in the recorder</RouterLink>
        </p>
        <p v-if="!model.hasLog" class="muted tt-final-note">{{ NO_LOG_NOTE }}</p>
        <TabletopFeed v-if="model.rows.length" :rows="model.rows" :can-undo="false" />
      </main>
    </div>

    <TabletopRosters v-if="rosters" :match="model.match" :teams="model.teams" :tally="model.tally" :initial-side="rostersSide" completed @close="rosters = false" />
  </div>
</template>
