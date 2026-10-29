<script setup lang="ts">
// League statistics, the spotlight row on top of each scope (BB2020 | BB2025 | All time): one card per headline from
// stats.cards[] (src/leagues/stats.ts statsCards). A card: the band with its pixel sprite and title, the big number in
// the band font with the scoreboard shadow, who, the team + race line with the race crest, the season chips, the names
// tied with it, and the whole card links to the player, the team or the fixture. Phones: a horizontal snap row.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { cardQuery, cardSeasonChips, crestFor, initials, tiedLine } from "../leagues/league";
import type { StatsCard } from "../leagues/types";

const props = defineProps<{ cards: StatsCard[]; crests: Record<string, string>; leagueId: string; label: string }>();
const rows = computed(() => props.cards.map((c) => ({
  c,
  crest: crestFor(props.crests, c.race),
  chips: cardSeasonChips(c.seasons),
  // A team card names the team: its second line is the coach instead of repeating the team.
  sub: c.name === c.team ? [c.coach, c.race].filter(Boolean).join(" · ") : [c.team, c.race].filter(Boolean).join(" · "),
  tied: tiedLine(c.tied),
})));
</script>

<template>
  <section v-if="rows.length" class="lg-spots" :aria-label="`${label} spotlight`">
    <ul class="lg-spot-row">
      <li v-for="r in rows" :key="r.c.id" class="lg-spot" :data-card="r.c.id">
        <RouterLink class="lg-spot-link" :to="{ name: 'league-detail', params: { id: leagueId }, query: cardQuery(r.c) }" :aria-label="`${r.c.title}: ${r.c.name}, ${r.c.value} ${r.c.unit}`">
          <span class="lg-spot-band"><img v-if="r.c.icon" class="lg-spot-icon" :src="r.c.icon" alt="" width="22" height="22" /><span>{{ r.c.title }}</span></span>
          <span class="lg-spot-figure"><span class="lg-spot-num">{{ r.c.value }}</span><span class="lg-spot-unit">{{ r.c.unit }}</span></span>
          <strong class="lg-spot-name">{{ r.c.name }}</strong>
          <span class="lg-spot-team">
            <img v-if="r.crest" class="lg-spot-crest" :src="r.crest" alt="" />
            <span v-else class="lg-spot-crest lg-spot-blank" aria-hidden="true">{{ initials(r.c.team || r.c.name) }}</span>
            <span class="lg-spot-team-text">{{ r.sub }}</span>
          </span>
          <small v-if="r.c.detail" class="lg-spot-detail">{{ r.c.detail }}</small>
          <span v-if="r.chips.length" class="lg-spot-chips"><span v-for="s in r.chips" :key="s" class="sf-chip">{{ s }}</span></span>
          <small v-if="r.tied" class="lg-spot-tied">{{ r.tied }}</small>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>
