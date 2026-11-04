<script setup lang="ts">
// League page, Awards tab, Badges panel (badges lane, 11-04): the league's own badges (an organiser's name, description and
// an icon from our glyph set) and their recent awards, public (GET /api/badges/league/:id). Organisers of this league and
// site admins also create badges, award one by hand to a coach or team of the league, revoke an award, archive a badge,
// and read the log (every award and revoke is logged). The coach is told through the draft-aware notifier.
import { computed, inject, nextTick, onMounted, provide, reactive, ref, watch } from "vue";
import { API_KEY } from "../app";
import { SESSION_KEY, writesAllowed } from "../session";
import LeagueDialog from "./LeagueDialog.vue";
import { createLeagueBadges, LEAGUE_BADGES_KEY, type CustomBadgeRow } from "../badges/badges";
import { BADGE_ICONS } from "../../../src/badges/icons";
import "../leagues/honours.css";
import "../badges/badges.css";

const props = defineProps<{ leagueId: string }>();
const api = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const ctl = inject(LEAGUE_BADGES_KEY, null) ?? createLeagueBadges(api);
provide(LEAGUE_BADGES_KEY, ctl);
const { state } = ctl;
onMounted(() => { void ctl.load(props.leagueId); });
watch(() => props.leagueId, (id) => { void ctl.load(id); });
const manage = computed(() => Boolean(state.view?.manage) && writesAllowed(session));
const live = computed(() => (state.view?.badges ?? []).filter((b) => !b.archivedAt));
const archived = computed(() => (state.view?.badges ?? []).filter((b) => b.archivedAt));
const when = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const badgeName = (id: string): string => state.view?.badges.find((b) => b.id === id)?.name ?? "a badge";
const ACTION: Record<string, string> = { award: "awarded", revoke: "revoked", create: "created", edit: "edited", archive: "archived" };

// ---- create ----
const iconKeys = Object.keys(BADGE_ICONS);
const creating = ref(false);
const draft = reactive({ name: "", description: "", icon: "star", scope: "both" });
const tried = ref(false);
function openCreate(): void { Object.assign(draft, { name: "", description: "", icon: "star", scope: "both" }); tried.value = false; creating.value = true; }
const grid = ref<HTMLElement | null>(null);
function onIconKey(e: KeyboardEvent): void {
  const i = iconKeys.indexOf(draft.icon);
  const last = iconKeys.length - 1;
  const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i >= last ? 0 : i + 1) : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i <= 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
  if (to < 0) return;
  e.preventDefault();
  draft.icon = iconKeys[to]!;
  void nextTick(() => grid.value?.querySelectorAll<HTMLElement>("[role=radio]")[to]?.focus());
}
async function submitCreate(): Promise<void> {
  tried.value = true;
  if (!draft.name.trim() || state.busy) return;
  if (await ctl.create({ name: draft.name.trim(), description: draft.description.trim(), icon: draft.icon, scope: draft.scope })) creating.value = false;
}

// ---- award ----
const awarding = ref<CustomBadgeRow | null>(null);
const pick = reactive({ kind: "coach" as "coach" | "team", coach: "", team: "", note: "" });
function openAward(b: CustomBadgeRow): void {
  Object.assign(pick, { kind: b.scope === "team" ? "team" : "coach", coach: "", team: "", note: "" });
  awarding.value = b;
}
const coaches = computed(() => state.view?.members?.coaches ?? []);
const teams = computed(() => state.view?.members?.teams ?? []);
const awardReady = computed(() => (pick.kind === "coach" ? Boolean(pick.coach) : Boolean(pick.team)));
async function submitAward(): Promise<void> {
  const b = awarding.value;
  if (!b || !awardReady.value || state.busy) return;
  const [seasonId, teamId] = pick.team.split("/");
  const to = pick.kind === "coach" ? { coach: pick.coach } : { seasonId: seasonId!, teamId: teamId! };
  if (await ctl.award(b.id, to, pick.note.trim())) awarding.value = null;
}

// ---- revoke (two-step confirm) ----
const confirming = ref("");
async function revoke(id: string): Promise<void> {
  if (confirming.value !== id) { confirming.value = id; return; }
  confirming.value = "";
  await ctl.revoke(id);
}
</script>

