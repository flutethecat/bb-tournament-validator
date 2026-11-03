<script setup lang="ts">
// League settings -> External connections: "Create Discord events" (League Events). With the Super FUMBBL bot in the
// league's Discord server, every League Event keeps a Discord scheduled event for its next date (created, moved and
// deleted with it). The server list holds ONLY servers where the organiser's linked Discord account can manage events
// (the server decides). Without the bot the option says "Add the Super FUMBBL bot to your server to create Discord
// events" with the invite button; without a linked Discord account it says to link one. When the sync stopped (no
// organiser can manage events there any more) the reason shows here, and removals that ran out of retries are listed
// with "Retry cleanup".
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
async function load(): Promise<void> {
  try { apply((await leagueEventsApi.discord(api, props.leagueId)).discordEvents); } catch (e) { error.value = e instanceof Error ? e.message : "Can't load this right now."; }
}
onMounted(() => { if (!props.initial) void load(); });

/** The bot is there and the organiser can pick one of their servers. */
const ready = computed(() => Boolean(view.value?.available && view.value.linked && view.value.guilds.length));

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
async function turnOff(): Promise<void> {
  enabled.value = false;
  await save();
}
async function retryCleanup(): Promise<void> {
  busy.value = true; error.value = ""; notice.value = "";
  try {
    const r = await leagueEventsApi.retryCleanup(api, props.leagueId);
    notice.value = r.requeued ? "Cleanup queued again." : "Nothing to clean up.";
    await load();
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : "That did not work.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="hm-panel lev-discord" aria-labelledby="lev-discord-h" data-discord-events>
    <header class="hm-band"><h2 id="lev-discord-h">Discord events</h2><span class="hm-cap">{{ view?.blocked ? "Stopped" : view?.enabled ? "On" : "Optional" }}</span></header>
    <p class="hm-small">Create a Discord event in your server for each League Event: its next date, moved and removed with it.</p>
    <p v-if="!view && !error" class="hm-empty" role="status">Loading...</p>
    <template v-else-if="view">
      <p v-if="view.blocked" class="lev-blocked" role="alert" data-blocked>{{ view.blocked }}</p>
      <template v-if="!view.available">
        <p class="lev-bot-note" data-add-bot>{{ ADD_BOT_TEXT }}.</p>
        <label class="sf-check lev-disabled">
          <input type="checkbox" disabled :checked="false" />
          <span>Create Discord events</span>
        </label>
        <div v-if="view.inviteUrl" class="ls-actions">
          <a class="sf-btn ls-bot-btn" :href="view.inviteUrl" target="_blank" rel="noopener">Add the Super FUMBBL bot to your server</a>
        </div>
        <p class="hm-small muted">The bot needs the Manage Events permission in your server.</p>
      </template>
      <template v-else-if="!ready">
        <p class="lev-bot-note" :data-link-discord="view.linked ? undefined : 'true'" :data-add-bot="view.linked ? 'true' : undefined">{{ view.notice || ADD_BOT_TEXT }}{{ view.notice.endsWith(".") ? "" : "." }}</p>
        <p v-if="view.boundToOther" class="hm-small muted">Another organiser picked this league's server. Only someone who manages events there can change it.</p>
        <p v-if="view.error" class="sf-error">{{ view.error }}</p>
        <div class="ls-actions">
          <a v-if="view.linked && view.inviteUrl" class="sf-btn ls-bot-btn" :href="view.inviteUrl" target="_blank" rel="noopener">Add the Super FUMBBL bot to your server</a>
          <a v-if="!view.linked" class="sf-btn" href="/app/account">Link Discord in Account</a>
          <button v-if="view.enabled" type="button" class="sf-btn" :disabled="busy" @click="turnOff">Turn Discord events off</button>
        </div>
      </template>
      <form v-else class="lev-discord-form" @submit.prevent="save">
        <label class="sf-check">
          <input v-model="enabled" type="checkbox" name="enabled" data-enable />
          <span>Create Discord events</span>
        </label>
        <p v-if="view.boundToOther" class="hm-small muted">Another organiser picked a server you can't manage. Picking one of yours replaces it.</p>
        <label class="sf-field">
          <span class="sf-k">Discord server (servers where you can manage events)</span>
          <select v-model="guildId" name="guild" @change="channelId = ''">
            <option value="">Pick a server</option>
            <option v-for="g in view.guilds" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </label>
        <label class="sf-field">
          <span class="sf-k">Voice or stage channel for online events (optional)</span>
          <select v-model="channelId" name="channel" :disabled="!guildId || guildId !== (view.guildId ?? '')">
            <option value="">None: show the online link as the location</option>
            <option v-for="c in view.channels" :key="c.id" :value="c.id">{{ c.name }}{{ c.type === "stage" ? " (stage)" : "" }}</option>
          </select>
          <small v-if="guildId && guildId !== (view.guildId ?? '')" class="muted">Save the server first, then pick a channel.</small>
        </label>
        <p v-if="view.error" class="sf-error">{{ view.error }}</p>
        <div class="sf-btn-row">
          <button type="submit" class="sf-btn primary" :disabled="busy">{{ busy ? "Saving..." : "Save" }}</button>
          <a v-if="view.inviteUrl" class="lev-invite-link" :href="view.inviteUrl" target="_blank" rel="noopener">Add the bot to another server</a>
        </div>
      </form>
      <div v-if="view.cleanup.length" class="lev-cleanup" data-cleanup>
        <p class="sf-k">Discord events we could not remove</p>
        <ul>
          <li v-for="c in view.cleanup" :key="c.eventId"><b>{{ c.title }}</b> <span class="muted">{{ c.error }}</span></li>
        </ul>
        <button type="button" class="sf-btn small" data-retry-cleanup :disabled="busy" @click="retryCleanup">Retry cleanup</button>
      </div>
      <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="sf-notice" role="status">{{ notice }}</p>
    </template>
    <p v-else class="sf-error" role="alert">{{ error }}</p>
  </section>
</template>
