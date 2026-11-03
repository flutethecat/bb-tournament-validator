<script setup lang="ts">
// Team history (team page v2): every coach and organiser edit, status change and fixture decision, newest first: what
// changed (old -> new), who, when. Served only to the team's coach and the league's organisers (the edit context); the
// public season read never carries it. Collapsed by default; the viewer's choice is not remembered.
import { ref } from "vue";
import type { TeamHistoryEntry } from "../teams/summary";

defineProps<{ entries: TeamHistoryEntry[] }>();
const open = ref(false);
const KIND: Record<TeamHistoryEntry["kind"], string> = { "coach-edit": "Coach", "organiser-edit": "Edit mode", status: "Status", "fixture-decision": "Fixtures", forfeit: "Forfeit" };
const when = (iso: string): string => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const line = (c: TeamHistoryEntry["changes"][number]): string =>
  c.from === undefined && c.to === undefined ? c.what : c.from === undefined ? `${c.what}: ${c.to}` : c.to === undefined ? `${c.what}: ${c.from} removed` : `${c.what}: ${c.from} → ${c.to}`;
</script>

<template>
  <section class="hm-panel ts-history" aria-labelledby="ts-history-h" data-team-history>
    <header class="hm-band">
      <h2 id="ts-history-h"><button type="button" class="lg-fx-fold" :aria-expanded="open ? 'true' : 'false'" aria-controls="ts-history-body" @click="open = !open">Team history <i class="tb-acc-chev" aria-hidden="true"></i></button></h2>
      <span class="hm-cap">{{ entries.length }} {{ entries.length === 1 ? "change" : "changes" }} · coach and organisers only</span>
    </header>
    <ol v-if="open" id="ts-history-body" class="ts-history-list">
      <li v-if="!entries.length" class="hm-empty">No changes recorded yet.</li>
      <li v-for="(h, i) in entries" :key="`${h.at}-${i}`">
        <p class="ts-history-head"><span class="sf-chip" :data-tone="h.kind === 'coach-edit' ? 'muted' : 'soon'">{{ KIND[h.kind] }}</span> <b>{{ h.by }}</b> <time :datetime="h.at" class="muted">{{ when(h.at) }}</time></p>
        <ul><li v-for="(c, j) in h.changes" :key="j">{{ line(c) }}</li></ul>
      </li>
    </ol>
  </section>
</template>
