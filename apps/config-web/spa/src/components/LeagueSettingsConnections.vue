<script setup lang="ts">
// League settings, External connections: NAF results report (tournaments only for now), Results export (CSV zip),
// the Discord webhook (URL stored server-side and only ever shown masked; event toggles; Send test post) and the
// Play on Super FUMBBL toggle (default off; admins then allow single fixtures on the Fixtures tab).
import { computed, inject, reactive, ref, watch } from "vue";
import { DISCORD_EVENT_LABEL, isWebhookUrl, LEAGUE_SETTINGS_KEY } from "../leagues/settings";
import type { DiscordEventKey } from "../leagues/types";

const settings = inject(LEAGUE_SETTINGS_KEY)!;
const { state } = settings;
const c = computed(() => state.view!.connections);
const busy = computed(() => Boolean(state.busy));

const exportSeason = ref("");
const exportHref = computed(() => settings.exportUrl(exportSeason.value || undefined));

// Discord: the field starts empty every time; what is stored is only ever shown masked.
const url = ref("");
const urlError = computed(() => (url.value.trim() && !isWebhookUrl(url.value) ? "Paste the webhook URL from Discord (https://discord.com/api/webhooks/...)." : ""));
async function saveUrl(): Promise<void> {
  if (!url.value.trim() || urlError.value) return;
  if (await settings.save("connections", { discord: { url: url.value.trim() } }, "discord", "Webhook saved.")) url.value = "";
}
const clearUrl = () => settings.save("connections", { discord: { url: null } }, "discord", "Webhook removed.");

const events = reactive({ ...c.value.discord.events });
watch(() => JSON.stringify(c.value.discord.events), () => Object.assign(events, c.value.discord.events));
const eventKeys = computed(() => Object.keys(DISCORD_EVENT_LABEL) as DiscordEventKey[]);
const eventsDirty = computed(() => eventKeys.value.some((k) => events[k] !== c.value.discord.events[k]));
const saveEvents = () => settings.save("connections", { discord: { events: { ...events } } }, "discord-events", "Events saved.");

const setFork = (e: Event) => settings.save("connections", { playOnFork: (e.target as HTMLInputElement).checked }, "fork",
  (e.target as HTMLInputElement).checked ? "Play on Super FUMBBL is on." : "Play on Super FUMBBL is off.");
</script>

<template>
  <div class="ls-pair">
    <section class="hm-panel ls-disabled" aria-labelledby="ls-naf-h" aria-disabled="true">
      <header class="hm-band"><h2 id="ls-naf-h">NAF results report</h2><span class="hm-cap">Tournaments only</span></header>
      <p>{{ c.naf.note }}</p>
      <div class="ls-actions"><button class="ls-btn" type="button" disabled>Export NAF report</button></div>
    </section>

    <section class="hm-panel" aria-labelledby="ls-export-h">
      <header class="hm-band"><h2 id="ls-export-h">Results export</h2><span class="hm-cap">CSV zip</span></header>
      <p class="hm-small">Teams, fixtures, standings, participants, honours and awards, one CSV each.</p>
      <div class="ls-inline">
        <label class="ls-field">
          <span>Seasons</span>
          <select v-model="exportSeason">
            <option value="">All seasons</option>
            <option v-for="s in state.seasons" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <a class="ls-btn primary" :href="exportHref" download>Download results</a>
      </div>
    </section>

    <section class="hm-panel" aria-labelledby="ls-discord-h">
      <header class="hm-band"><h2 id="ls-discord-h">Discord webhook</h2><span class="hm-cap">{{ c.discord.configured ? "Connected" : "Not connected" }}</span></header>
      <p v-if="c.discord.configured">Posting to <span class="ls-masked" data-masked>{{ c.discord.maskedUrl }}</span></p>
      <p v-else class="hm-small">In Discord: channel settings, Integrations, Webhooks, New webhook, Copy webhook URL.</p>
      <form class="ls-inline" novalidate @submit.prevent="saveUrl">
        <label class="ls-field" :data-invalid="urlError ? 'true' : undefined">
          <span>{{ c.discord.configured ? "Replace webhook URL" : "Webhook URL" }}</span>
          <input v-model="url" type="password" autocomplete="off" spellcheck="false" maxlength="300" placeholder="https://discord.com/api/webhooks/..." />
          <small v-if="urlError" class="ls-field-error">{{ urlError }}</small>
        </label>
        <button class="ls-btn primary" type="submit" :disabled="!url.trim() || Boolean(urlError) || busy">Save webhook</button>
        <button v-if="c.discord.configured" class="ls-btn danger" type="button" :disabled="busy" @click="clearUrl">Remove</button>
      </form>
      <p v-if="state.errors.discord" class="ls-error" role="alert">{{ state.errors.discord }}</p>
      <p v-else-if="state.notices.discord" class="hm-notice" role="status">{{ state.notices.discord }}</p>
      <fieldset class="ls-toggles">
        <legend class="ls-k">Post when</legend>
        <label v-for="k in eventKeys" :key="k" class="ls-check"><input v-model="events[k]" type="checkbox" /> {{ DISCORD_EVENT_LABEL[k] }}</label>
      </fieldset>
      <div class="ls-actions">
        <button class="ls-btn" type="button" :disabled="!eventsDirty || busy" @click="saveEvents">Save events</button>
        <button class="ls-btn" type="button" :disabled="!c.discord.configured || busy" @click="settings.testDiscord()">Send test post</button>
      </div>
      <p v-if="state.errors['discord-events'] || state.errors['discord-test']" class="ls-error" role="alert">{{ state.errors['discord-events'] || state.errors['discord-test'] }}</p>
      <p v-else-if="state.notices['discord-events'] || state.notices['discord-test']" class="hm-notice" role="status">{{ state.notices['discord-events'] || state.notices['discord-test'] }}</p>
    </section>

    <section class="hm-panel" aria-labelledby="ls-fork-h">
      <header class="hm-band"><h2 id="ls-fork-h">Play on Super FUMBBL</h2><span class="hm-cap">{{ c.playOnFork ? "On" : "Off" }}</span></header>
      <label class="ls-check">
        <input type="checkbox" role="switch" :checked="c.playOnFork" :aria-checked="c.playOnFork ? 'true' : 'false'" :disabled="busy" @change="setFork" />
        Let league games be played on Super FUMBBL
      </label>
      <p class="hm-small hm-empty">When on, league admins allow single fixtures on the Fixtures tab; both coaches and the organisers are notified.</p>
      <p v-if="state.errors.fork" class="ls-error" role="alert">{{ state.errors.fork }}</p>
      <p v-else-if="state.notices.fork" class="hm-notice" role="status">{{ state.notices.fork }}</p>
    </section>
  </div>
</template>