<template>
  <section class="hm-panel bd-panel bd-league" aria-labelledby="bd-league-h" data-league-badges>
    <header class="hm-band"><h2 id="bd-league-h">Badges</h2><span class="hm-cap">({{ live.length }})</span></header>
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!state.view" class="hm-empty" role="status">Loading badges...</p>
    <div v-else class="lg-scroll bd-body">
      <div v-if="manage" class="bd-tools"><button type="button" class="sf-btn primary small" :disabled="Boolean(state.busy)" data-new-badge @click="openCreate">New badge</button></div>
      <p v-if="state.notice && !creating && !awarding" class="sf-notice" role="status">{{ state.notice }}</p>
      <p v-if="state.writeError && !creating && !awarding" class="sf-error" role="alert">{{ state.writeError }}</p>
      <p v-if="!live.length" class="hm-empty">{{ manage ? "No league badges yet. Create one to award by hand." : "This league has no badges of its own yet." }}</p>
      <ul v-else class="bd-defs" aria-label="League badges">
        <li v-for="b in live" :key="b.id" class="bd-def" :data-badge-id="b.id">
          <span class="bd-glyph" aria-hidden="true">{{ b.glyph }}</span>
          <div>
            <p class="bd-def-name">{{ b.name }}</p>
            <p v-if="b.description" class="bd-def-desc">{{ b.description }}</p>
            <p class="bd-def-desc">{{ b.awards }} {{ b.awards === 1 ? "award" : "awards" }} · {{ b.scope === "both" ? "Coaches and teams" : b.scope === "coach" ? "Coaches" : "Teams" }}</p>
          </div>
          <div v-if="manage" class="bd-def-acts">
            <button type="button" class="sf-btn small primary" :disabled="Boolean(state.busy)" :aria-label="`Award ${b.name}`" @click="openAward(b)">Award</button>
            <button type="button" class="sf-btn small" :disabled="Boolean(state.busy)" :aria-label="`Archive ${b.name}`" @click="ctl.archive(b.id, true)">Archive</button>
          </div>
        </li>
      </ul>

      <h3 class="bd-section-h">Recent awards</h3>
      <p v-if="!state.view.recent.length" class="hm-empty">No awards yet.</p>
      <ul v-else class="bd-recent" aria-label="Recent badge awards">
        <li v-for="a in state.view.recent" :key="a.id" :data-award-id="a.id">
          <span class="bd-glyph" aria-hidden="true">{{ a.glyph }}</span>
          <div class="bd-rec-main">
            <p><span class="bd-who">{{ a.to.name }}</span> earned <strong>{{ a.name }}</strong></p>
            <p class="bd-when">{{ when(a.at) }}<template v-if="a.by"> · Given by {{ a.by }}</template><template v-if="a.note"> · "{{ a.note }}"</template></p>
          </div>
          <button
            v-if="manage" type="button" class="sf-btn small" :class="{ danger: confirming === a.id }" :disabled="Boolean(state.busy)"
            :aria-label="confirming === a.id ? `Confirm: revoke ${a.name} from ${a.to.name}` : `Revoke ${a.name} from ${a.to.name}`" @click="revoke(a.id)"
          >{{ confirming === a.id ? "Confirm revoke" : "Revoke" }}</button>
        </li>
      </ul>

      <template v-if="manage">
        <template v-if="archived.length">
          <h3 class="bd-section-h">Archived</h3>
          <ul class="bd-defs" aria-label="Archived league badges">
            <li v-for="b in archived" :key="b.id" class="bd-def" data-archived="true">
              <span class="bd-glyph" aria-hidden="true">{{ b.glyph }}</span>
              <p class="bd-def-name">{{ b.name }}</p>
              <div class="bd-def-acts"><button type="button" class="sf-btn small" :disabled="Boolean(state.busy)" @click="ctl.archive(b.id, false)">Restore</button></div>
            </li>
          </ul>
        </template>
        <details v-if="state.view.log?.length" class="bd-log-wrap">
          <summary class="bd-section-h">Log</summary>
          <ul class="bd-log" aria-label="Badge log">
            <li v-for="l in state.view.log" :key="l.id">{{ when(l.at) }}: {{ l.by || "The site" }} {{ ACTION[l.action] ?? l.action }} {{ badgeName(l.badgeId) }}<template v-if="l.subject"> for {{ l.subject.name }}</template><template v-if="l.reason"> ({{ l.reason }})</template></li>
          </ul>
        </details>
      </template>
    </div>

    <LeagueDialog v-if="creating" id="bd-create-h" title="New badge" tag="form" :busy="state.busy === 'create'" @close="creating = false" @submit="submitCreate">
      <div class="aw-form bd-form">
        <label class="sf-field"><span class="sf-k">Name</span><input v-model="draft.name" type="text" maxlength="60" autocomplete="off" placeholder="Iron man" data-autofocus /></label>
        <label class="sf-field"><span class="sf-k">Description (optional)</span><textarea v-model="draft.description" rows="2" maxlength="300" /></label>
        <fieldset class="aw-icon-field">
          <legend class="sf-k">Icon</legend>
          <div ref="grid" class="aw-icons" role="radiogroup" aria-label="Icon" @keydown="onIconKey">
            <button
              v-for="k in iconKeys" :key="k" type="button" role="radio" class="aw-icon-opt bd-icon-glyph" :aria-checked="draft.icon === k ? 'true' : 'false'"
              :tabindex="draft.icon === k ? 0 : -1" :aria-label="BADGE_ICONS[k]!.label" :title="BADGE_ICONS[k]!.label" @click="draft.icon = k"
            ><span aria-hidden="true">{{ BADGE_ICONS[k]!.glyph }}</span></button>
          </div>
        </fieldset>
        <label class="sf-field"><span class="sf-k">Awarded to</span>
          <select v-model="draft.scope"><option value="both">Coaches and teams</option><option value="coach">Coaches</option><option value="team">Teams</option></select>
        </label>
        <p v-if="tried && !draft.name.trim()" class="sf-error" role="alert">Enter a name.</p>
        <p v-else-if="state.writeError" class="sf-error" role="alert">{{ state.writeError }}</p>
      </div>
      <template #foot>
        <button type="button" class="sf-btn" :disabled="state.busy === 'create'" @click="creating = false">Cancel</button>
        <button type="submit" class="sf-btn primary" :disabled="state.busy === 'create'">{{ state.busy === "create" ? "Saving..." : "Create badge" }}</button>
      </template>
    </LeagueDialog>

    <LeagueDialog v-if="awarding" id="bd-award-h" :title="`Award ${awarding.name}`" tag="form" :busy="Boolean(state.busy)" @close="awarding = null" @submit="submitAward">
      <div class="aw-form bd-form">
        <fieldset v-if="awarding.scope === 'both'" class="aw-kind">
          <legend class="sf-k">Recipient</legend>
          <label><input v-model="pick.kind" type="radio" name="bd-kind" value="coach" /> A coach</label>
          <label><input v-model="pick.kind" type="radio" name="bd-kind" value="team" /> A team</label>
        </fieldset>
        <label v-if="pick.kind === 'coach'" class="sf-field"><span class="sf-k">Coach</span>
          <select v-model="pick.coach" data-autofocus><option value="" disabled>Pick a coach</option><option v-for="c in coaches" :key="c" :value="c">{{ c }}</option></select>
        </label>
        <label v-else class="sf-field"><span class="sf-k">Team</span>
          <select v-model="pick.team" data-autofocus>
            <option value="" disabled>Pick a team</option>
            <option v-for="t in teams" :key="`${t.seasonId}/${t.teamId}`" :value="`${t.seasonId}/${t.teamId}`">{{ t.team }} ({{ t.coach || "no coach" }}) · {{ t.seasonName }}</option>
          </select>
        </label>
        <label class="sf-field"><span class="sf-k">Note (optional)</span><textarea v-model="pick.note" rows="2" maxlength="300" /></label>
        <p class="aw-help">The coach is notified and the badge shows on their coach page.</p>
        <p v-if="state.writeError" class="sf-error" role="alert">{{ state.writeError }}</p>
      </div>
      <template #foot>
        <button type="button" class="sf-btn" :disabled="Boolean(state.busy)" @click="awarding = null">Cancel</button>
        <button type="submit" class="sf-btn primary" :disabled="Boolean(state.busy) || !awardReady">{{ state.busy ? "Saving..." : "Award badge" }}</button>
      </template>
    </LeagueDialog>
  </section>
</template>
