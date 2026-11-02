<script setup lang="ts">
// Admin: Edit inducements after the start (owner ruling 10-29: "allowed from the reporter's admin panel, stamped admin
// like every other organiser event"). The same picker the pre-game uses (TabletopInducementPicker), for either team, priced
// by the match's own table (league season or package rules) and budgeted by the server (GET .../inducements). Saving posts
// an admin-stamped record; the server re-prices the other team's petty cash and refuses what does not fit.
import { computed, onMounted, ref } from "vue";
import TabletopSheetHead from "./TabletopSheetHead.vue";
import TabletopInducementPicker from "./TabletopInducementPicker.vue";
import type { InducementEditMenu, MatchView, Side } from "../tabletop/recorder";

const props = defineProps<{
  match: MatchView;
  icons?: Record<string, string>;
  busy: boolean;
  /** The recorder's last action error (the save's refusal). */
  error: string;
  load: () => Promise<InducementEditMenu>;
  save: (side: Side, picks: Array<{ id: string; qty: number }> | "skip") => Promise<boolean>;
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const sides: Side[] = ["home", "away"];
const side = ref<Side>("home");
const menu = ref<InducementEditMenu | null>(null);
const loadError = ref("");
const saved = ref("");

async function reload(): Promise<void> {
  try {
    menu.value = await props.load();
    loadError.value = "";
  } catch (e) {
    loadError.value = (e as Error).message;
  }
}
onMounted(reload);

const roleWord = (s: Side): string => {
  const r = menu.value?.budget[s]?.role;
  return r === "favourite" ? "higher team value" : r === "underdog" ? "lower team value" : "";
};
const options = computed(() => menu.value?.inducementOptions[side.value] ?? []);

async function submit(s: Side, picks: Array<{ id: string; qty: number }> | "skip"): Promise<void> {
  saved.value = "";
  if (await props.save(s, picks)) {
    saved.value = `Saved for ${props.match[s].teamName}. The change is in the match log.`;
    await reload();
  }
}
</script>

<template>
  <div class="tt-modal" role="dialog" aria-label="Edit inducements" @click.self="emit('close')">
    <div class="tt-modal-box tt-ied">
      <TabletopSheetHead title="Edit inducements" @close="emit('close')" />
      <p class="muted tt-ied-note">Organiser edit after the start. It is logged as an admin event; the treasury is charged when the result is confirmed.</p>
      <div class="tt-seg tt-ied-seg" role="group" aria-label="Team">
        <button v-for="s in sides" :key="s" type="button" class="tt-seg-btn" :aria-pressed="side === s" @click="side = s; saved = ''">
          {{ match[s].teamName }}<small v-if="roleWord(s)" class="tt-ied-role">{{ roleWord(s) }}</small>
        </button>
      </div>
      <p v-if="loadError" class="sf-error" role="alert">{{ loadError }}</p>
      <p v-else-if="!menu" class="muted">Loading...</p>
      <template v-else>
        <p v-if="!menu.editable" class="sf-error" role="alert">{{ menu.reason }}</p>
        <p v-else-if="menu.prayersLocked" class="muted tt-ied-note">Prayers to Nuffle were rolled before the kick-off, so their number stays as it is.</p>
        <TabletopInducementPicker
          :key="side" :side="side" :team-name="match[side].teamName" :coach="match[side].coach" :options="options" :budget="menu.budget[side]" :icons="icons"
          :busy="busy" :can-edit="menu.editable" :submitted="menu.budget[side].submitted" :initial="menu.current[side]"
          @submit="(s, picks) => submit(s, picks)" @skip="(s) => submit(s, 'skip')"
        />
      </template>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <p v-if="saved && !error" class="tt-ied-saved" role="status">{{ saved }}</p>
    </div>
  </div>
</template>

<style scoped>
.tt-ied-note { margin: 4px 0 8px; font-size: 0.86rem; }
.tt-ied-role { display: block; font-size: 0.72rem; opacity: 0.8; }
.tt-ied-saved { margin: 8px 0 0; font-weight: 600; }
.tt-ied .tt-ied-seg { grid-template-columns: repeat(2, minmax(0, 1fr)); }
</style>
