<script setup lang="ts">
// League settings, Administration (lane L5): the league's visibility (Publish a draft) and each open season's stage
// (Open registration, Start season, Close registration). POST /api/leagues/:id/publish and .../seasons/:id/stage; the
// server decides (lifecycle.ts canMoveStage) and the page reloads the settings after each action.
import { computed, inject, ref } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { LEAGUE_SETTINGS_KEY } from "../leagues/settings";
import { SEASON_STAGE_LABEL, seasonStageOf, stageActions, STAGE_TONE } from "../leagues/lifecycle";
import type { SeasonSummary } from "../leagues/types";
import LeagueDialog from "./LeagueDialog.vue";
import "../leagues/wizard.css";

const fetcher = inject(API_KEY)!;
const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const draft = computed(() => state.league?.visibility === "draft");
const open = computed(() => state.seasons.filter((s) => s.status !== "completed"));
const busy = ref("");
const error = ref("");
const notice = ref("");
const confirmPublish = ref(false);
const base = (): string => `/api/leagues/${encodeURIComponent(state.id)}`;

async function run(key: string, task: () => Promise<unknown>, done: string): Promise<void> {
  busy.value = key;
  error.value = "";
  notice.value = "";
  try {
    await task();
    await settings.load(state.id);
    notice.value = done;
  } catch (err) {
    error.value = err instanceof Error && err.message ? err.message : "That did not work.";
  } finally {
    busy.value = "";
  }
}
const publish = (): Promise<void> => { confirmPublish.value = false; return run("publish", () => fetcher(`${base()}/publish`, { method: "POST", body: {} }), "Published. Everyone can see the league now."); };
const move = (s: SeasonSummary, stage: "setup" | "registration" | "active", label: string): Promise<void> =>
  run(`${s.id}:${stage}`, () => fetcher(`${base()}/seasons/${encodeURIComponent(s.id)}/stage`, { method: "POST", body: { stage } }), `${s.name}: ${label.toLowerCase()} done.`);
</script>

<template>
  <section class="hm-panel" aria-labelledby="ls-life-h">
    <header class="hm-band"><h2 id="ls-life-h">Visibility and stage</h2><span class="hm-cap">{{ draft ? "Draft" : "Published" }}</span></header>
    <div class="ls-life">
      <div class="ls-life-row">
        <p v-if="draft" class="ls-life-text">
          <span class="sf-chip" data-tone="muted">Draft</span>
          Only the league's organisers and site admins can see it.
          <RouterLink :to="{ name: 'league-new', query: { draft: state.id } }">Back to the setup steps</RouterLink>
        </p>
        <p v-else class="ls-life-text"><span class="sf-chip" data-tone="ok">Published</span> Everyone can see the league.</p>
        <button v-if="draft" class="sf-btn primary" type="button" :disabled="Boolean(busy)" @click="confirmPublish = true">Publish league</button>
      </div>
      <div v-for="s in open" :key="s.id" class="ls-life-row" :data-season="s.id">
        <p class="ls-life-text">
          <strong>{{ s.name }}</strong>
          <span class="sf-chip" :data-tone="STAGE_TONE[seasonStageOf(s)]">{{ SEASON_STAGE_LABEL[seasonStageOf(s)] }}</span>
        </p>
        <div class="sf-btn-row">
          <button
            v-for="a in stageActions(s)" :key="a.stage" class="sf-btn small" :class="{ primary: a.primary }" type="button" :disabled="Boolean(busy)"
            @click="move(s, a.stage, a.label)"
          >{{ a.label }}</button>
        </div>
      </div>
      <p class="hm-small hm-empty">
        Open registration lets coaches register once the league is published, within the season's window (Registrations tab).
        Start season closes registration unless joining mid-season is on.
      </p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="sf-notice" role="status">{{ notice }}</p>
    </div>
    <LeagueDialog v-if="confirmPublish" id="ls-pub-h" title="Publish league" role="alertdialog" describedby="ls-pub-d" @close="confirmPublish = false">
      <p id="ls-pub-d">Everyone will see {{ state.league?.name }} on the Leagues list. A published league can't go back to draft.</p>
      <template #foot>
        <button class="sf-btn" type="button" @click="confirmPublish = false">Cancel</button>
        <button class="sf-btn primary" type="button" data-autofocus @click="publish">Publish</button>
      </template>
    </LeagueDialog>
  </section>
</template>
