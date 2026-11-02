<script setup lang="ts">
// Tournament Builder, Inducements (a panel of the Roster pane's left accordion, owner 10-31: "same as before"): the
// package's inducements at the team's terms (Bribery and Corruption price + max, roster-only items), picked ones listed first
// with their total. Each list shows five lines at a time.
import { computed, inject, ref } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";
import { useRowWindow } from "../teams/hireWindow";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;
const rows = computed(() => builder.inducementRows());
const selected = computed(() => rows.value.filter((r) => r.count > 0));
const available = computed(() => rows.value.filter((r) => r.count === 0));
const selectedTotal = computed(() => selected.value.reduce((n, r) => n + r.count * r.terms.price, 0));
const pickedList = ref<HTMLElement | null>(null);
const availList = ref<HTMLElement | null>(null);
const { maxHeight: pickedMax } = useRowWindow(pickedList, () => selected.value.map((r) => r.item.key));
const { maxHeight: availMax } = useRowWindow(availList, () => available.value.map((r) => r.item.key));
/** League mode (lane L7): no inducements are rostered when a league team is built; the season's table is shown for reference. */
const league = computed(() => (builder.leagueMode() ? state.leagueCtx : null));
</script>

<template>
  <template v-if="league">
    <p class="muted tb-hint">In {{ league.league.name }}, inducements are bought before each match, not when the team is built. This season's table:</p>
    <ul v-if="league.inducements.length" class="tb-league-ind" aria-label="League inducements">
      <li v-for="i in league.inducements" :key="i.id">
        <span class="tb-step-icon" aria-hidden="true"><img v-if="i.iconSrc" class="crest-image" :src="i.iconSrc" alt="" loading="lazy" /></span>
        <span class="tb-who"><strong>{{ i.name }}</strong><small v-if="i.effectText">{{ i.effectText }}</small></span>
        <small class="tb-step-cost">{{ i.price != null ? core.gold(i.price) : "Own price" }} · max {{ i.cap }}</small>
      </li>
    </ul>
    <p v-else class="hm-empty">No inducements are offered this season.</p>
  </template>
  <template v-else>
  <!-- Blood Bowl Sevens: the Sevens list (Spike! Journal 22) replaces the core one; no Star Players or Mercenaries -->
  <p v-if="builder.sevens()" class="muted tb-hint tb-ind-sevens">Sevens inducements (Spike! Journal 22), Desperate Measures included. No Star Players or Mercenaries.</p>
  <div v-if="selected.length" class="tb-ind-picked" role="group" aria-labelledby="tb-picked-h">
    <p class="tb-k tb-sub"><span id="tb-picked-h">Selected inducements</span><b>{{ core.gold(selectedTotal) }}</b></p>
    <ul ref="pickedList" class="tb-steppers tb-scroll-list tb-row-window" :style="pickedMax ? { maxHeight: pickedMax } : undefined">
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
  </div>

  <p v-if="state.inducementStatus" class="hm-empty">{{ state.inducementStatus }}</p>
  <p v-else-if="!available.length && rows.length" class="hm-empty">Every inducement is selected.</p>
  <ul v-if="available.length" ref="availList" class="tb-steppers tb-scroll-list tb-row-window" :style="availMax ? { maxHeight: availMax } : undefined">
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
  </template>
</template>
