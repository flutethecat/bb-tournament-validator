<script setup lang="ts">
// League settings -> External connections: "Create Discord events" (League Events). With the Super FUMBBL bot in the
// league's Discord server, every League Event keeps a Discord scheduled event for its next date (created, moved and
// deleted with it). Without the bot (no token, or it is in no server of yours) the option is off and the panel says
// "Add the Super FUMBBL bot to your server to create Discord events" with the invite button.
import { computed, inject, onMounted, ref } from "vue";
import "../leagues/leagueEvents.css";
import { API_KEY } from "../app";
import { api as defaultApi } from "../shared/api";
import { ADD_BOT_TEXT, leagueEventsApi, type DiscordEventsSettings } from "../leagues/leagueEvents";

const props = defineProps<{ leagueId: string; initial?: DiscordEventsSettings }>();
const api = inject(API_KEY, null) ?? defaultApi;

const view = ref<DiscordEventsSettings | null>(props.initial ?? null);
const enabled = ref(view.value?.enabled ?? false);
const guildId = ref(view.value?.guildId ?? "");
const channelId = ref(view.value?.channelId ?? "");
const busy = ref(false);
const error = ref("");
const notice = ref("");

const apply = (v: DiscordEventsSettings): void => {
  view.value = v;
  enabled.value = v.enabled;
  guildId.value = v.guildId ?? "";
  channelId.value = v.channelId ?? "";
};
onMounted(async () => {
  if (props.initial) return;
  try { apply((await leagueEventsApi.discord(api, props.leagueId)).discordEvents); } catch (e) { error.value = e instanceof Error ? e.message : "Can't load this right now."; }
});

const ready = computed(() => Boolean(view.value?.available && view.value.guilds.length));
const pickedGone = computed(() => Boolean(view.value?.guildId && !view.value.botInServer));

async function save(): Promise<void> {
  busy.value = true; error.value = ""; notice.value = "";
  try {
    const sameGuild = guildId.value === (view.value?.guildId ?? "");
    const res = await leagueEventsApi.saveDiscord(api, props.leagueId, {
      enabled: enabled.value, guildId: guildId.value || null, channelId: sameGuild ? channelId.value || null : null,
    });
    apply(res.discordEvents);
    notice.value = res.discordEvents.enabled ? "Saved. Events sync to Discord within a minute." : "Saved.";
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : "That did not save.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="hm-panel lev-discord" aria-labelledby="lev-discord-h" data-discord-events>
    <header class="hm-band"><h2 id="lev-discord-h">Discord events</h2><span class="hm-cap">{{ view?.enabled ? "On" : "Optional" }}</span></header>
    <p class="hm-small">Create a Discord event in your server for each League Event: its next date, moved and removed with it.</p>
    <p v-if="!view && !error" class="hm-empty" role="status">Loading...</p>
    <template v-else-if="view">
      <template v-if="!ready">
        <p class="lev-bot-note" data-add-bot>{{ ADD_BOT_TEXT }}.</p>
        <p v-if="view.error" class="sf-error">{{ view.error }}</p>
        <label class="sf-check lev-disabled">
          <input type="checkbox" disabled :checked="false" />
          <span>Create Discord events</span>
        </label>
        <div v-if="view.inviteUrl" class="ls-actions">
          <a class="sf-btn ls-bot-btn" :href="view.inviteUrl" target="_blank" rel="noopener">Add the Super FUMBBL bot to your server</a>
        </div>
        <p class="hm-small muted">The bot needs the Manage Events permission in your server.</p>
      </template>
      <form v-else class="lev-discord-form" @submit.prevent="save">
        <label class="sf-check">
          <input v-model="enabled" type="checkbox" name="enabled" data-enable />
          <span>Create Discord events</span>
        </label>
        <label class="sf-field">
          <span class="sf-k">Discord server</span>
          <select v-model="guildId" name="guild" @change="channelId = ''">
            <option value="">Pick a server</option>
            <option v-for="g in view.guilds" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </label>
        <label class="sf-field">
          <span class="sf-k">Voice channel for online events (optional)</span>
          <select v-model="channelId" name="channel" :disabled="!guildId || guildId !== (view.guildId ?? '')">
            <option value="">None: show the online link as the location</option>
            <option v-for="c in view.channels" :key="c.id" :value="c.id">{{ c.name }}{{ c.type === "stage" ? " (stage)" : "" }}</option>
          </select>
          <small v-if="guildId && guildId !== (view.guildId ?? '')" class="muted">Save the server first, then pick a channel.</small>
        </label>
        <p v-if="pickedGone" class="sf-error">The bot is no longer in the server picked before. Add it again or pick another.</p>
        <p v-if="view.error" class="sf-error">{{ view.error }}</p>
        <div class="sf-btn-row">
          <button type="submit" class="sf-btn primary" :disabled="busy">{{ busy ? "Saving..." : "Save" }}</button>
          <a v-if="view.inviteUrl" class="lev-invite-link" :href="view.inviteUrl" target="_blank" rel="noopener">Add the bot to another server</a>
        </div>
      </form>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="sf-notice" role="status">{{ notice }}</p>
    </template>
    <p v-else class="sf-error" role="alert">{{ error }}</p>
  </section>
</template>
