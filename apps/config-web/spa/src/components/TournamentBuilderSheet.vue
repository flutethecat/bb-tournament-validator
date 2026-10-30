<script setup lang="ts">
// Tournament Builder, Sheet tab: the printable team sheet only (owner 10-30), in the shared team view's own markup
// (public/team-view.js, the same look as the public share page). The verdict and the actions live in the Roster pane.
import { computed, inject } from "vue";
import "../../../public/team-view.js";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";

interface TeamViewCore { viewHtml: (team: unknown, opts?: Record<string, unknown>) => string }
const TeamView = (globalThis as unknown as { TeamView?: TeamViewCore }).TeamView;

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;
// The page already has its h1: the sheet's team name becomes the section heading.
const sheetHtml = computed(() => (TeamView && state.roster ? TeamView.viewHtml(builder.teamViewModel(), { hideOwnerLink: true }).replace(/<h1 class="tv-name">([\s\S]*?)<\/h1>/, '<h2 class="tv-name">$1</h2>') : ""));
</script>

<template>
  <div v-if="sheetHtml" class="team-view tb-sheet" v-html="sheetHtml"></div>
  <p v-else class="hm-empty">Choose a ruleset and a race to see the team sheet.</p>
</template>
