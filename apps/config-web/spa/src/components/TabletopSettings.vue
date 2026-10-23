<script setup lang="ts">
// Settings sheet (the scoreboard cog): theme choice and the per-viewer recorder options.
import type { ViewerSettingsStore } from "../tabletop/settings";
import { themeLabel, type Theme, type ThemeMode } from "../theme";

defineProps<{ theme: Theme; settings: ViewerSettingsStore; editMode: boolean; canEdit: boolean }>();
const emit = defineEmits<{ (e: "close"): void; (e: "edit", on: boolean): void; (e: "changeTurn"): void }>();
const MODES: ThemeMode[] = ["system", "light", "dark"];
</script>

<template>
  <div class="tt-modal" role="dialog" aria-label="Settings" @click.self="emit('close')">
    <div class="tt-modal-box tt-settings">
      <div class="tt-rosters-head">
        <span class="tt-rosters-title">Settings</span>
        <button class="tt-close" type="button" aria-label="Close settings" @click="emit('close')">&#10005;</button>
      </div>
      <p class="tt-set-label">Theme</p>
      <div class="tt-seg" role="group" aria-label="Theme">
        <button v-for="m in MODES" :key="m" type="button" class="tt-seg-btn" :aria-pressed="theme.state.mode === m" @click="theme.setMode(m)">{{ themeLabel(m) }}</button>
      </div>
      <label class="tt-check"><input type="checkbox" :checked="settings.state.compact" @change="settings.set('compact', ($event.target as HTMLInputElement).checked)" /> Compact rows</label>
      <label class="tt-check"><input type="checkbox" :checked="settings.state.timestamps" @change="settings.set('timestamps', ($event.target as HTMLInputElement).checked)" /> Show timestamps</label>
      <label class="tt-check"><input type="checkbox" :checked="settings.state.sounds" @change="settings.set('sounds', ($event.target as HTMLInputElement).checked)" /> Sounds</label>
      <label class="tt-check"><input type="checkbox" :checked="settings.state.haptic" @change="settings.set('haptic', ($event.target as HTMLInputElement).checked)" /> Vibrate on tap</label>
      <button v-if="canEdit" class="lobby-btn tt-tap tt-changeturn" type="button" @click="emit('changeTurn')">Change turn</button>
      <label v-if="canEdit" class="tt-check"><input type="checkbox" :checked="editMode" @change="emit('edit', ($event.target as HTMLInputElement).checked)" /> Edit mode</label>
      <p class="tt-credit muted">Turn-timer sounds: Retro SFX by Andrea Baroni (Cyberleaf Studio).</p>
    </div>
  </div>
</template>
