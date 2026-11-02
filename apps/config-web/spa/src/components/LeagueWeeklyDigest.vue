<script setup lang="ts">
// League settings, External connections: the Weekly Digest (owner rounds 3-4). Day of the week + time in the league's
// time zone + every 1 / 2 / 4 weeks, or "after each round"; Preview (read only) and Post now. A period with no games is
// skipped. The time zone is the league's (League settings, General). Server: PATCH /api/leagues/:id/discord { weekly },
// GET .../discord/weekly-digest, POST .../post.
import { computed, reactive, ref, watch, inject } from "vue";
import { API_KEY } from "../app";
import { api as defaultApi } from "../shared/api";
import { RouterLink } from "vue-router";
import { type CompetitionDiscordView, type DigestPreview, type WeeklySettings } from "../shared/discord";
import { TIME_ZONE_NOTE } from "../shared/timeZone";

/** The app's fetcher (tests inject a mock); same-origin JSON with the CSRF header. */
const api = inject(API_KEY, null) ?? defaultApi;

const props = defineProps<{ leagueId: string; view: CompetitionDiscordView }>();
const emit = defineEmits<{ saved: [view: CompetitionDiscordView] }>();

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const form = reactive<Omit<WeeklySettings, "weekdays" | "timeZone" | "timeZoneSet">>({ enabled: true, trigger: "schedule", day: 0, time: "10:00", everyWeeks: 1 });
function adopt(w: WeeklySettings | undefined): void {
  if (!w) return;
  Object.assign(form, { enabled: w.enabled, trigger: w.trigger, day: w.day, time: w.time, everyWeeks: w.everyWeeks });
}
watch(() => props.view.weekly, (w) => adopt(w), { immediate: true });
const zone = computed(() => props.view.weekly?.timeZone || "UTC");
const zoneSet = computed(() => props.view.weekly?.timeZoneSet !== false);
const dirty = computed(() => {
  const w = props.view.weekly;
  return !w || w.enabled !== form.enabled || w.trigger !== form.trigger || w.day !== form.day || w.time !== form.time || w.everyWeeks !== form.everyWeeks;
});

const busy = ref("");
const error = ref("");
const notice = ref("");
const preview = ref<DigestPreview | null>(null);
const base = computed(() => `/api/leagues/${encodeURIComponent(props.leagueId)}/discord`);

async function run(what: string, fn: () => Promise<string>): Promise<void> {
  busy.value = what;
  error.value = notice.value = "";
  try { notice.value = await fn(); } catch (e) { error.value = e instanceof Error ? e.message : "Something went wrong."; } finally { busy.value = ""; }
}
const save = () => run("save", async () => {
  const r = await api<{ discord: CompetitionDiscordView }>(base.value, { method: "PATCH", body: { weekly: { ...form } } });
  emit("saved", r.discord);
  return "Weekly Digest saved.";
});
const loadPreview = () => run("preview", async () => {
  preview.value = await api<DigestPreview>(`${base.value}/weekly-digest`);
  return "";
});
const postNow = () => run("post", async () => { await api(`${base.value}/weekly-digest/post`, { method: "POST", body: {} }); return "Weekly Digest posted."; });
const embed = computed(() => preview.value?.preview?.embeds[0] ?? null);
const canPost = computed(() => !props.view.draft && props.view.configured);
</script>

