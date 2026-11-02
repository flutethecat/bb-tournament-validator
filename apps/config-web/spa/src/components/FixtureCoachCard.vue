<script setup lang="ts">
// Fixture summary, a coach card (league UX pass 11-02), in the Super FUMBBL client's coach-card style: avatar (the site's
// public avatar route) with a presence dot, the coach name, and the figures the server sent: Rating (the existing Elo
// until Glicko lands), win rate, games, and the overall rank when the server could rank the coach. A race rank is left
// out: the rating is not kept per race. Clicking the name opens the shared coach summary popup (league pages only).
// Public data only: never an email, phone or Discord id.
import { computed, ref, watch } from "vue";
import { initials } from "../leagues/league";
import { coachCardLines } from "../leagues/fixtureSummary";
import { coachAvatarSrc } from "../leagues/popups";
import type { LobbySide, LobbyView } from "../leagues/lobby";

const props = defineProps<{ view: LobbyView; side: LobbySide; mine: boolean; clickable: boolean }>();
const emit = defineEmits<{ open: [side: LobbySide] }>();
const s = computed(() => props.view.sides[props.side]);
const lines = computed(() => coachCardLines({ rating: s.value.rating ?? null, winRate: s.value.winRate ?? null, stats: s.value.stats }));
const avatar = computed(() => coachAvatarSrc(s.value.coachId));
const failed = ref(false);
watch(avatar, () => { failed.value = false; });
</script>

<template>
  <section class="hm-panel fs-coach" :data-side="side" :aria-labelledby="`fs-coach-${side}`">
    <header class="hm-band" :data-seat="side">
      <h2 :id="`fs-coach-${side}`">{{ mine ? "You" : "Coach" }}</h2>
      <span class="hm-cap">{{ s.online ? "Online" : "Offline" }}</span>
    </header>
    <div class="fs-coach-head">
      <span class="fs-avatar">
        <img v-if="avatar && !failed" :src="avatar" alt="" width="48" height="48" referrerpolicy="no-referrer" @error="failed = true" />
        <span v-else aria-hidden="true">{{ initials(s.coach) }}</span>
        <span class="fl-dot" :data-on="s.online ? 'true' : 'false'" />
      </span>
      <button v-if="clickable && s.coach" type="button" class="fs-coach-name fs-link" data-coach-card-link @click="emit('open', side)">{{ s.coach }}</button>
      <span v-else class="fs-coach-name">{{ s.coach || "No coach yet" }}</span>
    </div>
    <dl class="fs-kv" data-coach-card>
      <div v-for="l in lines" :key="l.k" :data-k="l.k"><dt>{{ l.k }}</dt><dd>{{ l.v }}</dd></div>
    </dl>
  </section>
</template>
