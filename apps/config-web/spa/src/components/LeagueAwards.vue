<script setup lang="ts">
// League page, Honours tab: every award in the league (the podium and imported season awards, and the awards organisers
// gave), newest first, filterable by season. Organisers and admins get Give award, Pin (to the Hall of Fame) and Remove
// (given awards only: the podium follows Reopen, imported awards stay as recorded).
import { computed, inject, ref } from "vue";
import AwardItem from "./AwardItem.vue";
import LeagueGiveAward from "./LeagueGiveAward.vue";
import LeaguePinDialog from "./LeaguePinDialog.vue";
import { awardsFor, LEAGUE_HONOURS_KEY, recipientLine, type AwardView } from "../leagues/honours";
import "../leagues/honours.css";

defineProps<{ manage: boolean; seasons: ReadonlyArray<{ id: string; name: string }> }>();
const honours = inject(LEAGUE_HONOURS_KEY)!;
const { state } = honours;
const season = ref("");
const awards = computed(() => awardsFor(state.view?.awards ?? [], season.value));
const pinned = computed(() => new Set((state.view?.pins ?? []).filter((p) => p.kind === "award").map((p) => p.awardId)));
const giving = ref(false);
const pinning = ref<AwardView | null>(null);
const confirming = ref("");
async function remove(a: AwardView): Promise<void> {
  if (confirming.value !== a.id) { confirming.value = a.id; return; }
  confirming.value = "";
  await honours.removeAward(a.id);
}
const removeLabel = (a: AwardView): string => (state.busy === `award:${a.id}` ? "Removing..." : confirming.value === a.id ? "Confirm remove" : "Remove");
</script>

<template>
  <section class="hm-panel" aria-labelledby="aw-list-h">
    <header class="hm-band"><h2 id="aw-list-h">Awards</h2><span class="hm-cap">({{ awards.length }})</span></header>
    <div class="aw-tools">
      <label class="sf-field"><span class="sf-k">Season</span>
        <select v-model="season">
          <option value="">All seasons</option>
          <option value="league">League-wide</option>
          <option v-for="s in seasons" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <button v-if="manage && state.view?.recipients" type="button" class="sf-btn primary small" :disabled="Boolean(state.busy)" @click="giving = true">Give award</button>
    </div>
    <p v-if="state.notice && !giving && !pinning" class="sf-notice aw-status" role="status">{{ state.notice }}</p>
    <p v-if="state.writeError && !giving && !pinning" class="sf-error aw-status" role="alert">{{ state.writeError }}</p>
    <p v-if="!state.view && state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.view" class="hm-empty" role="status">Loading awards...</p>
    <p v-else-if="!awards.length" class="hm-empty">{{ season ? "No awards for this choice." : "No awards yet." }}</p>
    <ul v-else class="aw-list" aria-label="Awards">
      <AwardItem v-for="a in awards" :key="a.id" :award="a" :show-source="manage">
        <template v-if="manage">
          <button
            v-if="!pinned.has(a.id)" type="button" class="sf-btn small" :disabled="Boolean(state.busy)"
            :aria-label="`Pin ${a.title} (${recipientLine(a)}) to the Hall of Fame`" @click="pinning = a"
          >Pin</button>
          <button
            v-if="a.source === 'custom'" type="button" class="sf-btn small" :class="{ danger: confirming === a.id }" :disabled="Boolean(state.busy)"
            :aria-label="confirming === a.id ? `Confirm: remove ${a.title}` : `Remove ${a.title}`" @click="remove(a)"
          >{{ removeLabel(a) }}</button>
        </template>
      </AwardItem>
    </ul>
    <LeagueGiveAward v-if="giving" @close="giving = false" />
    <LeaguePinDialog v-if="pinning" kind="award" :award-id="pinning.id" :target="`${pinning.title}: ${recipientLine(pinning)}`" @close="pinning = null" />
  </section>
</template>
