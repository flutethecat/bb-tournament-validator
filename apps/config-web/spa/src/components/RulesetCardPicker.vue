<script setup lang="ts">
// The ruleset card picker both creation wizards share (creation wizards v2): a search, the FEATURED row (BB2025 first and
// preselected by the wizard, EuroBowl 2026, Small Gods, World Cup 3.0), then every other saved ruleset, and "Create a new
// ruleset" (the Tournament Creator round trip; the parent keeps the form). Cards in the Roster Builder .tb-card language.
import { computed, ref } from "vue";
import { cardKey, filterCards, rulesetCards, type PackageListItem, type RulesetCard } from "../shared/competition";
import "../shared/competition.css";

const props = defineProps<{
  kind: "league" | "tournament";
  packages: PackageListItem[];
  status: "idle" | "loading" | "ready" | "error";
  /** The picked card's key (cardKey). */
  selected: string;
  extra?: RulesetCard[];
}>();
const emit = defineEmits<{ pick: [card: RulesetCard]; create: []; retry: [] }>();
const search = ref("");
const cards = computed(() => rulesetCards(props.packages, props.kind, props.extra ?? []));
const featured = computed(() => filterCards(cards.value.featured, search.value));
const others = computed(() => filterCards(cards.value.others, search.value));
</script>

<template>
  <div class="cf-picker">
    <div class="cf-toolbar">
      <label class="sf-field cf-search"><span class="sf-k">Search rulesets</span><input v-model="search" type="search" autocomplete="off" placeholder="Name or description" /></label>
      <button type="button" class="sf-btn" data-create-ruleset @click="emit('create')">Create a new ruleset</button>
    </div>
    <p v-if="status === 'error' && !featured.length" class="sf-error" role="alert">
      Can't load the rulesets. <button class="sf-btn small" type="button" @click="emit('retry')">Try again</button>
    </p>
    <template v-if="featured.length">
      <h3 class="cf-row-h">Featured</h3>
      <div class="cf-cards" role="group" aria-label="Featured rulesets" data-row="featured">
        <button
          v-for="c in featured" :key="cardKey(c)" type="button" class="cf-card" data-featured="true" :data-package="c.packageName || c.ruleset"
          :aria-pressed="selected === cardKey(c) ? 'true' : 'false'" @click="emit('pick', c)"
        >
          <strong>{{ c.label }}</strong>
          <span v-if="c.line" class="cf-card-desc">{{ c.line }}</span>
        </button>
      </div>
    </template>
    <h3 class="cf-row-h">All rulesets</h3>
    <p v-if="status === 'loading' || status === 'idle'" class="hm-empty" role="status">Loading rulesets...</p>
    <p v-else-if="!others.length && search.trim()" class="hm-empty">No other ruleset matches "{{ search }}".</p>
    <p v-else-if="!others.length" class="hm-empty">No other saved rulesets yet. Create one in the Tournament Creator.</p>
    <div v-else class="cf-cards" role="group" aria-label="All rulesets" data-row="all">
      <button
        v-for="c in others" :key="cardKey(c)" type="button" class="cf-card" :data-package="c.packageName || c.ruleset"
        :aria-pressed="selected === cardKey(c) ? 'true' : 'false'" @click="emit('pick', c)"
      >
        <strong>{{ c.label }}</strong>
        <span v-if="c.line" class="cf-card-desc">{{ c.line }}</span>
        <span v-if="c.sevens" class="sf-chip" data-tone="info">Sevens</span>
      </button>
    </div>
  </div>
</template>
