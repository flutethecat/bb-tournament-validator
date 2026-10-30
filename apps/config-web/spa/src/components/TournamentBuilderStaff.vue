<script setup lang="ts">
// Tournament Builder, Staff (left column of the Roster pane, under Star Players): rerolls at the roster's price, the
// apothecary only where the roster allows one, one dedicated fan free.
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;
const apothecaryOff = computed(() => Boolean(state.roster && !state.roster.apothecaryAllowed));
</script>

<template>
  <section class="hm-panel tb-panel" aria-labelledby="tb-staff-h">
    <header class="hm-band"><h2 id="tb-staff-h">Staff</h2><span class="hm-cap">{{ core.gold(builder.totals().sidelineCost) }}</span></header>
    <ul class="tb-steppers">
      <li v-for="r in builder.staffRows()" :key="r.key" class="tb-step-row" :class="{ off: r.key === 'apothecary' && apothecaryOff }">
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
  </section>
</template>
