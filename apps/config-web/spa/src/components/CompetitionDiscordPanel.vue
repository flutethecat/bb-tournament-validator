<script setup lang="ts">
// One competition's Discord settings (league, season or tournament): its own webhook (only ever shown masked; a blank
// season / tournament webhook uses the league's / series' one), the event toggles grouped into competition and in-game
// events (each in-game event with a Live switch), the end-of-game digest and coach's comments switches, a test post and
// "Send samples of every event". Server: GET/PATCH {base}/discord, POST {base}/discord/test|samples (src/discord/api.ts).
import { computed, inject, onServerPrefetch, reactive, ref, watch } from "vue";
import { API_KEY } from "../app";
import { api as defaultApi } from "../shared/api";
import {
  changedKeys, groupCatalogue, isDiscordWebhook, samplesLine, webhookLine, type CompetitionDiscordView, type SampleOutcome,
} from "../shared/discord";

/** The app's fetcher (tests inject a mock); same-origin JSON with the CSRF header. */
const api = inject(API_KEY, null) ?? defaultApi;

const props = withDefaults(defineProps<{ base: string; title?: string; compact?: boolean; headingId?: string }>(), { title: "Discord", compact: false, headingId: undefined });
const emit = defineEmits<{ loaded: [view: CompetitionDiscordView] }>();

const view = ref<CompetitionDiscordView | null>(null);
const loadError = ref("");
const busy = ref("");
const error = ref("");
const notice = ref("");
const url = ref("");
const events = reactive<Record<string, boolean>>({});
const live = reactive<Record<string, boolean>>({});
const opts = reactive({ endOfGameDigest: false, comments: true });
const confirmSamples = ref(false);

function adopt(v: CompetitionDiscordView): void {
  view.value = v;
  for (const k of Object.keys(events)) delete events[k];
  Object.assign(events, v.events);
  Object.assign(live, v.live);
  opts.endOfGameDigest = v.endOfGameDigest;
  opts.comments = v.comments;
  emit("loaded", v);
}

async function load(): Promise<void> {
  loadError.value = "";
  try {
    adopt((await api<{ discord: CompetitionDiscordView }>(`${props.base}/discord`)).discord);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : "Could not load the Discord settings.";
  }
}
let first: Promise<void> | undefined;
watch(() => props.base, () => { view.value = null; notice.value = error.value = ""; first = load(); }, { immediate: true });
// server-rendered (tests): wait for the first read
onServerPrefetch(() => first);

const groups = computed(() => groupCatalogue(view.value?.catalogue ?? []));
const urlError = computed(() => (url.value.trim() && !isDiscordWebhook(url.value) ? "Paste the webhook URL from Discord (https://discord.com/api/webhooks/...)." : ""));
const dirty = computed(() => {
  const v = view.value;
  if (!v) return false;
  return Object.keys(changedKeys(events, v.events)).length > 0 || Object.keys(changedKeys(live, v.live)).length > 0
    || opts.endOfGameDigest !== v.endOfGameDigest || opts.comments !== v.comments;
});
const canPost = computed(() => Boolean(view.value && !view.value.draft && (view.value.configured || view.value.inherited)));
const tickedCount = computed(() => Object.values(events).filter(Boolean).length);

async function run(what: string, fn: () => Promise<string>): Promise<void> {
  busy.value = what;
  error.value = notice.value = "";
  try { notice.value = await fn(); } catch (e) { error.value = e instanceof Error ? e.message : "Something went wrong."; } finally { busy.value = ""; }
}

const patch = (body: Record<string, unknown>) => api<{ discord: CompetitionDiscordView }>(`${props.base}/discord`, { method: "PATCH", body });

const saveUrl = () => run("url", async () => {
  if (!url.value.trim() || urlError.value) return "";
  adopt((await patch({ url: url.value.trim() })).discord);
  url.value = "";
  return "Webhook saved.";
});
const clearUrl = () => run("url", async () => { adopt((await patch({ url: null })).discord); return "Webhook removed."; });
const save = () => run("save", async () => {
  const v = view.value!;
  adopt((await patch({
    events: changedKeys(events, v.events), live: changedKeys(live, v.live),
    endOfGameDigest: opts.endOfGameDigest, comments: opts.comments,
  })).discord);
  return "Discord settings saved.";
});
const test = () => run("test", async () => { await api(`${props.base}/discord/test`, { method: "POST", body: {} }); return "Test post sent. Check the channel."; });
const samples = () => run("samples", async () => {
  confirmSamples.value = false;
  return samplesLine(await api<SampleOutcome>(`${props.base}/discord/samples`, { method: "POST", body: {} }));
});

defineExpose({ reload: load });
</script>

