<script setup lang="ts">
// Give award (organisers of the league and site admins): title, an icon from our own set, the season (or league-wide),
// the recipient (a team or a coach of the league; only that season's when one is picked) and a note. The recipient's
// account is notified once by the server.
import { computed, inject, nextTick, reactive, ref, watch } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import { AWARD_ICONS, AWARD_TITLE_MAX, LEAGUE_HONOURS_KEY } from "../leagues/honours";
import "../leagues/honours.css";

const emit = defineEmits<{ close: [] }>();
const honours = inject(LEAGUE_HONOURS_KEY)!;
const { state } = honours;
const recipients = computed(() => state.view?.recipients ?? { seasons: [], teams: [], coaches: [] });
const iconKeys = Object.keys(AWARD_ICONS);

const draft = reactive({ title: "", icon: "star", seasonId: "", kind: "team" as "team" | "coach", team: "", coach: "", note: "" });
const tried = ref(false);
const busy = computed(() => state.busy === "award");
const seasonName = (id: string): string => recipients.value.seasons.find((s) => s.id === id)?.name ?? "";
const teams = computed(() => recipients.value.teams.filter((t) => !draft.seasonId || t.seasonId === draft.seasonId));
const coaches = computed(() => recipients.value.coaches.filter((c) => !draft.seasonId || c.seasonIds.includes(draft.seasonId)));
const teamKey = (t: { seasonId: string; id: string }): string => `${t.seasonId}/${t.id}`;
watch(() => draft.seasonId, () => {
  if (draft.team && !teams.value.some((t) => teamKey(t) === draft.team)) draft.team = "";
  if (draft.coach && !coaches.value.some((c) => c.name === draft.coach)) draft.coach = "";
});
const ready = computed(() => Boolean(draft.title.trim() && draft.icon && (draft.kind === "team" ? draft.team : draft.coach)));
const missing = computed(() => (!draft.title.trim() ? "Enter a title." : draft.kind === "team" && !draft.team ? "Pick a team." : draft.kind === "coach" && !draft.coach ? "Pick a coach." : ""));
const error = computed(() => (tried.value && !busy.value ? state.writeError : ""));

// Icon picker = a radio group: one tab stop, arrows move the choice.
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

async function submit(): Promise<void> {
  tried.value = true;
  if (!ready.value || busy.value) return;
  const [seasonId, teamId] = draft.team.split("/");
  const ok = await honours.give({
    title: draft.title.trim(), icon: draft.icon, note: draft.note.trim(), ...(draft.seasonId ? { seasonId: draft.seasonId } : {}),
    recipient: draft.kind === "team" ? { kind: "team", seasonId: seasonId!, teamId: teamId! } : { kind: "coach", coach: draft.coach },
  });
  if (ok) emit("close");
}
</script>

<template>
  <LeagueDialog id="aw-give-h" title="Give award" tag="form" :busy="busy" @close="emit('close')" @submit="submit">
    <div class="aw-form">
      <label class="sf-field"><span class="sf-k">Title</span><input v-model="draft.title" type="text" :maxlength="AWARD_TITLE_MAX" autocomplete="off" placeholder="Best sportsmanship" data-autofocus /></label>
      <fieldset class="aw-icon-field">
        <legend class="sf-k">Icon</legend>
        <div ref="grid" class="aw-icons" role="radiogroup" aria-label="Icon" @keydown="onIconKey">
          <button
            v-for="k in iconKeys" :key="k" type="button" role="radio" class="aw-icon-opt" :aria-checked="draft.icon === k ? 'true' : 'false'"
            :tabindex="draft.icon === k ? 0 : -1" :aria-label="AWARD_ICONS[k]!.label" :title="AWARD_ICONS[k]!.label" @click="draft.icon = k"
          ><img :src="AWARD_ICONS[k]!.src" alt="" width="32" height="32" /></button>
        </div>
      </fieldset>
      <label class="sf-field"><span class="sf-k">Season</span>
        <select v-model="draft.seasonId">
          <option value="">League-wide (no season)</option>
          <option v-for="s in recipients.seasons" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <fieldset class="aw-kind">
        <legend class="sf-k">Recipient</legend>
        <label><input v-model="draft.kind" type="radio" name="aw-kind" value="team" /> A team</label>
        <label><input v-model="draft.kind" type="radio" name="aw-kind" value="coach" /> A coach</label>
      </fieldset>
      <label v-if="draft.kind === 'team'" class="sf-field"><span class="sf-k">Team</span>
        <select v-model="draft.team">
          <option value="" disabled>Pick a team</option>
          <option v-for="t in teams" :key="teamKey(t)" :value="teamKey(t)">{{ t.name }} ({{ t.coach || "no coach" }}, {{ t.race }}){{ draft.seasonId ? "" : ` · ${seasonName(t.seasonId)}` }}</option>
        </select>
      </label>
      <label v-else class="sf-field"><span class="sf-k">Coach</span>
        <select v-model="draft.coach">
          <option value="" disabled>Pick a coach</option>
          <option v-for="c in coaches" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </label>
      <p v-if="(draft.kind === 'team' ? teams : coaches).length === 0" class="aw-help">{{ draft.seasonId ? "No one in this season yet." : "This league has no teams yet." }}</p>
      <label class="sf-field"><span class="sf-k">Note (optional)</span><textarea v-model="draft.note" rows="3" maxlength="280" /></label>
      <p class="aw-help">The coach is notified, and the award shows on their coach page.</p>
      <p v-if="tried && missing" class="sf-error" role="alert">{{ missing }}</p>
      <p v-else-if="error" class="sf-error" role="alert">{{ error }}</p>
    </div>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <button type="submit" class="sf-btn primary" :disabled="busy">{{ busy ? "Saving..." : "Give award" }}</button>
    </template>
  </LeagueDialog>
</template>
