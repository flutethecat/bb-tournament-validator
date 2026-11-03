<script setup lang="ts">
// League Event detail (opened from a Calendar item, from a ?event= link in a coach's notification, or from the organiser
// Schedule page): the type, when (the occurrence that was clicked, else the next), where, the description, the repeat
// line and the linked season. Organisers get "Edit" (the Schedule page editor). Times are the league's time zone.
import { computed } from "vue";
import "../leagues/leagueEvents.css";
import { RouterLink } from "vue-router";
import LeagueDialog from "./LeagueDialog.vue";
import MarkdownLite from "./MarkdownLite.vue";
import { occurrenceFor, safeHttps, upcomingOf, whenText, type LeagueEventView } from "../leagues/leagueEvents";

const props = defineProps<{ event: LeagueEventView; occurrence?: string; zone: string; leagueId: string; manage?: boolean; now?: number }>();
const emit = defineEmits<{ close: []; edit: [] }>();

const now = computed(() => props.now ?? Date.now());
const occ = computed(() => occurrenceFor(props.event, props.occurrence, now.value));
const when = computed(() => (occ.value ? whenText(occ.value, props.zone) : ""));
const zoneText = computed(() => props.zone.replace(/_/g, " "));
const href = computed(() => (props.event.location.kind === "online" ? safeHttps(props.event.location.text) : undefined));
const more = computed(() => upcomingOf(props.event, now.value).filter((o) => o.key !== occ.value?.key).slice(0, 3));
const past = computed(() => (occ.value ? Date.parse(occ.value.end) <= now.value : false));
</script>

<template>
  <LeagueDialog id="lev-dialog-h" :title="event.title" :cap="event.typeLabel" @close="emit('close')">
    <div class="lev-detail" :data-type="event.type">
      <dl class="lev-kv">
        <div>
          <dt>When</dt>
          <dd data-when>{{ when }} <span class="muted">({{ zoneText }})</span><span v-if="past" class="sf-chip" data-tone="muted">Over</span></dd>
        </div>
        <div v-if="event.repeatText">
          <dt>Repeats</dt>
          <dd data-repeat>{{ event.repeatText }}</dd>
        </div>
        <div>
          <dt>{{ event.location.kind === "online" ? "Online" : "Where" }}</dt>
          <dd data-where>
            <a v-if="href" :href="href" target="_blank" rel="noopener noreferrer nofollow">{{ event.location.text }}</a>
            <template v-else>{{ event.location.text || (event.location.kind === "online" ? "Online" : "To be announced") }}</template>
          </dd>
        </div>
        <div v-if="event.link">
          <dt>Season</dt>
          <dd><RouterLink :to="{ name: 'league-detail', params: { id: leagueId }, query: { season: event.link.id } }">{{ event.link.name }}</RouterLink></dd>
        </div>
      </dl>
      <div v-if="event.description" class="lev-desc"><MarkdownLite :source="event.description" /></div>
      <div v-if="more.length" class="lev-next">
        <p class="tb-k">Next dates</p>
        <ul><li v-for="o in more" :key="o.key">{{ whenText(o, zone) }}</li></ul>
      </div>
    </div>
    <template #foot>
      <button type="button" class="sf-btn" @click="emit('close')">Close</button>
      <button v-if="manage" type="button" class="sf-btn primary" data-edit-event @click="emit('edit')">Edit event</button>
    </template>
  </LeagueDialog>
</template>
