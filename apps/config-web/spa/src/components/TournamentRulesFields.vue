<script setup lang="ts">
// The rule fields Create Tournament and Edit Tournament share: Max players, Rounds (Swiss only) and First tiebreaker.
// The default slot sits between Rounds and First tiebreaker (Edit puts Pairing system and Seeding there).
import type { TournamentPrimaryTiebreaker } from "../tournaments/detail";
import { TIEBREAKER_LABEL } from "../tournaments/detail";

defineProps<{
  swiss: boolean;
  /** Create: blank rounds = Auto (the server picks). Edit: always a number. */
  roundsOptional?: boolean;
  tiebreakerDisabled?: boolean;
  /** Edit Tournament edits the whole chain instead (CompetitionFormatFields). */
  hideTiebreaker?: boolean;
}>();
const maxPlayers = defineModel<number | "">("maxPlayers", { required: true });
const roundCount = defineModel<number | "">("roundCount", { required: true });
const primaryTiebreaker = defineModel<TournamentPrimaryTiebreaker>("primaryTiebreaker", { required: true });
</script>

<template>
  <label class="tn-field sf-field"><span class="tn-fact-k">Max players</span><input v-model.number="maxPlayers" type="number" min="2" max="512" step="1" inputmode="numeric" required /></label>
  <label v-if="swiss" class="tn-field sf-field">
    <span class="tn-fact-k">Rounds</span>
    <input
      v-model.number="roundCount" type="number" min="1" max="50" step="1" inputmode="numeric"
      :placeholder="roundsOptional ? 'Auto' : undefined" :required="!roundsOptional"
    />
  </label>
  <slot />
  <label v-if="!hideTiebreaker" class="tn-field sf-field">
    <span class="tn-fact-k">First tiebreaker</span>
    <select v-model="primaryTiebreaker" :disabled="tiebreakerDisabled">
      <option v-for="(label, key) in TIEBREAKER_LABEL" :key="key" :value="key">{{ label }}</option>
    </select>
  </label>
</template>
