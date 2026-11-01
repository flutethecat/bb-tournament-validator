<script setup lang="ts">
// League page "Announcement" dialog (organisers and site admins; opened from the megaphone next to the settings cog):
// a joined strip picks "News post" (the season's league news composer) or "Message members" (newest season only). The
// footer button submits the picked composer (both stay mounted, so a switch keeps each draft); on success the dialog closes and the page shows the confirmation.
import { computed, inject, ref } from "vue";
import { LEAGUE_DETAIL_KEY } from "../leagues/league";
import LeagueDialog from "./LeagueDialog.vue";
import LeagueMessageMembers from "./LeagueMessageMembers.vue";
import LeagueNewsComposer from "./LeagueNewsComposer.vue";
import type { SeasonRecord } from "../leagues/types";

export type AnnounceKind = "news" | "message";
const props = withDefaults(defineProps<{ leagueId: string; season: SeasonRecord; canMessage: boolean; initial?: AnnounceKind }>(), { initial: "news" });
const emit = defineEmits<{ close: []; done: [notice: string] }>();

const kind = ref<AnnounceKind>(props.initial === "message" && props.canMessage ? "message" : "news");
type Composer = { submit: () => Promise<void>; ready: boolean; busy: boolean };
const news = ref<Composer | null>(null);
const message = ref<Composer | null>(null);
const active = computed(() => (kind.value === "news" ? news.value : message.value));
const CHOICES: Array<{ id: AnnounceKind; label: string }> = [{ id: "news", label: "News post" }, { id: "message", label: "Message members" }];
// Either composer in flight locks the strip, Cancel and close (Escape / the X): the dialog closes only when the request
// has finished (on success), and a failure shows in the composer. A news post's flight is the league detail's own flag.
const detail = inject(LEAGUE_DETAIL_KEY, null);
const newsBusy = computed(() => news.value?.busy === true || detail?.state.editBusy === "news");
const busy = computed(() => newsBusy.value || message.value?.busy === true);
const submit = (): void => { if (!busy.value) void active.value?.submit(); };
</script>

<template>
  <LeagueDialog id="lg-announce-h" title="Announcement" :cap="season.name" tag="form" :busy="busy" @close="emit('close')" @submit="submit">
    <div class="sf-tabs lg-announce-kind" role="group" aria-label="Announcement type">
      <button
        v-for="c in CHOICES" :key="c.id" type="button" class="sf-tab" :aria-pressed="kind === c.id ? 'true' : 'false'"
        :disabled="busy || (c.id === 'message' && !canMessage)" @click="kind = c.id"
      >{{ c.label }}</button>
    </div>
    <p v-if="!canMessage" class="hm-small hm-empty">Message members works from the newest season.</p>
    <LeagueNewsComposer v-show="kind === 'news'" ref="news" :season="season" @done="emit('done', $event)" />
    <LeagueMessageMembers v-if="canMessage" v-show="kind === 'message'" ref="message" :league-id="leagueId" :season="season" @done="emit('done', $event)" />
    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <button type="submit" class="sf-btn primary" :disabled="!active?.ready || busy">{{ busy ? "Sending..." : (kind === "news" ? "Post news" : "Send message") }}</button>
    </template>
  </LeagueDialog>
</template>
