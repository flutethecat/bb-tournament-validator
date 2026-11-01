<script setup lang="ts">
// A proposal's times (hub §6): the answering coach accepts one (it becomes the fixture's time), counters with other
// times, or declines; the coach who sent them can withdraw. Each time shows both coaches' local clocks; a time that has
// passed or now clashes with a confirmed game cannot be accepted.
import "../leagues/leagues.css";
import { computed } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import {
  myBusy, slotRange, slotState, STATE_TEXT, validZone, whenIn, type ScheduleFixture, type ScheduleProposal, type ScheduleView,
} from "../schedule/schedule";

const props = defineProps<{ proposal: ScheduleProposal; fixture: ScheduleFixture; view: ScheduleView; zone: string; now: number; busy?: boolean; error?: string }>();
const emit = defineEmits<{ close: []; accept: [slot: string]; counter: []; decline: []; withdraw: [] }>();
const pending = computed(() => props.proposal.status === "pending");
const answering = computed(() => pending.value && !props.proposal.mine);
const oppZone = computed(() => (validZone(props.fixture.opponent?.timezone) ? props.fixture.opponent!.timezone! : ""));
const busyList = computed(() => [...myBusy(props.view, props.fixture.ref), ...(props.fixture.opponent?.busy ?? [])]);
const rows = computed(() => props.proposal.slots.map((s) => ({ ...s, state: slotState(Date.parse(s.start), busyList.value, props.now) })));
const caption = computed(() => (props.proposal.mine ? `Sent to ${props.proposal.to}` : `From ${props.proposal.from}`));
</script>

<template>
  <LeagueDialog id="sc-answer-h" :title="answering ? 'Pick a time' : 'Proposed times'" :cap="STATE_TEXT[proposal.status]" :busy="busy" @close="emit('close')">
    <div class="sc-pd-head">
      <strong class="sc-pd-fixture">{{ fixture.title }}</strong>
      <span class="muted">{{ fixture.competition }} · {{ caption }}</span>
      <span v-if="fixture.scheduled" class="muted">Agreed now: {{ whenIn(fixture.scheduled.start, zone) }}.</span>
    </div>
    <ul class="sc-answer">
      <li v-for="r in rows" :key="r.start" class="sc-answer-row" :data-state="r.state" :data-accepted="proposal.acceptedSlot === r.start ? 'true' : undefined">
        <span class="sc-answer-when"><strong>{{ whenIn(r.start, zone) }}</strong><small>{{ slotRange(r.start, zone) }} your time<template v-if="oppZone"> · {{ slotRange(r.start, oppZone) }} theirs</template></small></span>
        <button v-if="answering" type="button" class="sf-btn small primary" :disabled="busy || r.state !== 'ok'" @click="emit('accept', r.start)">Accept</button>
        <span v-if="r.state === 'clash'" class="sf-chip" data-tone="muted">Clash</span>
        <span v-else-if="r.state === 'past'" class="sf-chip" data-tone="muted">Past</span>
        <span v-if="proposal.acceptedSlot === r.start" class="sf-chip" data-tone="ok">Agreed</span>
      </li>
    </ul>
    <p v-if="pending && proposal.mine" class="muted hm-small">Waiting for {{ proposal.to }} to pick one.</p>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" @click="emit('close')">Close</button>
      <template v-if="answering">
        <button type="button" class="sf-btn" :disabled="busy" @click="emit('decline')">Decline</button>
        <button type="button" class="sf-btn primary" :disabled="busy" @click="emit('counter')">Suggest other times</button>
      </template>
      <button v-else-if="pending" type="button" class="sf-btn danger" :disabled="busy" @click="emit('withdraw')">Withdraw</button>
    </template>
  </LeagueDialog>
</template>
