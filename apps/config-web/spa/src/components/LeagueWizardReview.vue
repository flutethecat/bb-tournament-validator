<script setup lang="ts">
// Create a league, step 5 Review: every choice as key/value panels with Edit links back to each step. Create league
// finishes the wizard; the league stays a DRAFT (only its organisers and site admins see it) until Publish in League
// settings, Administration.
import { computed, inject } from "vue";
import { LEAGUE_WIZARD_KEY } from "../leagues/wizard";

const wizard = inject(LEAGUE_WIZARD_KEY)!;
const groups = computed(() => wizard.summary());
</script>

<template>
  <div class="lw-review">
    <p class="lw-help lw-review-lead">
      Create league saves it as a draft: only you, its other organisers and site admins can see it. Publish it from League
      settings, Administration, when it is ready; then open registration there.
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
