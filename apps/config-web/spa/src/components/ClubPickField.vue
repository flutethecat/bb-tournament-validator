<script setup lang="ts">
// The club pick in a join sheet (owner 11-02, round 3): which of the coach's clubs they represent in this competition, or
// "No club". Only clubs the coach belongs to (the sheet loads them with clubs.ts loadMyClubs); hidden when they belong to
// none. The choice is fixed once the entry is accepted (the server enforces it): the competition's results then count
// for that club.
import type { MyClub } from "../clubs/clubs";

const model = defineModel<string>({ default: "" });
defineProps<{ clubs: readonly MyClub[] }>();
</script>

<template>
  <label v-if="clubs.length" class="sf-field" data-club-pick>
    <span class="sf-k">Club</span>
    <select v-model="model" class="sf-input tr-select">
      <option value="">No club</option>
      <option v-for="c in clubs" :key="c.id" :value="c.id">{{ c.name }}</option>
    </select>
    <small class="muted hm-small">Your results here count for the club you pick. It can't change once you're accepted.</small>
  </label>
</template>
