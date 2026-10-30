<script setup lang="ts">
// Tournament Creator, Inducements tab: allowed (tick), per-inducement caps (0-9 stepper; the dataset maximum until the
// package sets one) and roster restrictions. Inducement ids the editor does not list (kept from the file) still show.
import { computed, inject } from "vue";
import { humanizeId, INDUCEMENTS, safeArray } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import CreatorMulti from "./CreatorMulti.vue";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const ro = computed(() => Boolean(state.readOnly));
const ind = computed(() => state.pkg!.inducements);
const items = computed(() => {
  const known = new Set(INDUCEMENTS.map((i) => i.id));
  const extra = [...new Set([...safeArray<string>(ind.value.allowed), ...Object.keys(ind.value.caps ?? {}), ...Object.keys(ind.value.rosterOnly ?? {})])]
    .filter((id) => id !== "*" && !known.has(id));
  return [...INDUCEMENTS, ...extra.map((id) => ({ id, label: humanizeId(id), max: ind.value.caps?.[id] ?? 1, fixed: false }))];
});
const rosterItems = computed(() => state.teams.map((t) => ({ value: t.name, label: t.name })));
</script>

<template>
  <section class="hm-panel" aria-labelledby="cr-ind-h">
    <header class="hm-band"><h2 id="cr-ind-h">Inducements</h2><span class="hm-cap">allowed, caps, roster restrictions</span></header>
    <ul class="cr-ind-list">
      <li v-for="item in items" :key="item.id" class="cr-ind-row" :data-allowed="c.inducementAllowed(item.id) ? 'true' : 'false'">
        <button
          type="button" class="cr-tick" :aria-pressed="c.inducementAllowed(item.id)" :aria-label="`Allow ${item.label}`" :disabled="ro" @click="c.toggleInducement(item.id)"
        >✓</button>
        <span class="cr-grow cr-ind-name">{{ item.label }}</span>
        <span class="cr-stepper">
          <button type="button" class="cr-step" :aria-label="`Lower ${item.label} cap`" :disabled="ro" @click="c.stepInducement(item.id, -1)">−</button>
          <span class="cr-num" :title="ind.caps?.[item.id] != null ? 'package cap' : 'dataset maximum'">0-{{ ind.caps?.[item.id] ?? item.max }}</span>
          <button type="button" class="cr-step" :aria-label="`Raise ${item.label} cap`" :disabled="ro" @click="c.stepInducement(item.id, 1)">+</button>
        </span>
        <CreatorMulti label="Rosters" :path="['inducements', 'rosterOnly', item.id]" :items="rosterItems" all-label="Any roster" />
      </li>
    </ul>
  </section>
</template>
