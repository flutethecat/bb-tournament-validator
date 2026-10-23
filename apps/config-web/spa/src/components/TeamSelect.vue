<script setup lang="ts">
import { watch } from "vue";
import type { LibraryTeam } from "../shared/api";
import { fmtK } from "../shared/format";

const props = defineProps<{ id: string; teams: LibraryTeam[] }>();
const model = defineModel<string>({ default: "" });

// Like a plain <select>: the first team is picked until the coach picks another (kept across library reloads).
watch(
  [() => props.teams, model],
  ([teams, value]) => {
    if (!teams.some((t) => t.teamId === value)) model.value = teams[0]?.teamId ?? "";
  },
  { immediate: true },
);
</script>

<template>
  <select :id="id" v-model="model" aria-label="Your team">
    <option v-if="!teams.length" value="">No teams in your library yet</option>
    <option v-for="t in teams" :key="t.teamId" :value="t.teamId">{{ t.teamName }} ({{ t.race }}, TV {{ fmtK(t.teamValue) }})</option>
  </select>
</template>
