<script setup lang="ts">
// Create a league: the LEAGUE SUMMARY side panel, key/value rows that fill in as the steps are answered.
import { computed, inject } from "vue";
import { LEAGUE_WIZARD_KEY } from "../leagues/wizard";

const wizard = inject(LEAGUE_WIZARD_KEY)!;
const { state } = wizard;
const groups = computed(() => wizard.summary());
</script>

<template>
  <aside class="hm-panel lw-summary" aria-labelledby="lw-sum-h">
    <header class="hm-band"><h2 id="lw-sum-h">League summary</h2><span class="hm-cap">{{ state.draft ? "Draft saved" : "Not saved yet" }}</span></header>
    <div class="lw-summary-body">
      <section v-for="g in groups" :key="g.step" class="lw-sum-group" :aria-label="g.title">
        <h3 class="lw-sum-title">{{ g.title }}</h3>
        <dl class="lw-kv">
          <template v-for="row in g.rows" :key="row.k"><dt>{{ row.k }}</dt><dd>{{ row.v }}</dd></template>
        </dl>
      </section>
    </div>
  </aside>
</template>
