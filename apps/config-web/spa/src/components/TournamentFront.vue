<script setup lang="ts">
// Tournament page front block (spec-main-landing-nav §3 items 1-2): the organiser's banner (fallback: the ruleset
// crest on the recorder hero gradient) under the name, the Series and status chips, the viewer's registration
// (Register / "Registered: <team>" with Change and Withdraw, reusing the My entry actions) and Edit for managers
// (the Manage tab's Tournament page settings, plus "Edit ruleset" into the Tournament Creator).
import { computed, inject, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { appPath, discordLoginUrl, SESSION_KEY, writesAllowed } from "../session";
import {
  myEntrant, registrationOpen, rulesetCreatorHref, rulesetInitials, safeBannerUrl, TOURNAMENT_DETAIL_KEY,
} from "../tournaments/detail";
import { STATUS_LABEL } from "../tournaments/list";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const session = inject(SESSION_KEY)!;
const { state } = detail;
const t = computed(() => state.tournament!);
const coach = computed(() => session.coach());
const canWrite = computed(() => writesAllowed(session));
const banner = computed(() => safeBannerUrl(t.value.bannerUrl));
const failed = ref(false);
watch(banner, () => { failed.value = false; });
const ruleset = computed(() => t.value.rulesetPackName || t.value.packageName || "");
const initials = computed(() => rulesetInitials(ruleset.value || t.value.name));
const mine = computed(() => myEntrant(state));
const entered = computed(() => Boolean(mine.value && !mine.value.droppedAt));
const open = computed(() => registrationOpen(t.value, state.rounds));
const closed = computed(() => t.value.status === "completed" || t.value.status === "cancelled");
const team = computed(() => mine.value?.submission?.teamName || mine.value?.teamName || mine.value?.teamId || "");
const entryLink = computed(() => ({ name: "tournament-detail", params: { id: t.value.id }, hash: "#tn-entry-h" }));
const editLink = computed(() => ({ name: "tournament-detail", params: { id: t.value.id }, query: { tab: "manage" }, hash: "#tn-page-h" }));
const signIn = computed(() => discordLoginUrl(appPath(`/tournaments/${t.value.id}`)));
</script>

<template>
  <header class="tn-front" :data-banner="banner && !failed ? 'image' : 'crest'">
    <div class="tn-front-art" aria-hidden="true">
      <img v-if="banner && !failed" class="tn-front-img" :src="banner" alt="" @error="failed = true" />
      <svg v-else class="tn-front-crest" viewBox="0 0 64 72" focusable="false">
        <path class="tn-crest-shield" d="M32 2 L60 12 V36 C60 52 48 64 32 70 C16 64 4 52 4 36 V12 Z" />
        <path class="tn-crest-band" d="M4 30 H60 V40 H4 Z" />
        <text class="tn-crest-text" x="32" y="38" text-anchor="middle">{{ initials }}</text>
      </svg>
    </div>
    <div class="tn-front-body">
      <h2 class="tn-front-name">{{ t.name }}</h2>
      <p class="tn-front-chips">
        <RouterLink v-if="t.seriesId" class="tn-chip tn-chip-link" :to="`/series/${encodeURIComponent(t.seriesId)}`">Series</RouterLink>
        <span class="tn-chip" :data-status="t.status">{{ STATUS_LABEL[t.status] ?? t.status }}</span>
      </p>
      <div class="tn-front-actions">
        <template v-if="entered">
          <span class="tn-front-reg">Registered: <strong>{{ team }}</strong></span>
          <template v-if="canWrite && !closed">
            <RouterLink class="lobby-btn small" :to="entryLink">Change</RouterLink>
            <button class="lobby-btn small" type="button" :disabled="Boolean(state.busy)" @click="detail.withdraw()">Withdraw</button>
          </template>
        </template>
        <template v-else-if="open && !closed">
          <RouterLink v-if="coach && canWrite && !mine" class="lobby-btn primary" :to="entryLink">Register</RouterLink>
          <a v-else-if="!coach" class="lobby-btn primary" :href="signIn">Sign in to register</a>
        </template>
        <template v-if="state.capabilities.manage && canWrite">
          <RouterLink class="lobby-btn small" :to="editLink">Edit</RouterLink>
          <a v-if="ruleset" class="lobby-btn small" :href="rulesetCreatorHref(ruleset)">Edit ruleset</a>
        </template>
      </div>
    </div>
  </header>
</template>
