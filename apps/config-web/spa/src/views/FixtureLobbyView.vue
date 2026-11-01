<script setup lang="ts">
// Fixture lobby (/app/leagues/:id/seasons/:seasonId/fixtures/:fixtureId/lobby; spec-landing-bubble-retro §8 layout v2):
// one lobby per fixture where the two coaches chat, lock their rosters and pre-match inducements, press Ready and start
// the game. Public read: anyone may watch (no chat, no unrevealed picks); the two coaches and the organisers act.
// Layout: breadcrumb + Standings / Rules / Leave lobby, the recorder's hero split, then 300 / fluid / 300 columns
// (YOU + your inducements | fixture, chat, start | opponent + their inducements); one column below 1100 px.
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import { usePageTitle } from "../shell/pageTitle";
import LobbyChat from "../components/LobbyChat.vue";
import LobbyCoachPanel from "../components/LobbyCoachPanel.vue";
import LobbyFixtureCentre from "../components/LobbyFixtureCentre.vue";
import LobbyInducements from "../components/LobbyInducements.vue";
import LobbyStart from "../components/LobbyStart.vue";
import { crestFor, day, initials } from "../leagues/league";
import { createFixtureLobby, FIXTURE_LOBBY_KEY, kGold, mySide, otherSide, type LobbySide } from "../leagues/lobby";
import { leagueFixtureRef, proposePath } from "../schedule/schedule";
import "../leagues/leagues.css";
import "../leagues/lobby.css";

const props = defineProps<{ id: string; seasonId: string; fixtureId: string }>();
const fetcher = inject(API_KEY)!;
const lobby = inject(FIXTURE_LOBBY_KEY, null) ?? createFixtureLobby({ api: fetcher });
provide(FIXTURE_LOBBY_KEY, lobby);
const { state } = lobby;
const view = computed(() => state.view);
const left = computed<LobbySide>(() => (view.value ? mySide(view.value) : "home"));
const right = computed<LobbySide>(() => otherSide(left.value));
const crests = ref<Record<string, string>>({});
usePageTitle(() => (view.value ? `${view.value.sides.home.team.name} v ${view.value.sides.away.team.name}` : "Fixture lobby"));

onMounted(async () => {
  await lobby.load(props.id, props.seasonId, props.fixtureId);
  lobby.start();
  try { crests.value = (await fetcher<{ crests?: Record<string, string> }>("/crests/manifest.json"))?.crests ?? {}; } catch { /* initials badges */ }
});
watch(() => [props.id, props.seasonId, props.fixtureId], () => { void lobby.load(props.id, props.seasonId, props.fixtureId); });
onBeforeUnmount(() => lobby.stop());

// "Propose a time" (Schedule, ruling §7): for the two coaches while the lobby is open.
const proposeTo = computed(() => (view.value?.open && (view.value.viewer.role === "home" || view.value.viewer.role === "away")
  ? proposePath(leagueFixtureRef(props.id, props.seasonId, props.fixtureId)) : ""));
const crest = (s: LobbySide): string => (view.value ? crestFor(crests.value, view.value.sides[s].team.race) : "");
const midLine = computed(() => {
  const h = view.value?.header;
  if (!h) return "";
  return [day(h.date ?? ""), h.table ? `Table ${h.table}` : ""].filter(Boolean).join(" · ") || "No date set";
});
</script>

<template>
  <div class="fl-page">
    <p v-if="!state.loaded" class="hm-empty">Loading the lobby…</p>
    <section v-else-if="!view" class="hm-panel" aria-labelledby="fl-err">
      <header class="hm-band"><h2 id="fl-err">Fixture lobby</h2></header>
      <p class="sf-error" role="alert">{{ state.error || "Can't load this lobby." }}</p>
      <RouterLink class="sf-btn small" :to="`/leagues/${encodeURIComponent(id)}`">Back to the league</RouterLink>
    </section>
    <template v-else>
      <div class="fl-crumbs">
        <nav aria-label="Breadcrumb">
          <RouterLink to="/leagues">Leagues</RouterLink><span aria-hidden="true">/</span>
          <RouterLink :to="view.links.competition">{{ view.header.competition }}</RouterLink><span aria-hidden="true">/</span>
          <span>Round {{ view.header.round }}{{ view.header.table ? ` · Table ${view.header.table}` : "" }}</span>
        </nav>
        <div class="sf-btn-row">
          <RouterLink v-if="proposeTo" class="sf-btn small primary" data-propose :to="proposeTo">Propose a time</RouterLink>
          <RouterLink class="sf-btn small" :to="view.links.standings">Standings</RouterLink>
          <RouterLink class="sf-btn small" :to="view.links.rules">Rules</RouterLink>
          <RouterLink class="sf-btn small" :to="view.links.fixture">Leave lobby</RouterLink>
        </div>
      </div>

      <header class="fl-hero" aria-label="Fixture">
        <template v-for="(s, i) in [left, right]" :key="s">
          <div v-if="i === 1" class="fl-hero-mid">
            <small>Round {{ view.header.round }}{{ view.header.phase ? ` · ${view.header.phase}` : "" }}</small>
            <span class="fl-vs">VS</span>
            <small>{{ midLine }}</small>
          </div>
          <div class="fl-hero-side" :data-seat="s" :data-pos="i === 0 ? 'left' : 'right'">
            <img v-if="crest(s)" class="fl-crest" :src="crest(s)" alt="" width="56" height="56" />
            <span v-else class="fl-crest-blank" aria-hidden="true">{{ initials(view.sides[s].team.name) }}</span>
            <div>
              <p class="fl-hero-name">{{ view.sides[s].team.name }}</p>
              <p class="fl-hero-meta">{{ view.sides[s].team.race }} · TV {{ kGold(view.sides[s].team.tv) }} · {{ view.sides[s].coach }}</p>
            </div>
          </div>
        </template>
      </header>

      <p v-if="!view.open && !view.started" class="sf-chip" data-tone="muted" style="justify-self: start">{{ view.closedReason }}</p>
      <p v-if="view.hold" class="fl-banner" role="status" data-hold-page><strong>Start held</strong>{{ view.hold.banner }}</p>
      <p v-if="state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
      <p v-else-if="state.notice" class="sf-notice" role="status">{{ state.notice }}</p>

      <div class="fl-grid">
        <div class="fl-col">
          <LobbyCoachPanel :view="view" :side="left" :mine="true" />
          <LobbyInducements :view="view" :side="left" />
        </div>
        <div class="fl-col">
          <LobbyFixtureCentre :view="view" :left="left" />
          <LobbyStart :view="view" />
          <LobbyChat v-if="view.chat" :view="view" />
          <section v-else class="hm-panel fl-panel" aria-labelledby="fl-chat-off">
            <header class="hm-band" data-tone="info"><h2 id="fl-chat-off">Fixture chat</h2></header>
            <p class="hm-empty">The chat is for the two coaches and the organisers.</p>
          </section>
        </div>
        <div class="fl-col">
          <LobbyCoachPanel :view="view" :side="right" :mine="false" />
          <LobbyInducements :view="view" :side="right" />
        </div>
      </div>
    </template>
  </div>
</template>
