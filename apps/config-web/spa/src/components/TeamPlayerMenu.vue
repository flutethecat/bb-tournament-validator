<script setup lang="ts">
// The row "+" of the shared team summary (team page v2): a dialog with the advancement picker and, for organisers, the
// band-aid injury list.
//  - Coach, in-season: Primary and Secondary skills the player may take, with this advancement's SPP price; a skill the
//    unspent SPP cannot pay for is disabled with the price shown (the server checks again).
//  - Organiser edit mode: add any skill (search the catalogue or type one), and the band-aid tab: the ruleset's injury
//    table with a short description each; lasting injuries apply their reduction and may also set MNG (unticked by
//    default); Seriously Hurt always sets MNG; Badly Hurt is recorded only; Dead takes the player off the roster.
import { computed, ref } from "vue";
import type { InjuryType, TeamPageView } from "../teams/summary";
import LeagueDialog from "./LeagueDialog.vue";
import TeamInjuryIcon from "./TeamInjuryIcon.vue";

const props = defineProps<{ view: TeamPageView; playerId: string; mode: "coach" | "organiser"; busy?: boolean; initial?: "skill" | "injury" }>();
const emit = defineEmits<{
  close: []; advance: [skill: string, method: "chosenPrimary" | "chosenSecondary"]; addSkill: [skill: string]; injury: [key: string, mng: boolean];
}>();
const player = computed(() => props.view.team.players.find((p) => p.playerId === props.playerId));
const adv = computed(() => props.view.advancement[props.playerId]);
const tab = ref<"skill" | "injury">(props.mode === "organiser" && props.initial === "injury" ? "injury" : "skill");
const q = ref("");
const owned = computed(() => new Set((player.value?.skills ?? []).map((s) => s.toLowerCase())));
const catalogue = computed(() => {
  const want = q.value.trim().toLowerCase();
  return (props.view.skills ?? []).filter((s) => !owned.value.has(s.toLowerCase()) && (!want || s.toLowerCase().includes(want))).slice(0, 60);
});
const typed = computed(() => q.value.trim());
const mngFor = ref<Record<string, boolean>>({});
const iconOf = (i: InjuryType): "lasting" | "mng" | "record" | "dead" => (i.dead ? "dead" : i.recordOnly ? "record" : i.mng === "always" ? "mng" : "lasting");
const title = computed(() => `${player.value?.name || player.value?.position || "Player"}${player.value?.number !== null && player.value?.number !== undefined ? ` #${player.value.number}` : ""}`);
const price = (m: "chosenPrimary" | "chosenSecondary"): number | null => adv.value?.costs[m] ?? null;
const affordable = (m: "chosenPrimary" | "chosenSecondary"): boolean => { const c = price(m); return c !== null && (adv.value?.spp ?? 0) >= c; };
</script>

<template>
  <LeagueDialog id="ts-menu" wide :title="title" :cap="mode === 'coach' ? `${adv?.spp ?? 0} SPP to spend` : 'Edit mode'" :busy="busy" @close="emit('close')">
    <div v-if="mode === 'organiser'" class="sf-tabs ts-menu-tabs" role="tablist" aria-label="Add to player">
      <button type="button" role="tab" class="sf-tab" :aria-selected="tab === 'skill' ? 'true' : 'false'" @click="tab = 'skill'">Add skill</button>
      <button type="button" role="tab" class="sf-tab ts-bandage-tab" :aria-selected="tab === 'injury' ? 'true' : 'false'" title="Injuries" @click="tab = 'injury'"><TeamInjuryIcon kind="bandage" /> Injury</button>
    </div>

    <template v-if="tab === 'skill' && mode === 'coach'">
      <p v-if="!adv" class="hm-empty">This player can't take advancements here.</p>
      <template v-else>
        <section v-for="m in (['chosenPrimary', 'chosenSecondary'] as const)" :key="m" class="ts-adv" :aria-label="m === 'chosenPrimary' ? 'Primary skills' : 'Secondary skills'">
          <h3 class="tb-k">{{ m === "chosenPrimary" ? "Primary" : "Secondary" }} · {{ price(m) === null ? "no more advancements" : `${price(m)} SPP` }}</h3>
          <p v-if="!(m === 'chosenPrimary' ? adv.primary : adv.secondary).length" class="hm-empty hm-small">None to take.</p>
          <div v-else class="ts-skill-grid">
            <button v-for="s in (m === 'chosenPrimary' ? adv.primary : adv.secondary)" :key="s" type="button" class="sf-btn small" :disabled="busy || !affordable(m)" :title="affordable(m) ? undefined : `Needs ${price(m)} SPP`" @click="emit('advance', s, m)">{{ s }}</button>
          </div>
        </section>
      </template>
    </template>

    <template v-else-if="tab === 'skill'">
      <label class="sf-field"><span class="sf-k">Skill</span><input v-model="q" class="sf-input" type="search" maxlength="48" placeholder="Search or type a skill" data-autofocus /></label>
      <div class="ts-skill-grid">
        <button v-for="s in catalogue" :key="s" type="button" class="sf-btn small" :disabled="busy" @click="emit('addSkill', s)">{{ s }}</button>
        <button v-if="typed && !catalogue.some((s) => s.toLowerCase() === typed.toLowerCase()) && !owned.has(typed.toLowerCase())" type="button" class="sf-btn small primary" :disabled="busy" @click="emit('addSkill', typed)">Add "{{ typed }}"</button>
      </div>
    </template>

    <ul v-else class="ts-injuries" aria-label="Injuries">
      <li v-for="i in view.injuries" :key="i.key" class="ts-injury" :data-injury="i.key">
        <span class="ts-injury-ico" :data-kind="iconOf(i)"><TeamInjuryIcon :kind="iconOf(i)" /></span>
        <span class="ts-injury-who"><strong>{{ i.label }}</strong><small>{{ i.text }}</small></span>
        <label v-if="i.mng === 'optional'" class="sf-check ts-injury-mng"><input v-model="mngFor[i.key]" type="checkbox" /> Also misses the next game</label>
        <small v-else-if="i.mng === 'always'" class="ts-injury-mng muted">Sets MNG</small>
        <button type="button" class="sf-btn small" :class="{ danger: i.dead }" :disabled="busy" @click="emit('injury', i.key, i.mng === 'optional' ? mngFor[i.key] === true : i.mng === 'always')">{{ i.dead ? "Record death" : "Apply" }}</button>
      </li>
    </ul>

    <template #foot>
      <button type="button" class="sf-btn" @click="emit('close')">Done</button>
    </template>
  </LeagueDialog>
</template>
