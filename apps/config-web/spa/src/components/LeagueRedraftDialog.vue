<script setup lang="ts">
// Redraft dialog (the team's coach, or an organiser on their behalf): Rest & Relaxation first (each niggling injury rolls
// off on the target: "Roll for me" rolls on the server, "Enter result" takes tabletop dice), then the Team Draft List:
// budget bar, re-hire list (value + 20k agent fee per season = cost; keep or release, released players retire), staff
// carry-over, new hires from the roster, the remaining budget live, and Submit draft list. The server checks every rule.
import { computed, inject, ref } from "vue";
import { draftTotals, goldK, REDRAFT_TEAM_KEY } from "../leagues/redraft";
import LeagueDialog from "./LeagueDialog.vue";

const emit = defineEmits<{ close: [] }>();
const team = inject(REDRAFT_TEAM_KEY)!;
const { state } = team;
const view = computed(() => state.view);
const totals = computed(() => (view.value ? draftTotals(view.value, state.picks) : null));
const busy = computed(() => Boolean(state.busy));
const entering = ref(false);
const pct = computed(() => {
  const v = view.value;
  const t = totals.value;
  return v && t && v.spendable > 0 ? Math.min(100, Math.round((t.spent / v.spendable) * 100)) : 0;
});
const who = (p: { number: number | null; name: string; position: string }): string => `${p.number !== null ? `#${p.number} ` : ""}${p.name || p.position}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const rollsOf = (playerId: string) => view.value?.rest.rolls.filter((r) => r.playerId === playerId) ?? [];
const title = computed(() => (view.value ? `Redraft: ${view.value.name}` : "Redraft"));
</script>

