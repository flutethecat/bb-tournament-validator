<script setup lang="ts">
import DiscordLoginButton from "./DiscordLoginButton.vue";
// Create Tournament dialog (owner 10-30): Name, Ruleset, Type, then the rule fields Edit Tournament shares (Max players,
// Rounds for Swiss, First tiebreaker). Create = POST /api/tournaments; the new draft opens on its Manage tab. The
// server's refusals (400 / 409) show inline, word for word.
import { computed, inject, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import TournamentRulesFields from "./TournamentRulesFields.vue";
import { createdLocation, FORMAT_OPTIONS, TOURNAMENT_CREATOR_KEY } from "../tournaments/create";
import { FOCUSABLE } from "../home/shell";
import { dialogKey } from "../teams/manage";
import { appPath, discordLoginUrl } from "../session";

// Same keyboard rules as ScheduleDialog / PlayerSheetModal (dialogKey: focus moves in, Tab wraps, Escape closes unless a
// request is in flight, shell shortcuts stopped); App.vue makes the shell behind inert. It closes only on Cancel, the
// close button or Escape (never a backdrop click), and stays open after a 401 so the error and the sign-in link show.
const creator = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = creator;
const route = useRoute();
const router = useRouter();
const root = ref<HTMLElement | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const noPackages = computed(() => state.packagesStatus === "ready" && !state.packages.length);
const loginHref = computed(() => discordLoginUrl(appPath(route.fullPath)));
let opener: HTMLElement | null = null;
let created = false;

async function create(): Promise<void> {
  const id = await creator.submit();
  if (id) { created = true; await router.push(createdLocation(id)); }
}
const close = (): void => creator.close();
const focusables = (): HTMLElement[] =>
  Array.from(root.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null || el === document.activeElement);
function onKey(e: KeyboardEvent): void {
  const action = dialogKey(e, focusables(), document.activeElement as HTMLElement | null, state.busy);
  if (!action) return;
  if (action.type === "stop") { e.stopPropagation(); return; }
  e.preventDefault();
  e.stopPropagation();
  if (action.type === "close") close();
  else if (action.type === "focus") action.target.focus({ preventScroll: true });
}
onMounted(async () => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  window.addEventListener("keydown", onKey, true);
  await nextTick();
  (nameInput.value ?? root.value)?.focus({ preventScroll: true });
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey, true);
  if (created) return;
  // Back to the opener; the account menu item is gone by now, so its avatar button stands in.
  const back = opener && opener !== document.body && opener.isConnected ? opener : document.querySelector<HTMLElement>(".shell-me");
  back?.focus({ preventScroll: true });
});
</script>

<template>
  <div class="tn-modal-backdrop">
    <div ref="root" class="tn-modal tn-panel tc-modal" role="dialog" aria-modal="true" aria-labelledby="tc-modal-h" tabindex="-1" @keydown.stop>
      <h3 id="tc-modal-h" class="tn-band">
        Create Tournament
        <button type="button" class="tn-modal-x" aria-label="Close" :disabled="state.busy" @click="close">×</button>
      </h3>
      <div class="tn-panel-body">
        <form class="tn-form-grid" novalidate @submit.prevent="create">
          <label class="tn-field tn-field-wide"><span class="tn-fact-k">Name</span><input ref="nameInput" v-model="state.form.name" type="text" maxlength="100" autocomplete="off" required /></label>
          <label class="tn-field tn-field-wide">
            <span class="tn-fact-k">Ruleset</span>
            <select v-model="state.form.packageName" required :disabled="!state.packages.length">
              <option v-if="!state.packages.length" value="">{{ state.packagesStatus === "loading" || state.packagesStatus === "idle" ? "Loading rulesets..." : "No saved rulesets" }}</option>
              <option v-for="p in state.packages" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
          <label class="tn-field">
            <span class="tn-fact-k">Type</span>
            <select v-model="state.form.format"><option v-for="f in FORMAT_OPTIONS" :key="f.id" :value="f.id">{{ f.label }}</option></select>
          </label>
          <TournamentRulesFields
            v-model:max-players="state.form.maxPlayers" v-model:round-count="state.form.roundCount" v-model:primary-tiebreaker="state.form.primaryTiebreaker"
            :swiss="state.form.format === 'swiss'" rounds-optional
          />
          <label class="tn-field tn-check-field">
            <span class="tn-fact-k">NAF</span>
            <span class="tn-check-line"><input v-model="state.form.nafSanctioned" type="checkbox" /> NAF sanctioned</span>
          </label>
          <p class="muted tc-full">The tournament starts as a draft. Dates, registration and the page are set on its Manage tab.</p>
          <p v-if="state.packagesStatus === 'error'" class="lobby-error tc-full" role="alert">
            Can't load the rulesets. <button class="lobby-btn small" type="button" @click="creator.loadPackages()">Try again</button>
          </p>
          <p v-else-if="noPackages" class="lobby-error tc-full" role="alert">No saved rulesets yet: save one in the Tournament Creator first.</p>
          <p v-if="state.error" class="lobby-error tc-full" role="alert">
            {{ state.error }}
            <DiscordLoginButton v-if="state.signedOut" :href="loginHref" small />
          </p>
          <div class="tn-actions tn-form-actions">
            <button class="lobby-btn primary" type="submit" :disabled="state.busy || !state.packages.length">{{ state.busy ? "Creating..." : "Create draft" }}</button>
            <button class="lobby-btn" type="button" :disabled="state.busy" @click="close">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
