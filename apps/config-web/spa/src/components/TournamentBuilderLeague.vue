<script setup lang="ts">
// Roster Builder league mode, Ruleset tab (registration spec 11-02, lane L7): the league season's team-building rules take
// the ruleset cards' place (there is no ruleset to pick). Left: Pick a race, the season's table as race buttons (crest,
// tier, initial treasury, starting skills); a full race stays in the grid, disabled, with its reason; races outside the
// allowed roster classes are listed under "Not offered" with the reason. Right: the rules summary (allowed classes,
// registration, max per race, Elite skills, stars and inducements). Same panels and race buttons as Free Create's grid.
import { computed, inject } from "vue";
import { RouterLink } from "vue-router";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";

const emit = defineEmits<{ race: [rosterId: string]; next: [] }>();
const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

const ctx = computed(() => state.leagueCtx);
const rows = computed(() => builder.leagueRaces());
/** In the grid: every race the league's classes admit (full ones disabled); the rest go under "Not offered". */
const offered = computed(() => rows.value.filter((r) => r.allowed));
const notOffered = computed(() => rows.value.filter((r) => !r.allowed));
const classes = computed(() => {
  const a = ctx.value?.registration.allowedRosters;
  return a ? [a.official ? "Official" : "", a.nafApproved ? "NAF-approved" : "", a.unofficial ? "Unofficial" : ""].filter(Boolean).join(", ") : "";
});
const summary = computed(() => {
  const c = ctx.value;
  if (!c) return [];
  const r = c.registration;
  return [
    { k: "Season", v: `${c.season.name} (${c.season.ruleset})` },
    { k: "Registration", v: r.open ? "Open" : r.allowRegistration ? "Closed (the season has finished)" : "Closed" },
    { k: "Allowed rosters", v: classes.value },
    { k: "Max per race", v: r.maxPerRace != null ? `${r.maxPerRace} team${r.maxPerRace === 1 ? "" : "s"}` : "No limit" },
    { k: "Treasury", v: "Each race's initial treasury (below each race)" },
    { k: "Starting skills", v: c.eliteSkills.length ? `As listed per race. Elite: ${c.eliteSkills.join(", ")}` : "As listed per race" },
    { k: "Star players", v: "Hired as inducements before a match" },
    { k: "Inducements", v: c.inducements.length ? "Bought before each match (Inducements panel)" : "None offered this season" },
  ];
});
</script>

<template>
  <div v-if="ctx" class="tb-rsflow tb-rs-sel tb-league">
    <section class="hm-panel tb-panel tb-area-race" aria-labelledby="tb-race-h">
      <header class="hm-band"><h2 id="tb-race-h">Pick a race</h2><span class="hm-cap">{{ offered.filter((r) => r.selectable).length }} open</span></header>
      <p class="muted tb-hint">The races this league allows, with each race's tier, treasury and starting skills.</p>
      <div class="tb-free-races tb-league-races" role="list" aria-label="Races">
        <button
          v-for="r in offered" :key="r.roster" type="button" role="listitem" class="tb-free-race tb-league-race" :data-tt-race="r.rosterId ?? undefined"
          :data-class="r.class" :aria-pressed="r.selected ? 'true' : 'false'" :disabled="!r.selectable" :aria-describedby="r.reason ? `tb-lr-${r.roster.replace(/\W+/g, '-')}` : undefined"
          @click="r.rosterId && emit('race', r.rosterId)"
        >
          <img v-if="r.crest" class="crest-image tt-team-crest" :src="r.crest" alt="" aria-hidden="true" loading="lazy" decoding="async" />
          <span class="tb-league-race-text">
            <span>{{ r.roster }}<span v-if="r.class !== 'official'" class="sf-chip tb-league-class" data-tone="info">{{ r.classLabel }}</span></span>
            <small class="muted">{{ r.terms }}</small>
            <small v-if="r.reason" :id="`tb-lr-${r.roster.replace(/\W+/g, '-')}`" class="tb-league-reason">{{ r.reason }}</small>
          </span>
        </button>
      </div>
      <p v-if="!offered.length" class="hm-empty">This league allows no roster this server can build.</p>
      <details v-if="notOffered.length" class="tb-notes tb-league-off">
        <summary>Not offered in this league ({{ notOffered.length }})</summary>
        <ul class="tb-league-off-list">
          <li v-for="r in notOffered" :key="r.roster"><strong>{{ r.roster }}</strong> <span class="muted">{{ r.reason }}</span></li>
        </ul>
      </details>
      <div v-if="state.roster" class="tb-actions">
        <button type="button" class="tb-btn primary" @click="emit('next')">Build the {{ state.roster.raceName }} team</button>
      </div>
    </section>

    <section class="hm-panel tb-panel tb-area-summary" aria-labelledby="tb-league-h">
      <header class="hm-band"><h2 id="tb-league-h">{{ ctx.label }}</h2><span class="hm-cap">League rules</span></header>
      <dl class="tt-summary tb-summary">
        <div v-for="row in summary" :key="row.k" class="tt-summary-row"><dt>{{ row.k }}</dt><dd>{{ row.v }}</dd></div>
      </dl>
      <p class="muted tb-hint">Saving keeps this league season with the team, ready to register.
        <RouterLink :to="`/leagues/${encodeURIComponent(ctx.league.id)}`">Back to {{ ctx.league.name }}</RouterLink></p>
    </section>
  </div>
</template>
