<script setup lang="ts">
// SCHEDULE panel: the availability editor only (spec §4.6). Timezone (auto-detected until saved) and weekly blocks on a
// 7-column week grid; Save writes PUT /api/me/scheduling. Propose / calendar / list come in a later lane.
import { computed, inject, onMounted, onServerPrefetch } from "vue";
import { API_KEY } from "../app";
import { COACH_TREE_KEY } from "../home/tree";
import { byDay, createScheduleEditor, DAY_LABELS, MAX_BLOCKS, timeZoneOptions } from "../home/schedule";

const tree = inject(COACH_TREE_KEY, null);
// A saved week can change what the nav and the deadlines show: mark the tree stale.
const editor = createScheduleEditor({ api: inject(API_KEY)!, onSaved: () => tree?.invalidate() });
const { state } = editor;
// Insertion order + id keys: a row keeps its inputs while its times change (sorting happens on validation and save).
const columns = computed(() => byDay(state.blocks, { sort: false }));
const zones = computed(() => timeZoneOptions(state.timezone));

onMounted(() => { if (!state.loaded && !state.loadFailed) void editor.load(); });
onServerPrefetch(() => editor.load());

defineExpose({ editor });
</script>

<template>
  <div class="hm-schedule">
    <div class="hm-tz">
      <label for="hm-tz-select">Timezone</label>
      <select id="hm-tz-select" @change="editor.setTimezone(($event.target as HTMLSelectElement).value)">
        <option v-for="z in zones" :key="z" :value="z" :selected="z === state.timezone">{{ z }}</option>
      </select>
      <span v-if="state.detected" class="muted hm-small">Detected from this device; save to keep it.</span>
    </div>
    <p class="muted hm-small">When you can usually play, in your timezone. Opponents see this when they propose a time. {{ state.blocks.length }} / {{ MAX_BLOCKS }} blocks.</p>
    <div class="hm-week" role="group" aria-label="Weekly availability">
      <div v-for="(col, day) in columns" :key="day" class="hm-day" :data-day="day">
        <h4 class="hm-day-head">{{ DAY_LABELS[day] }}</h4>
        <ul class="hm-blocks">
          <li v-for="(b, i) in col" :key="b.id" class="hm-block">
            <input
              type="time" step="900" :value="b.start" :aria-label="`${DAY_LABELS[day]} block ${i + 1} start`"
              @change="editor.updateBlock(b, { start: ($event.target as HTMLInputElement).value })"
            />
            <input
              type="time" step="900" :value="b.end" :aria-label="`${DAY_LABELS[day]} block ${i + 1} end`"
              @change="editor.updateBlock(b, { end: ($event.target as HTMLInputElement).value })"
            />
            <button class="hm-x" type="button" :aria-label="`Remove ${DAY_LABELS[day]} ${b.start} to ${b.end}`" @click="editor.removeBlock(b)">×</button>
          </li>
        </ul>
        <button class="lobby-btn small hm-add" type="button" :disabled="!state.loaded || state.blocks.length >= MAX_BLOCKS" :aria-label="`Add a block on ${DAY_LABELS[day]}`" @click="editor.addBlock(day)">+ Add</button>
      </div>
    </div>
    <div class="hm-actions">
      <button class="lobby-btn primary small" type="button" :disabled="state.saving || !state.loaded" @click="editor.save()">{{ state.saving ? "Saving…" : "Save availability" }}</button>
      <span v-if="state.notice" class="hm-notice" role="status">{{ state.notice }}</span>
      <span v-else-if="state.dirty" class="muted hm-small">Unsaved changes.</span>
    </div>
    <p v-if="state.error" class="lobby-error hm-small">
      {{ state.error }}
      <button v-if="state.loadFailed" class="lobby-btn small hm-retry" type="button" @click="editor.load()">Retry</button>
    </p>
  </div>
</template>
