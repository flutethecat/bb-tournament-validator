<script setup lang="ts">
// League Calendar tab (TourPlay's Calendar): the season's fixtures by day, from dates the season already carries (the
// agreed game time, the organiser's scheduled date, or the day a game was played), month by month. A light agenda view
// of existing data; fixtures without any date are counted at the end. Each row opens the fixture's summary.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { fixtureCalendar } from "../shell/sectionViews";
import type { SeasonRecord } from "../leagues/types";

const props = defineProps<{ season: SeasonRecord; leagueId: string }>();
const route = useRoute();
const cal = computed(() => fixtureCalendar(props.season.fixtures));
const to = (fixtureId: string) => ({
  name: "league-detail", params: { id: props.leagueId },
  query: { ...(route.query.season ? { season: String(route.query.season) } : {}), tab: "fixtures", fixture: fixtureId },
});
</script>

<template>
  <div class="lg-stack lg-calendar">
    <p v-if="!cal.months.length" class="hm-empty">No fixture of {{ season.name }} has a date yet.</p>
    <section v-for="m in cal.months" :key="m.key" class="hm-panel" :aria-labelledby="`lg-cal-${m.key}`">
      <header class="hm-band"><h2 :id="`lg-cal-${m.key}`">{{ m.label }}</h2><span class="hm-cap">{{ m.count }} {{ m.count === 1 ? "fixture" : "fixtures" }}</span></header>
      <ol class="lg-cal-days">
        <li v-for="d in m.days" :key="d.key" class="lg-cal-day" :data-day="d.key">
          <span class="lg-cal-date"><b>{{ d.dayNo }}</b><small>{{ d.weekday }}</small></span>
          <ul class="lg-cal-games">
            <li v-for="g in d.games" :key="g.id">
              <RouterLink class="lg-cal-game" :to="to(g.id)">
                <span>{{ g.home }} <span class="muted">v</span> {{ g.away }}</span>
                <span v-if="g.score" class="lg-cal-score">{{ g.score }}</span>
                <span v-else class="sf-chip" :data-tone="g.kind === 'agreed' ? 'ok' : 'info'">{{ g.kind === "agreed" ? `Agreed ${g.time}` : "Scheduled" }}</span>
              </RouterLink>
              <small class="muted">{{ g.round }}</small>
            </li>
          </ul>
        </li>
      </ol>
    </section>
    <p v-if="cal.undated" class="hm-small hm-empty">{{ cal.undated }} {{ cal.undated === 1 ? "fixture has" : "fixtures have" }} no date yet.</p>
  </div>
</template>