<template>
  <section class="hm-panel wd-panel" aria-labelledby="wd-h">
    <header class="hm-band"><h2 id="wd-h">Weekly Digest</h2><span class="hm-cap">{{ form.enabled ? "On" : "Off" }}</span></header>
    <p class="hm-small wd-muted">Standings (top 10 and movers), the period's results and highlights, posted to the league webhook. Weeks without games are skipped.</p>
    <div class="wd-grid">
      <label class="sf-check wd-check"><input v-model="form.enabled" type="checkbox" data-weekly="enabled" /> Post the Weekly Digest</label>
      <label class="sf-field wd-field"><span class="sf-k">When</span>
        <select v-model="form.trigger" :disabled="!form.enabled"><option value="schedule">On a set day</option><option value="afterRound">After each round</option></select>
      </label>
      <template v-if="form.trigger === 'schedule'">
        <label class="sf-field wd-field"><span class="sf-k">Day</span>
          <select v-model.number="form.day" :disabled="!form.enabled"><option v-for="(d, i) in DAYS" :key="d" :value="i">{{ d }}</option></select>
        </label>
        <label class="sf-field wd-field"><span class="sf-k">Time</span><input v-model="form.time" type="time" :disabled="!form.enabled" /></label>
        <label class="sf-field wd-field"><span class="sf-k">Every</span>
          <select v-model.number="form.everyWeeks" :disabled="!form.enabled"><option :value="1">week</option><option :value="2">2 weeks</option><option :value="4">4 weeks</option></select>
        </label>
      </template>
    </div>
    <p class="hm-small wd-zone" data-wd-zone>Times are in {{ zone }}. <RouterLink :to="{ name: 'league-settings', params: { id: leagueId }, query: { tab: 'information' } }">Change it in General</RouterLink>.</p>
    <p v-if="!zoneSet" class="wd-tz-note" role="note">{{ TIME_ZONE_NOTE }}</p>
    <div class="sf-btn-row wd-actions">
      <button class="sf-btn primary" type="button" :disabled="!dirty || Boolean(busy)" @click="save">Save</button>
      <button class="sf-btn" type="button" :disabled="Boolean(busy)" data-preview @click="loadPreview">Preview</button>
      <button class="sf-btn" type="button" :disabled="!canPost || Boolean(busy)" @click="postNow">Post now</button>
    </div>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="hm-notice" role="status">{{ notice }}</p>
    <div v-if="preview" class="wd-preview" aria-label="Weekly Digest preview">
      <p v-if="!embed" class="hm-small wd-muted" role="status">{{ preview.reason }}</p>
      <article v-else class="wd-embed">
        <h3 class="wd-title">{{ embed.title }}</h3>
        <p class="wd-desc">{{ embed.description }}</p>
        <div class="wd-fields">
          <div v-for="f in embed.fields ?? []" :key="f.name" class="wd-fieldbox" :data-inline="f.inline ? 'true' : undefined">
            <p class="sf-k">{{ f.name }}</p>
            <p class="wd-value">{{ f.value }}</p>
          </div>
        </div>
        <p v-if="embed.footer" class="hm-small wd-muted">{{ embed.footer.text }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.wd-muted { margin-top: 0; margin-bottom: 0; color: var(--ui-muted); }
.wd-grid { display: grid; gap: 10px 14px; margin-top: 10px; grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr)); align-items: end; }
.wd-check { grid-column: 1 / -1; display: inline-flex; align-items: center; gap: 10px; min-height: 34px; }
.wd-field { display: grid; gap: 4px; min-width: 0; }
.wd-field select, .wd-field input { width: 100%; }
.wd-actions { margin-top: 12px; }
.wd-zone { margin-top: 8px; margin-bottom: 0; color: var(--ui-muted); }
.wd-tz-note { margin-top: 6px; margin-bottom: 0; padding: 6px 10px; font-size: 14px; background: color-mix(in srgb, var(--ui-warn) 18%, var(--ui-surface-2)); border: 1px solid var(--ui-warn); border-left-width: 4px; border-radius: 2px; }
.wd-panel .sf-error, .wd-panel .hm-notice { margin-top: 8px; }
.wd-preview { margin-top: 12px; }
.wd-embed { padding: 10px 12px; background: var(--ui-surface-2); border: 2px solid var(--sf-panel-line); border-left: 4px solid var(--ui-heading); border-radius: 2px; }
.wd-title { margin: 0 0 4px; font-size: 16px; color: var(--ui-text); }
.wd-desc { margin: 0 0 8px; color: var(--ui-muted); }
.wd-fields { display: grid; gap: 8px 16px; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); }
.wd-value { margin: 2px 0 0; white-space: pre-line; overflow-wrap: anywhere; font-size: 14px; }
</style>