<template>
  <section class="hm-panel cd-panel" :data-compact="compact ? 'true' : undefined" :aria-label="title">
    <header class="hm-band"><h2 :id="headingId">{{ title }}</h2><span class="hm-cap">{{ view ? (view.configured ? "Connected" : view.inherited ? "Uses parent webhook" : "Not connected") : "" }}</span></header>
    <p v-if="loadError" class="sf-error" role="alert">{{ loadError }}</p>
    <p v-else-if="!view" class="hm-empty" role="status">Loading the Discord settings...</p>
    <template v-else>
      <p class="cd-line" data-masked>{{ webhookLine(view) }}</p>
      <p v-if="view.draft" class="hm-small cd-muted">This is a draft: nothing posts to Discord until it is published.</p>
      <form class="cd-url" novalidate @submit.prevent="saveUrl">
        <label class="sf-field cd-field" :data-invalid="urlError ? 'true' : undefined">
          <span class="sf-k">{{ view.configured ? "Replace webhook URL" : "Webhook URL" }}</span>
          <input v-model="url" type="password" autocomplete="off" spellcheck="false" maxlength="300" placeholder="https://discord.com/api/webhooks/..." />
          <small v-if="urlError" class="sf-error">{{ urlError }}</small>
        </label>
        <div class="sf-btn-row">
          <button class="sf-btn primary" type="submit" :disabled="!url.trim() || Boolean(urlError) || Boolean(busy)">Save webhook</button>
          <button v-if="view.configured" class="sf-btn danger" type="button" :disabled="Boolean(busy)" @click="clearUrl">Remove</button>
        </div>
      </form>
      <p v-if="view.kind !== 'league'" class="hm-small cd-muted">Leave it blank to post to the {{ view.kind === "tournament" ? "series" : "league" }}'s webhook.</p>

      <div class="cd-groups">
        <fieldset class="cd-group">
          <legend class="sf-k">Competition events</legend>
          <label v-for="r in groups.competition" :key="r.key" class="sf-check cd-check"><input v-model="events[r.key]" type="checkbox" :data-event="r.key" /> {{ r.label }}</label>
        </fieldset>
        <fieldset class="cd-group">
          <legend class="sf-k">In-game events (recorded games only)</legend>
          <div v-for="r in groups.inGame" :key="r.key" class="cd-ingame">
            <label class="sf-check cd-check"><input v-model="events[r.key]" type="checkbox" :data-event="r.key" /> {{ r.label }}</label>
            <label class="sf-check cd-live" :title="`Post ${r.label.toLowerCase()} as it happens instead of only in the digest`">
              <input v-model="live[r.key]" type="checkbox" :disabled="!events[r.key]" :data-live="r.key" /> Live
            </label>
          </div>
          <p class="hm-small cd-muted">Live events post as they are recorded; the rest go into the end-of-game digest.</p>
        </fieldset>
        <fieldset class="cd-group">
          <legend class="sf-k">Options</legend>
          <label class="sf-check cd-check"><input v-model="opts.endOfGameDigest" type="checkbox" data-opt="digest" /> End-of-game digest</label>
          <label class="sf-check cd-check"><input v-model="opts.comments" type="checkbox" data-opt="comments" /> Coach's comments</label>
          <p class="hm-small cd-muted">One summary per finished game; coaches may add a short comment at the end of the match.</p>
        </fieldset>
      </div>

      <div class="sf-btn-row cd-actions">
        <button class="sf-btn primary" type="button" :disabled="!dirty || Boolean(busy)" @click="save">Save</button>
        <button class="sf-btn" type="button" :disabled="!canPost || Boolean(busy)" @click="test">Send test post</button>
        <button class="sf-btn" type="button" :disabled="!canPost || !tickedCount || Boolean(busy)" data-samples @click="confirmSamples = true">Send samples of every event</button>
      </div>
      <div v-if="confirmSamples" class="cd-confirm" role="alertdialog" aria-label="Send samples">
        <p>This posts one [TEST] sample for each of the {{ tickedCount }} ticked events to the channel.</p>
        <div class="sf-btn-row">
          <button class="sf-btn primary" type="button" :disabled="Boolean(busy)" @click="samples">Send samples</button>
          <button class="sf-btn" type="button" @click="confirmSamples = false">Cancel</button>
        </div>
      </div>
      <p v-if="busy === 'samples'" class="hm-small" role="status">Sending samples, a few seconds apart...</p>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <p v-else-if="notice" class="hm-notice" role="status">{{ notice }}</p>
    </template>
  </section>
</template>

<style scoped>
.cd-line { margin-top: 0; margin-bottom: 6px; overflow-wrap: anywhere; }
.cd-muted { margin-top: 4px; margin-bottom: 0; color: var(--ui-muted); }
.cd-url { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; margin-top: 6px; }
.cd-field { display: grid; gap: 4px; flex: 1 1 260px; max-width: 460px; min-width: 0; }
.cd-groups { display: grid; gap: 12px 24px; margin-top: 12px; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); align-items: start; }
.cd-panel[data-compact="true"] .cd-groups { grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); }
.cd-group { display: grid; gap: 0; margin: 0; padding: 0; border: 0; min-width: 0; align-content: start; }
.cd-group legend { padding: 0; margin-bottom: 4px; }
.cd-check { display: inline-flex; align-items: center; gap: 10px; min-height: 34px; cursor: pointer; line-height: 1.3; }
.cd-ingame { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid color-mix(in srgb, var(--sf-panel-line) 60%, transparent); }
.cd-live { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; font-size: 13px; color: var(--ui-muted); cursor: pointer; }
.cd-live input { width: 16px; height: 16px; accent-color: var(--ui-primary); }
.cd-actions { margin-top: 12px; }
.cd-confirm { margin-top: 10px; padding: 10px 12px; border: 2px solid var(--sf-panel-line); border-left: 4px solid var(--ui-heading); background: var(--ui-surface-2); border-radius: 2px; }
.cd-confirm p { margin: 0 0 8px; }
.cd-panel .sf-error, .cd-panel .hm-notice { margin-top: 8px; }
</style>
