<script setup lang="ts">
// The HOUSE RULES panel on the league overview (season summary) and the tournament overview (owner 11-02): the rows that
// differ from the ruleset, then one line for the rest ("Everything else as <ruleset>"). The tournament's Progression and
// carry-over choices show when progression is on. Organisers get an Edit link to the house rules settings.
import { computed } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { changedHouseRulesRows, houseRulesOf, type HouseRules } from "../shared/competition";
import "../shared/competition.css";

const props = defineProps<{ kind: "league" | "tournament"; rules?: HouseRules | null; ruleset: string; idPrefix: string; editTo?: RouteLocationRaw | null }>();
const effective = computed(() => houseRulesOf({ houseRules: props.rules ?? undefined }, props.kind));
const changed = computed(() => changedHouseRulesRows(effective.value, props.kind));
const restLine = computed(() => (changed.value.length ? `Everything else as ${props.ruleset}` : `Everything as ${props.ruleset}`));
</script>

<template>
  <section class="hm-panel cf-house-panel" :aria-labelledby="`${idPrefix}-house-h`" data-house-panel>
    <header class="hm-band">
      <h2 :id="`${idPrefix}-house-h`">House rules</h2>
      <RouterLink v-if="editTo" class="hm-cap" :to="editTo" data-house-edit>Edit</RouterLink>
      <span v-else class="hm-cap">{{ changed.length ? `${changed.length} changed` : "None" }}</span>
    </header>
    <dl v-if="changed.length" class="tl-facts cf-house-facts">
      <div v-for="r in changed" :key="r.k" :data-rule="r.k"><dt>{{ r.k }}</dt><dd>{{ r.v }}</dd></div>
    </dl>
    <p class="cf-house-rest" data-house-rest>{{ restLine }}.</p>
  </section>
</template>
