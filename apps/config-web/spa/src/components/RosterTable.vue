<script setup lang="ts">
import { computed } from "vue";
import type { Roster, RosterPlayer } from "../shared/api";
import { fmtK } from "../shared/format";

const props = defineProps<{ roster: Roster }>();

const staff = computed(() =>
  [
    `Rerolls ${props.roster.rerolls}`,
    props.roster.apothecary ? "Apothecary" : "",
    `Assistant coaches ${props.roster.assistantCoaches}`,
    `Cheerleaders ${props.roster.cheerleaders}`,
    `Fans ${props.roster.fanFactor}`,
    `Treasury ${fmtK(props.roster.treasury)}`,
  ].filter(Boolean).join(" · "),
);

const stats = (p: RosterPlayer): string =>
  [p.ma, p.st, p.ag === null ? null : `${p.ag}+`, p.pa === null ? "-" : `${p.pa}+`, p.av === null ? null : `${p.av}+`]
    .map((v) => v ?? "-")
    .join(" / ");

const injuries = (p: RosterPlayer): string => [...p.injuries, p.mng ? "MNG" : ""].filter(Boolean).join(", ");
const HEAD = ["#", "Name", "Position", "MA / ST / AG / PA / AV", "Skills", "SPP", "Injuries"];
</script>

<template>
  <div class="roster">
    <p class="roster-head"><strong>{{ roster.name }}</strong> {{ roster.race }} · TV {{ fmtK(roster.teamValue) }}</p>
    <p class="muted">{{ staff }}</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th v-for="t in HEAD" :key="t">{{ t }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="p in roster.players" :key="p.number">
            <td>{{ p.number }}</td>
            <td>{{ p.name }}</td>
            <td>{{ p.position ?? "" }}</td>
            <td>{{ stats(p) }}</td>
            <td>{{ p.skills.join(", ") }}</td>
            <td>{{ p.spp }}</td>
            <td>{{ injuries(p) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
