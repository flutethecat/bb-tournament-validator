<script setup lang="ts">
// Tournament Creator summary page: one band-headed panel (the Roster Builder's look): boxed figure tiles (the builder's
// stat tiles), key/value rows (Silkscreen keys, gold for money) and on/off rule chips. Inherited values say so.
import type { ReviewSection } from "../tournaments/creator";

defineProps<{ section: ReviewSection }>();
</script>

<template>
  <section class="hm-panel cr-review-panel" :data-section="section.id" :aria-labelledby="`cr-rv-${section.id}-h`">
    <header class="hm-band"><h2 :id="`cr-rv-${section.id}-h`">{{ section.title }}</h2><span v-if="section.cap" class="hm-cap">{{ section.cap }}</span></header>
    <ul v-if="section.tiles.length" class="cr-tiles">
      <li v-for="tile in section.tiles" :key="tile.key" class="cr-tile" :data-tile="tile.key" :data-gold="tile.gold ? 'true' : undefined">
        <b>{{ tile.value }}</b><span>{{ tile.label }}</span><small v-if="tile.inherited" class="cr-inh">inherited</small>
      </li>
    </ul>
    <dl v-if="section.rows.length" class="cr-kv">
      <div v-for="row in section.rows" :key="row.key" :data-row="row.key" :data-tone="row.tone">
        <dt>{{ row.label }}<small v-if="row.inherited" class="cr-inh">inherited</small></dt>
        <dd>{{ row.value }}</dd>
      </div>
    </dl>
    <ul v-if="section.chips.length" class="cr-flags" :aria-label="`${section.title}: rules`">
      <li v-for="chip in section.chips" :key="chip.key" class="cr-flag" :data-chip="chip.key" :data-on="chip.on ? 'true' : 'false'">
        <span class="cr-flag-mark" aria-hidden="true">{{ chip.on ? "✓" : "–" }}</span>{{ chip.label }}<span class="cr-sr">{{ chip.on ? ", on" : ", off" }}</span><small v-if="chip.inherited" class="cr-inh">inherited</small>
      </li>
    </ul>
    <p v-if="section.note" class="cr-review-note">{{ section.note }}</p>
  </section>
</template>
