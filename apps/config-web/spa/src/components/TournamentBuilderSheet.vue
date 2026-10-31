<script setup lang="ts">
// Tournament Builder, Sheet tab (owner 10-30): the exported PDF previewed on screen. One bezel-and-lift panel (the frame,
// themed like the Roster pane) holds the paper sheet (TournamentBuilderPrintSheet: public/sheet-pdf.js's layout, palette and
// Roboto). The model is the PDF's own (sheetRuleset.ts sheetModel: the builder's sheetModel() + the ruleset rows). The
// verdict and the actions live in the Roster pane; the public share page (/t/<token>) keeps public/team-view.js.
import { computed, inject, onMounted } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";
import { sheetModel } from "../teams/sheetRuleset";
import { loadSheetFonts } from "../teams/sheetFonts";
import TournamentBuilderPrintSheet from "./TournamentBuilderPrintSheet.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;
const model = computed(() => (state.roster ? sheetModel(builder) : null));
onMounted(() => { void loadSheetFonts(); });
</script>

<template>
  <section class="hm-panel tb-panel ps-frame" aria-labelledby="ps-frame-h">
    <header class="hm-band"><h2 id="ps-frame-h">Sheet · preview of the exported PDF</h2><span class="hm-cap">A4 landscape</span></header>
    <div class="ps-frame-body">
      <TournamentBuilderPrintSheet v-if="model" :model="model" :gold="core.gold" />
      <p v-else class="hm-empty">Choose a ruleset and a race to see the team sheet.</p>
    </div>
  </section>
</template>
