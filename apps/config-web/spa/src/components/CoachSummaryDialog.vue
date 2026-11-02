<script setup lang="ts">
// Coach summary popup (owner 11-02): a coach's avatar, win rate, games and W-D-L in this league (all time), titles, and
// a link to their league record (the Statistics tab's coach records). Shared: any league page opens it from a coach name.
// Public data only (leagues/popups.ts): the league statistics read and the site's public avatar route; never an email,
// phone or Discord id. Reads the page's statistics controller (LEAGUE_STATS_KEY) when there is one, else loads its own.
import { computed, inject, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import LeagueDialog from "./LeagueDialog.vue";
import { createLeagueStats, initials, LEAGUE_STATS_KEY, pct } from "../leagues/league";
import { coachAvatarSrc, coachSummaryOf, findCoachRecord, wdlLine } from "../leagues/popups";

const props = defineProps<{ leagueId: string; coach: string; coachId?: string; team?: string; race?: string }>();
const emit = defineEmits<{ close: [] }>();
const api = inject(API_KEY)!;
const stats = inject(LEAGUE_STATS_KEY, null) ?? createLeagueStats({ api });
const all = computed(() => (stats.state.id === props.leagueId ? stats.state.byScope.all : undefined));
const record = computed(() => findCoachRecord(all.value, props.coach, props.coachId));
const summary = computed(() => (record.value ? coachSummaryOf(record.value) : null));
const loading = computed(() => !all.value && !stats.state.error);
const avatar = computed(() => coachAvatarSrc(props.coachId));
const avatarFailed = ref(false);
watch(avatar, () => { avatarFailed.value = false; });
const profile = computed(() => ({ name: "league-stats", params: { id: props.leagueId }, query: { scope: "all" }, hash: "#lg-coach-h" }));
onMounted(() => { if (!all.value) void stats.load(props.leagueId, "all"); });
</script>

<template>
  <LeagueDialog id="cs-dialog-h" :title="coach" cap="Coach" @close="emit('close')">
    <div class="cs-head" data-coach-summary>
      <img v-if="avatar && !avatarFailed" class="cs-avatar" :src="avatar" alt="" width="64" height="64" referrerpolicy="no-referrer" @error="avatarFailed = true" />
      <span v-else class="cs-avatar cs-avatar-blank" aria-hidden="true">{{ initials(coach) }}</span>
      <div class="cs-who">
        <strong class="cs-name">{{ coach }}</strong>
        <span v-if="team" class="cs-team">{{ team }}<template v-if="race"> · {{ race }}</template></span>
      </div>
    </div>
    <p v-if="loading" class="hm-empty" role="status">Loading the coach's record...</p>
    <p v-else-if="!summary" class="hm-empty">No games recorded in this league yet.</p>
    <dl v-else class="cs-stats">
      <div data-stat="winrate"><dt>Win rate</dt><dd>{{ pct(summary.winRate) }}</dd></div>
      <div data-stat="games"><dt>Games</dt><dd>{{ summary.games }}</dd></div>
      <div data-stat="wdl"><dt>W-D-L</dt><dd>{{ wdlLine(summary) }}</dd></div>
      <div data-stat="titles"><dt>Titles</dt><dd>{{ summary.titles }}</dd></div>
    </dl>
    <p v-if="summary?.seasons.length" class="hm-small muted cs-seasons">Seasons {{ summary.seasons.join(", ") }} · {{ summary.teams }} {{ summary.teams === 1 ? "team" : "teams" }}</p>
    <template #foot>
      <RouterLink class="sf-btn" :to="profile" data-coach-profile-link @click="emit('close')">League record</RouterLink>
      <button type="button" class="sf-btn primary" @click="emit('close')">Close</button>
    </template>
  </LeagueDialog>
</template>
