<script setup lang="ts">
// A "Gates" panel beside a step (lane 8c): one editor per gate the step has (the Redraft board's window, rest rolls and
// submissions; a season's start and registration; a ladder's challenges and honours reveal). Gates are off by default.
import LeagueGateEditor from "./LeagueGateEditor.vue";
import type { GateKind } from "../leagues/gates";

defineProps<{ leagueId: string; title?: string; cap?: string; items: ReadonlyArray<{ kind: GateKind; target: string; label?: string; help?: string }> }>();
</script>

<template>
  <section class="hm-panel gt-panel" :aria-label="title ?? 'Gates'">
    <header class="hm-band" data-tone="info"><h2>{{ title ?? "Gates" }}</h2><span class="hm-cap">{{ cap ?? "Off by default" }}</span></header>
    <p class="hm-small gt-intro">A gate keeps an online step shut until a time in the league's zone, or until a League Event. Coaches see a countdown; when it opens they get a note and the league's Discord a post.</p>
    <div class="gt-list">
      <LeagueGateEditor v-for="i in items" :key="`${i.kind}:${i.target}`" :league-id="leagueId" :kind="i.kind" :target="i.target" :label="i.label" :help="i.help" />
    </div>
  </section>
</template>
