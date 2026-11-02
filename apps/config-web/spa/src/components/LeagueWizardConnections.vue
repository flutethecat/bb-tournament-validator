<script setup lang="ts">
// Create a league, step 4 Connections (Discord only since creation wizards v2; Played on moved to General): the Discord
// webhook (a secret: never shown back, only "connected"; a test post once it is saved) with the event toggles.
import { computed, inject } from "vue";
import { DISCORD_EVENT_LABEL } from "../leagues/settings";
import { DISCORD_EVENTS, LEAGUE_WIZARD_KEY } from "../leagues/wizard";

const wizard = inject(LEAGUE_WIZARD_KEY)!;
const { state } = wizard;
const c = computed(() => state.form.connections);
const configured = computed(() => Boolean(state.draft?.connections.discord.configured) && !c.value.clearWebhook);
</script>

<template>
  <div class="lw-cols">
    <div class="lw-col">
      <fieldset class="lw-group">
        <legend class="sf-k">Discord</legend>
        <p class="lw-help">Post league news, fixtures and results to a channel. Paste the channel's webhook URL (Server settings, Integrations, Webhooks).</p>
        <p v-if="configured" class="lw-status"><span class="sf-chip" data-tone="ok">Connected</span> {{ state.draft?.connections.discord.maskedUrl }}</p>
        <p v-else-if="c.clearWebhook" class="lw-status"><span class="sf-chip" data-tone="muted">Removed</span> Saved when you press Next.</p>
        <label class="sf-field lw-field" :data-invalid="state.errors.webhook ? 'true' : undefined">
          <span class="sf-k">{{ configured ? "Replace webhook URL" : "Webhook URL" }}</span>
          <input v-model="c.webhook" type="password" autocomplete="off" spellcheck="false" placeholder="https://discord.com/api/webhooks/..." />
          <small v-if="state.errors.webhook" class="sf-error">{{ state.errors.webhook }}</small>
        </label>
        <div class="sf-btn-row">
          <button v-if="configured" class="sf-btn small" type="button" :disabled="Boolean(state.busy)" @click="wizard.testDiscord()">Send a test post</button>
          <button v-if="configured" class="sf-btn small" type="button" @click="c.clearWebhook = true; c.webhook = ''">Remove webhook</button>
          <button v-if="c.clearWebhook" class="sf-btn small" type="button" @click="c.clearWebhook = false">Keep webhook</button>
        </div>
      </fieldset>
      <fieldset class="lw-group">
        <legend class="sf-k">Post to Discord</legend>
        <label v-for="k in DISCORD_EVENTS" :key="k" class="sf-check lw-check"><input v-model="c.events[k]" type="checkbox" /> {{ DISCORD_EVENT_LABEL[k] }}</label>
      </fieldset>
    </div>
  </div>
</template>