<template>
  <LeagueDialog id="rd-dialog-h" :title="title" wide :busy="busy" @close="emit('close')">
    <p v-if="state.denied === 'forbidden'" role="alert">This is not your team: only its coach and the league organisers can see its redraft.</p>
    <p v-else-if="state.denied === 'missing'" role="alert">There is no redraft for this team.</p>
    <p v-else-if="state.denied === 'signin'" role="alert">Sign in to see your redraft.</p>
    <p v-else-if="state.error" class="ls-error" role="alert">{{ state.error }}</p>
    <p v-else-if="!view" class="hm-empty" role="status">Loading the redraft...</p>
    <template v-else>
      <p class="rd-sum">{{ view.race }} · from {{ view.sourceSeason.name }} · {{ view.targetSeason ? `next season: ${view.targetSeason.name}` : "kept until the next season starts" }}</p>

      <section class="ls-sub rd-budget" aria-label="Budget">
        <dl class="rd-terms">
          <div><dt>Base</dt><dd>{{ goldK(view.budget.base) }}</dd></div>
          <div><dt>Treasury</dt><dd>{{ goldK(view.budget.treasury) }}</dd></div>
          <div><dt>Games {{ view.budget.played }} · W {{ view.budget.wins }} · D {{ view.budget.draws }}</dt><dd>+{{ goldK(view.budget.bonus) }}</dd></div>
          <div><dt>Budget</dt><dd data-budget>{{ goldK(view.spendable) }}</dd></div>
        </dl>
        <p v-if="view.override" class="hm-small">Organiser override: {{ view.override.reason }}</p>
        <p v-else-if="view.capEnabled && view.budget.raw > view.budget.capped" class="hm-small">Capped at {{ goldK(view.cap) }} (from {{ goldK(view.budget.raw) }}; the excess is lost).</p>
        <div v-if="state.step === 'draft' && totals" class="rd-bar" :data-over="totals.remaining < 0 ? 'true' : undefined" role="meter" :aria-valuenow="totals.spent" aria-valuemin="0" :aria-valuemax="view.spendable" aria-label="Budget spent">
          <span :style="{ width: `${pct}%` }"></span>
        </div>
        <p v-if="state.step === 'draft' && totals" class="rd-remaining" aria-live="polite">Spent <b>{{ goldK(totals.spent) }}</b> · Remaining <b data-remaining>{{ goldK(totals.remaining) }}</b> (goes to the treasury)</p>
      </section>

      <!-- Step 1: Rest & Relaxation -->
      <section v-if="state.step === 'rest'" class="ls-sub" aria-labelledby="rd-rest-h">
        <h3 id="rd-rest-h" class="ls-sub-h">Rest &amp; Relaxation</h3>
        <p class="hm-small">
          Each niggling injury rolls off on a {{ view.rest.target }}+{{ view.apothecaryNow ? " (Apothecary)" : "" }}.
          Missed games and temporary characteristic reductions recover on their own.
        </p>
        <ul class="rd-list">
          <li v-for="n in view.rest.needed" :key="n.playerId">
            <span>{{ n.name || n.position }} · {{ n.niggling }} niggling injur{{ n.niggling === 1 ? "y" : "ies" }}</span>
            <span v-if="entering" class="rd-dice">
              <input
                v-for="(_, i) in state.entered[n.playerId]" :key="i" v-model.number="state.entered[n.playerId]![i]" type="number" min="1" max="6" inputmode="numeric"
                :aria-label="`Result ${i + 1} for ${n.name || n.position}`"
              />
            </span>
          </li>
        </ul>
        <div class="ls-actions">
          <button class="ls-btn primary" type="button" data-autofocus :disabled="busy" @click="team.rollForMe()">Roll for me</button>
          <button v-if="!entering" class="ls-btn" type="button" :disabled="busy" @click="entering = true">Enter result</button>
          <button v-else class="ls-btn" type="button" :disabled="busy || !team.enteredComplete()" @click="team.enterResults()">Save results</button>
        </div>
      </section>

      <!-- Step 2: Team Draft List -->
      <template v-else-if="state.step === 'draft' && totals">
        <section v-if="view.rest.rolls.length" class="ls-sub" aria-labelledby="rd-rr-h">
          <h3 id="rd-rr-h" class="ls-sub-h">Rest &amp; Relaxation results</h3>
          <ul class="rd-list">
            <li v-for="n in view.rest.needed" :key="n.playerId">
              {{ n.name || n.position }}:
              <span v-for="(r, i) in rollsOf(n.playerId)" :key="i" class="rd-roll" :data-ok="r.recovered ? 'true' : 'false'">{{ r.roll }}{{ r.recovered ? " healed" : " stays" }}</span>
            </li>
          </ul>
        </section>

        <section class="ls-sub" aria-labelledby="rd-rehire-h">
          <h3 id="rd-rehire-h" class="ls-sub-h">Re-hire players</h3>
          <p class="hm-small">Cost = current value + {{ goldK(20000) }} agent fee per season played. Players you release retire.</p>
          <div class="lg-scroll">
            <table class="lg-table rd-table">
              <thead><tr><th scope="col">Keep</th><th scope="col">Player</th><th scope="col">Position</th><th scope="col" class="lg-num">Value</th><th scope="col" class="lg-num">Seasons</th><th scope="col" class="lg-num">Fee</th><th scope="col" class="lg-num">Cost</th><th scope="col" class="lg-num">Niggles</th></tr></thead>
              <tbody>
                <tr v-for="p in view.players" :key="p.playerId" :class="{ 'lg-row-picked': state.picks.keep[p.playerId] }" :data-player="p.playerId">
                  <td><input v-model="state.picks.keep[p.playerId]" type="checkbox" :aria-label="`Keep ${who(p)}`" /></td>
                  <th scope="row">{{ who(p) }}<small v-if="!state.picks.keep[p.playerId]" class="rd-sub"> retires</small></th>
                  <td>{{ p.position }}</td>
                  <td class="lg-num">{{ goldK(p.value) }}</td>
                  <td class="lg-num">{{ p.seasons }}</td>
                  <td class="lg-num">{{ goldK(p.fee) }}</td>
                  <td class="lg-num"><b>{{ goldK(p.cost) }}</b></td>
                  <td class="lg-num">{{ p.nigglingAfter }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="ls-sub" aria-labelledby="rd-staff-h">
          <h3 id="rd-staff-h" class="ls-sub-h">Staff</h3>
          <div class="ls-grid rd-staff">
            <label class="ls-field"><span>Rerolls ({{ goldK(view.staff.rerollCost) }} each, max {{ view.staff.maxRerolls }})</span><input v-model.number="state.picks.staff.rerolls" type="number" min="0" :max="view.staff.maxRerolls" inputmode="numeric" /></label>
            <label class="ls-field"><span>Assistant coaches ({{ goldK(view.staff.assistantCoachCost) }} each)</span><input v-model.number="state.picks.staff.assistantCoaches" type="number" min="0" :max="view.limits.assistantCoaches" inputmode="numeric" /></label>
            <label class="ls-field"><span>Cheerleaders ({{ goldK(view.staff.cheerleaderCost) }} each)</span><input v-model.number="state.picks.staff.cheerleaders" type="number" min="0" :max="view.limits.cheerleaders" inputmode="numeric" /></label>
            <label v-if="view.staff.apothecaryAllowed" class="ls-check"><input v-model="state.picks.staff.apothecary" type="checkbox" /> Apothecary ({{ goldK(view.staff.apothecaryCost) }})</label>
          </div>
          <p class="hm-small">Last season: {{ plural(view.staff.current.rerolls, "reroll") }}, {{ plural(view.staff.current.assistantCoaches, "assistant coach", "assistant coaches") }}, {{ plural(view.staff.current.cheerleaders, "cheerleader") }}{{ view.staff.current.apothecary ? ", an Apothecary" : "" }}.</p>
        </section>

        <section v-if="view.positions.length" class="ls-sub" aria-labelledby="rd-hire-h">
          <h3 id="rd-hire-h" class="ls-sub-h">Hire new players</h3>
          <div class="ls-grid rd-staff">
            <label v-for="pos in view.positions" :key="pos.name" class="ls-field">
              <span>{{ pos.name }} ({{ goldK(pos.cost) }}, max {{ pos.max }})</span>
              <input v-model.number="state.picks.hires[pos.name]" type="number" min="0" :max="pos.max" inputmode="numeric" />
            </label>
          </div>
        </section>
        <p v-else-if="!view.knownRoster" class="hm-small">{{ view.race }} is not in the BB2025 rosters: only re-hires are possible here.</p>

        <ul v-if="totals.problems.length" class="rd-problems" role="alert">
          <li v-for="pr in totals.problems" :key="pr">{{ pr }}</li>
        </ul>
        <div class="ls-actions ls-savebar">
          <span class="rd-totals">{{ totals.players }} players · {{ goldK(totals.keepCost) }} re-hires · {{ goldK(totals.hireCost) }} new · {{ goldK(totals.staffCost) }} staff</span>
          <button class="ls-btn primary" type="button" :disabled="busy || totals.problems.length > 0" @click="team.submit()">Submit draft list</button>
        </div>
      </template>

      <!-- Done -->
      <section v-else class="ls-sub" aria-labelledby="rd-done-h">
        <h3 id="rd-done-h" class="ls-sub-h">{{ view.status === "submitted" ? "Draft list submitted" : view.status === "expired" ? "This redraft expired" : view.closed ? "The redraft is closed" : "Taken out of the redraft" }}</h3>
        <p v-if="view.status === 'expired' && view.expiredReason">{{ view.expiredReason }} Ask the league organisers how to go on.</p>
        <p v-if="view.draft">
          {{ plural(view.draft.keep.length, "player") }} re-hired, {{ view.draft.hires.reduce((n, h) => n + h.count, 0) }} new,
          {{ goldK(view.draft.spent) }} spent, {{ goldK(view.draft.treasury) }} to the treasury.
          {{ view.targetSeason ? `The roster is ${view.targetSeason.name}'s team.` : "The roster becomes your team when the next season starts." }}
        </p>
      </section>

      <p v-if="state.message" class="ls-error" role="alert">{{ state.message }}</p>
    </template>
  </LeagueDialog>
</template>
