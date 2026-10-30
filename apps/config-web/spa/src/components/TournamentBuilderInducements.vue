<script setup lang="ts">
// Tournament Builder, Skills, Stars & Inducements pane: the package's inducements at the team's terms (Bribery and
// Corruption price + max, roster-only items), picked ones listed first with their total.
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;
const rows = computed(() => builder.inducementRows());
const selected = computed(() => rows.value.filter((r) => r.count > 0));
const available = computed(() => rows.value.filter((r) => r.count === 0));
const selectedTotal = computed(() => selected.value.reduce((n, r) => n + r.count * r.terms.price, 0));
</script>

<template>
  <section v-if="selected.length" class="hm-panel tb-panel" aria-labelledby="tb-picked-h">
    <header class="hm-band"><h2 id="tb-picked-h">Selected inducements</h2><span class="hm-cap">{{ core.gold(selectedTotal) }}</span></header>
    <ul class="tb-steppers">
      <li v-for="r in selected" :key="r.item.key" class="tb-step-row">
        <span class="tb-step-icon" aria-hidden="true"><img v-if="r.icon" class="crest-image" :src="r.icon" alt="" loading="lazy" /></span>
        <span class="tb-who"><strong>{{ r.item.label }}</strong><small>{{ r.note }}</small></span>
        <span class="tb-stepper">
          <button type="button" :aria-label="`Remove ${r.item.label}`" @click="builder.stepInducement(r.item.key, -1)">−</button>
          <b>{{ r.count }}</b>
          <button type="button" :disabled="r.atMax" :aria-label="`Add ${r.item.label}`" @click="builder.stepInducement(r.item.key, 1)">+</button>
        </span>
        <small class="tb-step-cost">× {{ core.gold(r.terms.price) }} = {{ core.gold(r.count * r.terms.price) }}</small>
      </li>
    </ul>
  </section>

  <section class="hm-panel tb-panel" aria-labelledby="tb-ind-h">
    <header class="hm-band"><h2 id="tb-ind-h">Inducements</h2><span class="hm-cap">{{ state.packageName }}</span></header>
    <p v-if="state.inducementStatus" class="hm-empty">{{ state.inducementStatus }}</p>
    <p v-else-if="!available.length && rows.length" class="hm-empty">Every inducement is selected.</p>
    <ul v-if="available.length" class="tb-steppers tb-scroll-list">
      <li v-for="r in available" :key="r.item.key" class="tb-step-row">
        <span class="tb-step-icon" aria-hidden="true"><img v-if="r.icon" class="crest-image" :src="r.icon" alt="" loading="lazy" /></span>
        <span class="tb-who"><strong>{{ r.item.label }}</strong><small>{{ r.note }}</small></span>
        <span class="tb-stepper">
          <button type="button" disabled :aria-label="`Remove ${r.item.label}`">−</button>
          <b>0</b>
          <button type="button" :disabled="r.atMax" :aria-label="`Add ${r.item.label}`" @click="builder.stepInducement(r.item.key, 1)">+</button>
        </span>
      </li>
    </ul>
  </section>
</template>
