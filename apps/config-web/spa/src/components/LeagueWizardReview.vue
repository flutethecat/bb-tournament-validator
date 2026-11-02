<script setup lang="ts">
// Create a league, step 5 Review: every choice as key/value panels with Edit links back to each step (the Roster Builder
// summary layout). Save as draft finishes the wizard and keeps the league a DRAFT (only its organisers and site admins see
// it); Publish now also publishes it. Both check every step first.
import { computed, inject } from "vue";
import { LEAGUE_WIZARD_KEY } from "../leagues/wizard";

const wizard = inject(LEAGUE_WIZARD_KEY)!;
const groups = computed(() => wizard.summary());
</script>

<template>
  <div class="lw-review">
    <p class="lw-help lw-review-lead">
      <strong>Save as draft</strong> keeps it hidden: only you, its other organisers and site admins can see it.
      <strong>Publish now</strong> makes it public. Both check every step first. You can also publish later from League
      settings, Administration; open registration there when it is ready.
    </p>
    <div class="lw-review-grid">
      <section v-for="g in groups" :key="g.step" class="lw-group lw-review-card" :aria-labelledby="`lw-r-${g.step}`">
        <header class="lw-review-head">
          <h3 :id="`lw-r-${g.step}`" class="sf-k">{{ g.title }}</h3>
          <button class="sf-btn small" type="button" :aria-label="`Edit ${g.title}`" @click="wizard.go(g.step)">Edit</button>
        </header>
        <dl class="lw-kv">
          <template v-for="row in g.rows" :key="row.k"><dt>{{ row.k }}</dt><dd>{{ row.v }}</dd></template>
        </dl>
      </section>
    </div>
  </div>
</template>
