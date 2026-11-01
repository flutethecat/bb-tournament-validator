<script setup lang="ts">
// One team's finished-game summary (the match reporter's post-match preview): outcome and score, post-match money and
// fans, deaths, and every player line. Shared by the recorder and the read-only game page (which has no treasury). The
// game page's online games carry only what the fork result had: no post-match step, SPP only when a league banked it.
import type { MatchSummaryView } from "../tabletop/finished";

defineProps<{ heading: string; summary: MatchSummaryView }>();
const money = (n: number): string => `${Math.round(n / 1000)}k`;
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
</script>

<template>
  <section class="tt-panel tt-summary">
    <h3>{{ heading }}</h3>
    <p>
      {{ summary.outcome === "won" ? "Won" : summary.outcome === "lost" ? "Lost" : "Drawn" }} {{ summary.score.for }}-{{ summary.score.against }}
      <template v-if="summary.applied === true"> · winnings {{ money(summary.winnings ?? 0) }}<template v-if="summary.treasuryBefore !== undefined && summary.treasuryAfter !== undefined"> · treasury {{ money(summary.treasuryBefore) }} to {{ money(summary.treasuryAfter) }}</template> · fans {{ summary.fansBefore }} to {{ summary.fansAfter }}</template>
      <template v-else-if="summary.applied === false"> · post-match not applied</template>
      <template v-else><template v-if="summary.winnings !== undefined"> · winnings {{ money(summary.winnings) }}</template><template v-if="summary.fanFactor !== undefined"> · fan factor {{ summary.fanFactor }}</template><template v-if="summary.fansChange"> · dedicated fans {{ signed(summary.fansChange) }}</template></template>
    </p>
    <p v-if="summary.deaths.length" class="sf-error">Killed: {{ summary.deaths.join(", ") }}</p>
    <ul class="tt-players">
      <li v-for="l in summary.players" :key="l.id" class="tt-player">
        <strong>{{ l.name }}</strong><small v-if="l.position" class="muted">{{ " " }}{{ l.position }}</small>
        <span class="muted">{{ " " }}{{ l.touchdowns }} TD, {{ l.casualtiesCaused }} CAS, {{ l.completions }} comp, {{ l.interceptions }} int, {{ l.deflections }} defl<template v-if="l.mvp">, MVP</template><template v-if="l.sentOff">, sent off</template></span>
        <span v-if="l.sppEarned !== undefined" class="tt-spp">{{ " " }}+{{ l.sppEarned }} SPP</span>
        <span v-if="l.injury" class="muted">{{ " · " }}{{ l.injury.result }}{{ l.injury.stat ? ` ${l.injury.stat}` : "" }}{{ l.injury.apothecaryUsed ? " (apothecary)" : "" }}</span>
      </li>
    </ul>
  </section>
</template>
