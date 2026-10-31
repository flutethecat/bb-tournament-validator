<script setup lang="ts">
// Tournament Builder, Sideline staff (a panel of the Roster pane's left accordion): rerolls at the roster's price, the
// apothecary only where the roster allows one, one dedicated fan free. Five lines at a time, scrolling beyond that.
import { computed, inject, ref } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";
import { useRowWindow } from "../teams/hireWindow";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;
const apothecaryOff = computed(() => Boolean(state.roster && !state.roster.apothecaryAllowed));
const rows = computed(() => builder.staffRows());
const list = ref<HTMLElement | null>(null);
const { maxHeight } = useRowWindow(list, () => rows.value.map((r) => r.key));
</script>

<template>
  <ul ref="list" class="tb-steppers tb-scroll-list tb-row-window" :style="maxHeight ? { maxHeight } : undefined">
    <li v-for="r in rows" :key="r.key" class="tb-step-row" :class="{ off: r.key === 'apothecary' && apothecaryOff }">
      <span class="tb-step-icon" aria-hidden="true"><img v-if="builder.staffIcon(r.key)" class="crest-image" :src="builder.staffIcon(r.key)" alt="" loading="lazy" /></span>
      <span class="tb-who"><strong>{{ r.label }}</strong><small>{{ r.key === 'apothecary' && apothecaryOff ? "Not available to this roster" : `${r.min}–${r.max} · ${core.gold(r.cost)} each${r.free ? `, ${r.free} free` : ""}` }}</small></span>
      <span class="tb-stepper">
        <button type="button" :disabled="(r.key === 'apothecary' && apothecaryOff) || state.staff[r.key] <= r.min" :aria-label="`Remove ${r.label}`" @click="builder.stepStaff(r.key, -1)">−</button>
        <b aria-live="polite">{{ state.staff[r.key] }}</b>
        <button type="button" :disabled="(r.key === 'apothecary' && apothecaryOff) || state.staff[r.key] >= r.max" :aria-label="`Add ${r.label}`" @click="builder.stepStaff(r.key, 1)">+</button>
      </span>
      <small class="tb-step-cost">{{ core.gold(Math.max(0, state.staff[r.key] - r.free) * r.cost) }}</small>
    </li>
  </ul>
</template>
