<script setup lang="ts">
// Schedule, LIST view (hub §7): Scheduled (agreed times, open the fixture) · Proposed (pending offers either way:
// answer or withdraw) · Need to schedule (fixtures with no time and nothing pending: Propose a time).
import { RouterLink } from "vue-router";
import { slotRange, whenIn, type ListGroups, type ScheduleFixture, type ScheduleProposal } from "../schedule/schedule";

defineProps<{ groups: ListGroups; zone: string }>();
const emit = defineEmits<{ answer: [p: ScheduleProposal]; propose: [f: ScheduleFixture] }>();
const kindLabel = (f: ScheduleFixture) => (f.kind === "tournament" ? "Tournament" : "League");
</script>

<template>
  <div class="sc-list">
    <section class="sc-group" aria-labelledby="sc-g-scheduled">
      <h3 id="sc-g-scheduled" class="sc-group-h">Scheduled <span class="hm-cap">{{ groups.scheduled.length }}</span></h3>
      <p v-if="!groups.scheduled.length" class="hm-empty">No agreed times yet.</p>
      <ul v-else class="sc-rows">
        <li v-for="f in groups.scheduled" :key="f.ref" class="sc-row" data-group="scheduled">
          <span class="sc-row-when"><strong>{{ whenIn(f.scheduled!.start, zone) }}</strong><small>{{ slotRange(f.scheduled!.start, zone) }}</small></span>
          <span class="sc-row-what"><strong>{{ f.title }}</strong><small>{{ f.competition }}</small></span>
          <span class="sf-chip" :data-tone="f.kind === 'tournament' ? 'info' : 'ok'">{{ kindLabel(f) }}</span>
          <RouterLink class="sf-btn small" :to="f.link">{{ f.kind === "league" ? "Lobby" : "Open" }}</RouterLink>
        </li>
      </ul>
    </section>

    <section class="sc-group" aria-labelledby="sc-g-proposed">
      <h3 id="sc-g-proposed" class="sc-group-h">Proposed <span class="hm-cap">{{ groups.proposed.length }}</span></h3>
      <p v-if="!groups.proposed.length" class="hm-empty">No proposals waiting.</p>
      <ul v-else class="sc-rows">
        <li v-for="x in groups.proposed" :key="x.proposal.id" class="sc-row" data-group="proposed" :data-mine="x.proposal.mine ? 'true' : undefined">
          <span class="sc-row-when">
            <strong>{{ x.proposal.slots.length }} {{ x.proposal.slots.length === 1 ? "time" : "times" }}</strong>
            <small>{{ whenIn(x.proposal.slots[0]!.start, zone) }}{{ x.proposal.slots.length > 1 ? " …" : "" }}</small>
          </span>
          <span class="sc-row-what"><strong>{{ x.fixture.title }}</strong><small>{{ x.proposal.mine ? `Waiting for ${x.proposal.to}` : `From ${x.proposal.from}` }} · {{ x.fixture.competition }}</small></span>
          <span class="sf-chip" :data-tone="x.proposal.mine ? 'muted' : 'soon'">{{ x.proposal.mine ? "Sent" : "Your answer" }}</span>
          <button type="button" class="sf-btn small" :class="{ primary: !x.proposal.mine }" @click="emit('answer', x.proposal)">{{ x.proposal.mine ? "View" : "Answer" }}</button>
        </li>
      </ul>
    </section>

    <section class="sc-group" aria-labelledby="sc-g-need">
      <h3 id="sc-g-need" class="sc-group-h">Need to schedule <span class="hm-cap">{{ groups.need.length }}</span></h3>
      <p v-if="!groups.need.length" class="hm-empty">Every fixture has a time or a proposal.</p>
      <ul v-else class="sc-rows">
        <li v-for="f in groups.need" :key="f.ref" class="sc-row" data-group="need">
          <span class="sc-row-when"><strong>{{ f.deadline ? `Due ${whenIn(f.deadline, zone)}` : "No deadline" }}</strong><small>{{ f.opponent?.coach ? `vs coach ${f.opponent.coach}` : "Opponent not linked" }}</small></span>
          <span class="sc-row-what"><strong>{{ f.title }}</strong><small>{{ f.competition }}</small></span>
          <span class="sf-chip" :data-tone="f.kind === 'tournament' ? 'info' : 'ok'">{{ kindLabel(f) }}</span>
          <button v-if="f.canPropose" type="button" class="sf-btn small primary" @click="emit('propose', f)">Propose a time</button>
          <small v-else class="sc-reason">{{ f.reason }}</small>
        </li>
      </ul>
    </section>
  </div>
</template>
