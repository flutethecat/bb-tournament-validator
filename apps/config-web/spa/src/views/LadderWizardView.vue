<script setup lang="ts">
// Create a ladder (spec-league-ladder-2026-11-02 Q6, lane 8b): /app/leagues/:id/ladders/:ladderId/setup, opened from League
// management -> Ladders (the cog) after "New ladder" made it in setup. Four steps in the league wizard's header-tab pattern:
// General (name, description, played on, copied from the league), Rules (ruleset card and house rules, copied from the
// current season and editable), Ladder settings (ranking method, style, challenge rules, the decline rule, auto-approve,
// periods, end date, redraft trigger and TV cap) and Review. Every Next saves its step (revision-checked); Review saves the
// ladder (it stays in setup, hidden from coaches) or starts it. The server validates every value.
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { API_KEY } from "../app";
import { usePageTitle } from "../shell/pageTitle";
import LeagueSectionHeader from "../components/LeagueSectionHeader.vue";
import HouseRulesFields from "../components/HouseRulesFields.vue";
import PlayedOnToggle from "../components/PlayedOnToggle.vue";
import RulesetCardPicker from "../components/RulesetCardPicker.vue";
import { cardKey, type PackageListItem, type RulesetCard } from "../shared/competition";
import { BB2020_CARD } from "../leagues/wizard";
import {
  formOf, LADDER_STEPS, ladderPath, RANKING_HELP, RANKING_LABEL, settingsLines, stepBody, type LadderDetail, type LadderForm, type LadderRanking, type LadderStep,
} from "../leagues/ladder";
import "../leagues/leagues.css";
import "../leagues/wizard.css";
import "../leagues/ladder.css";

const props = defineProps<{ id: string; ladderId: string }>();
const fetcher = inject(API_KEY)!;
const router = useRouter();
const state = reactive({ loaded: false, error: "", busy: "", notice: "", ladder: null as LadderDetail | null, form: null as LadderForm | null, step: "general" as LadderStep, packages: [] as PackageListItem[], packagesStatus: "idle" as "idle" | "loading" | "ready" | "error" });
const stepDef = computed(() => LADDER_STEPS.find((s) => s.id === state.step)!);
const idx = computed(() => LADDER_STEPS.findIndex((s) => s.id === state.step));
const f = computed(() => state.form!);

async function load(): Promise<void> {
  try {
    const v = await fetcher<{ ladder: LadderDetail }>(ladderPath(props.id, props.ladderId));
    state.ladder = v.ladder;
    state.form = formOf(v.ladder);
    const reached = Math.min(4, Math.max(1, v.ladder.wizard?.step ?? 1));
    state.step = LADDER_STEPS[reached - 1]!.id;
    state.error = "";
  } catch (err) {
    state.error = err instanceof Error && err.message ? err.message : "Can't load this ladder.";
  } finally { state.loaded = true; }
}
async function loadPackages(): Promise<void> {
  state.packagesStatus = "loading";
  try {
    const list = await fetcher<unknown>("/api/packages");
    state.packages = (Array.isArray(list) ? list : []).filter((e): e is PackageListItem => Boolean(e) && typeof (e as { name?: unknown }).name === "string")
      .map((e) => ({ name: e.name, ...(e.description ? { description: e.description } : {}), ...(e.format ? { format: e.format } : {}) }));
    state.packagesStatus = "ready";
  } catch { state.packagesStatus = "error"; }
}
const selectedCard = computed(() => (state.form ? cardKey({ packageName: state.form.rulesetPackage ?? "", ruleset: state.form.ruleset }) : ""));
function pickRuleset(card: RulesetCard): void {
  if (!state.form) return;
  state.form.rulesetPackage = card.packageName || null;
  state.form.ruleset = card.packageName ? "BB2025" : card.ruleset === "BB2020" ? "BB2020" : "BB2025";
}
function pickMethod(m: LadderRanking): void {
  if (!state.form) return;
  const s = state.form.settings;
  s.ranking = m;
  // The method's own defaults (spec round 3): position ladders take the range of 3 and the decline rule.
  if (m === "position") { s.challengeRange = s.challengeRange ?? 3; s.declineRule.enabled = true; }
  else { s.declineRule.enabled = false; }
  // A belt ladder ranks by points: another method switches the belt off.
  if (m !== "points" && s.titles) s.titles.belt = false;
}

// Titles (ladder titles lane): a belt ladder ranks by points (the server enforces it; the form follows).
const t = computed(() => state.form?.settings.titles);
function beltChanged(): void {
  if (state.form?.settings.titles?.belt && state.form.settings.ranking !== "points") pickMethod("points");
}

async function save(step: LadderStep, extra: Record<string, unknown> = {}): Promise<boolean> {
  if (!state.form || !state.ladder) return false;
  state.busy = "save";
  state.error = "";
  try {
    const n = LADDER_STEPS.findIndex((s) => s.id === step) + 2;
    const out = await fetcher<{ ladder: LadderDetail }>(ladderPath(props.id, props.ladderId), { method: "PATCH", body: { revision: state.ladder.revision, ...stepBody(step, state.form), ...(n <= 4 ? { step: n } : {}), ...extra } });
    state.ladder = out.ladder;
    return true;
  } catch (err) {
    state.error = err instanceof Error && err.message ? err.message : "That did not save.";
    return false;
  } finally { state.busy = ""; }
}
async function next(): Promise<void> {
  if (state.busy) return;
  if (await save(state.step)) state.step = LADDER_STEPS[Math.min(3, idx.value + 1)]!.id;
}
function back(): void { state.step = LADDER_STEPS[Math.max(0, idx.value - 1)]!.id; }
async function finish(start: boolean): Promise<void> {
  if (!(await save("review"))) return;
  if (start) {
    state.busy = "start";
    try { await fetcher(`${ladderPath(props.id, props.ladderId)}/start`, { method: "POST", body: {} }); } catch (err) {
      state.error = err instanceof Error && err.message ? err.message : "The ladder could not start.";
      state.busy = "";
      return;
    }
    state.busy = "";
    void router.push({ name: "league-detail", params: { id: props.id }, query: { tab: "ladder", ladder: props.ladderId } });
    return;
  }
  void router.push({ name: "league-settings", params: { id: props.id }, query: { tab: "ladders", ladder: props.ladderId } });
}

// Step tabs in the shell header from 640 px, like the league wizard.
const inHeader = ref(false);
let narrowMq: MediaQueryList | null = null;
const placeTabs = (): void => { inHeader.value = !narrowMq?.matches && Boolean(typeof document !== "undefined" && document.getElementById("sf-header-slot")); };
onMounted(() => {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") { narrowMq = window.matchMedia("(max-width: 639.98px)"); narrowMq.addEventListener?.("change", placeTabs); placeTabs(); }
  void load();
  void loadPackages();
});
onBeforeUnmount(() => { narrowMq?.removeEventListener?.("change", placeTabs); narrowMq = null; });
usePageTitle(() => (state.ladder ? `Set up ${state.ladder.name}` : "Set up a ladder"));
const METHODS: LadderRanking[] = ["position", "points", "rating"];
const reviewLines = computed(() => (state.form ? settingsLines({ ...state.form.settings, ...JSON.parse(JSON.stringify((stepBody("settings", state.form) as { settings: object }).settings)) }) : []));
</script>

<template>
  <div class="hm-page lw-page" :class="{ 'lw-fit sf-fit': state.loaded && !state.error }">
    <LeagueSectionHeader :id="id" active="manage" />
    <Teleport to="#sf-header-slot" :disabled="!inHeader">
      <ol class="lw-steps" :class="{ 'lw-steps-header': inHeader }" aria-label="Set up a ladder: steps">
        <li v-for="s in LADDER_STEPS" :key="s.id">
          <button type="button" class="lw-step" :data-step="s.id" :aria-current="state.step === s.id ? 'step' : undefined" :disabled="Boolean(state.busy) || !state.form" @click="state.step = s.id">
            <span class="lw-step-n">{{ s.n }}</span>{{ s.label }}
          </button>
        </li>
      </ol>
    </Teleport>
    <p v-if="!state.loaded" class="hm-empty" role="status">Loading...</p>
    <section v-else-if="!state.form" class="hm-panel"><header class="hm-band"><h2>Ladder</h2></header><p class="sf-error lw-pad" role="alert">{{ state.error }}</p></section>
    <div v-else class="lw-grid sf-fill">
      <section class="hm-panel lw-pane" :aria-labelledby="`lwl-h-${state.step}`">
        <header class="hm-band">
          <h2 :id="`lwl-h-${state.step}`">{{ stepDef.label }}</h2>
          <span class="hm-cap">Step {{ stepDef.n }} of 4 · {{ state.ladder?.stateLabel }}</span>
        </header>
        <div class="lw-pane-body">
          <!-- 1. General -->
          <div v-if="state.step === 'general'" class="lwl-grid">
            <label class="sf-field lw-field"><span class="sf-k">Ladder name</span><input v-model="f.name" type="text" maxlength="60" required data-field="name" /></label>
            <div class="lw-group"><p class="sf-k">Played on</p><PlayedOnToggle v-model="f.playOnFork" /></div>
            <label class="sf-field lw-field lwl-wide"><span class="sf-k">Description</span><textarea v-model="f.description" rows="4" maxlength="1000" placeholder="What this ladder is for, when games are played..." /></label>
            <p class="lw-help lwl-wide">A ladder runs beside the league's seasons. Coaches join any time and play when they arrange it; the ranking updates after every result.</p>
          </div>
          <!-- 2. Rules -->
          <template v-else-if="state.step === 'rules'">
            <fieldset class="lw-group lw-ruleset">
              <legend class="sf-k">Ruleset</legend>
              <RulesetCardPicker kind="league" :packages="state.packages" :status="state.packagesStatus" :selected="selectedCard" :extra="[BB2020_CARD]" @pick="pickRuleset" @create="router.push({ name: 'tournament-creator', query: { new: '1' } })" @retry="loadPackages()" />
            </fieldset>
            <HouseRulesFields v-model="f.houseRules" kind="league" id-prefix="lwl" />
            <p class="lw-help">Copied from the current season; change only what this ladder plays differently. The team building table follows the season's.</p>
          </template>
          <!-- 3. Ladder settings -->
          <template v-else-if="state.step === 'settings'">
            <fieldset class="lw-group">
              <legend class="sf-k">Ranking</legend>
              <div class="lwl-methods" role="radiogroup" aria-label="Ranking method">
                <button v-for="m in METHODS" :key="m" type="button" role="radio" class="tb-card lwl-method" :data-method="m" :aria-pressed="f.settings.ranking === m ? 'true' : 'false'" :aria-checked="f.settings.ranking === m ? 'true' : 'false'" @click="pickMethod(m)">
                  <strong>{{ RANKING_LABEL[m] }}</strong>
                  <p>{{ RANKING_HELP[m] }}</p>
                </button>
              </div>
            </fieldset>
            <div class="lwl-grid">
              <label class="sf-field lw-field"><span class="sf-k">Style</span>
                <select v-model="f.settings.style" data-field="style"><option value="league">League style: teams progress</option><option value="tournament">Tournament style: rosters reset every game</option></select>
              </label>
              <label v-if="f.settings.ranking === 'rating'" class="sf-field lw-field"><span class="sf-k">Games before ranked</span><input v-model.number="f.settings.minGames" type="number" min="0" max="50" /></label>
              <div v-if="f.settings.ranking === 'points'" class="lw-two">
                <label class="sf-field lw-field"><span class="sf-k">Win</span><input v-model.number="f.settings.points.win" type="number" min="0" max="20" /></label>
                <label class="sf-field lw-field"><span class="sf-k">Draw</span><input v-model.number="f.settings.points.draw" type="number" min="0" max="20" /></label>
                <label class="sf-field lw-field"><span class="sf-k">Loss</span><input v-model.number="f.settings.points.loss" type="number" min="0" max="20" /></label>
              </div>
              <label class="sf-field lw-field"><span class="sf-k">{{ f.settings.ranking === "position" ? "Challenge places above" : "Challenge range (places)" }}</span>
                <input v-model.number="f.settings.challengeRange" type="number" min="1" max="50" :placeholder="f.settings.ranking === 'position' ? '3' : 'Any team'" />
              </label>
              <label class="sf-field lw-field"><span class="sf-k">Play-by deadline (days after accepting)</span><input v-model.number="f.settings.playByDays" type="number" min="1" max="60" /></label>
              <label class="sf-field lw-field"><span class="sf-k">Open challenges per coach</span><input v-model.number="f.settings.maxOpen" type="number" min="1" max="20" /></label>
              <label class="sf-field lw-field"><span class="sf-k">Rematch after (days)</span><input v-model.number="f.settings.rematchDays" type="number" min="0" max="90" /></label>
              <div class="lw-group">
                <label class="sf-check lw-check"><input v-model="f.settings.declineRule.enabled" type="checkbox" data-field="decline" /> Decline rule: repeated declines count as a loss</label>
                <div v-if="f.settings.declineRule.enabled" class="lw-two">
                  <label class="sf-field lw-field"><span class="sf-k">Declines</span><input v-model.number="f.settings.declineRule.count" type="number" min="1" max="20" /></label>
                  <label class="sf-field lw-field"><span class="sf-k">Within (days)</span><input v-model.number="f.settings.declineRule.days" type="number" min="1" max="90" /></label>
                </div>
                <small class="lw-help">Unanswered challenges expire after {{ f.settings.expiryHours }} hours and count as declines while this is on.</small>
              </div>
              <div class="lw-group">
                <label class="sf-check lw-check"><input v-model="f.settings.autoApproveValidated" type="checkbox" data-field="auto-approve" /> Teams built and validated for this ladder join straight away</label>
                <small class="lw-help">You get an "approved through the validator" note. Teams that played elsewhere always wait for your approval.</small>
              </div>
              <label class="sf-field lw-field"><span class="sf-k">Periods (weeks, optional)</span><input v-model="f.periodWeeks" type="number" min="1" max="52" placeholder="No periods" /></label>
              <label class="sf-field lw-field"><span class="sf-k">Ends on (optional)</span><input v-model="f.endsAt" type="date" /></label>
              <label class="sf-field lw-field"><span class="sf-k">Redraft</span>
                <select v-model="f.settings.redraft.trigger"><option value="period-end">At each period end</option><option value="schedule">On fixed dates</option><option value="games">Per team after N games</option></select>
              </label>
              <label v-if="f.settings.redraft.trigger === 'games'" class="sf-field lw-field"><span class="sf-k">Games before a redraft</span><input v-model.number="f.settings.redraft.everyGames" type="number" min="1" max="100" /></label>
              <label class="sf-field lw-field"><span class="sf-k">TV cap (k, optional)</span><input v-model="f.tvCapK" type="number" min="500" max="5000" placeholder="Off" /></label>
            </div>
            <fieldset v-if="t" class="lw-group lwl-titles-set">
              <legend class="sf-k">Titles</legend>
              <label class="sf-check lw-check"><input v-model="t.belt" type="checkbox" data-field="belt" @change="beltChanged" /> Title belt: a champion to beat ("cups go to seasons, belts go to ladders")</label>
              <small class="lw-help">A belt ladder ranks by points, with bonuses for the champion. The top two contenders play an eliminator for the mandatory title shot.</small>
              <div v-if="t.belt" class="lwl-titles">
                <div class="lw-group">
                  <p class="sf-k">Champion bonuses (points)</p>
                  <div class="lw-two">
                    <label class="sf-field lw-field"><span class="sf-k">Per defence</span><input v-model.number="t.bonuses.defence" type="number" min="0" max="20" /></label>
                    <label class="sf-field lw-field"><span class="sf-k">Per week held</span><input v-model.number="t.bonuses.weekHeld" type="number" min="0" max="20" /></label>
                    <label class="sf-field lw-field"><span class="sf-k">Winning it</span><input v-model.number="t.bonuses.winBelt" type="number" min="0" max="20" /></label>
                  </div>
                </div>
                <div class="lw-group">
                  <p class="sf-k">Mandatory challenger</p>
                  <div class="lw-two">
                    <label class="sf-field lw-field"><span class="sf-k">Eliminator (days)</span><input v-model.number="t.eliminatorDays" type="number" min="1" max="60" /></label>
                    <label class="sf-field lw-field"><span class="sf-k">Mandatory (days)</span><input v-model.number="t.mandatoryDays" type="number" min="3" max="90" /></label>
                    <label class="sf-field lw-field"><span class="sf-k">Top N challenge</span><input v-model.number="t.defenceRange" type="number" min="1" max="50" /></label>
                  </div>
                </div>
                <div class="lw-group">
                  <p class="sf-k">Inactive champion</p>
                  <div class="lw-two">
                    <label class="sf-field lw-field"><span class="sf-k">Reminder after (days)</span><input v-model.number="t.inactivityDays" type="number" min="7" max="180" /></label>
                    <label class="sf-field lw-field"><span class="sf-k">Vacate after (more days)</span><input v-model.number="t.graceDays" type="number" min="1" max="60" /></label>
                    <label class="sf-field lw-field"><span class="sf-k">Rumble win (points)</span><input v-model.number="t.bonuses.rumble" type="number" min="0" max="20" /></label>
                  </div>
                </div>
                <div class="lw-group">
                  <label class="sf-check lw-check"><input v-model="t.mitb.enabled" type="checkbox" data-field="mitb" /> Money in the Bank: title-shot contracts</label>
                  <div v-if="t.mitb.enabled" class="lw-two">
                    <label class="sf-field lw-field"><span class="sf-k">Wins in a row</span><input v-model.number="t.mitb.streak" type="number" min="2" max="20" /></label>
                    <label class="sf-field lw-field"><span class="sf-k">Cash in within (days)</span><input v-model.number="t.mitb.cashInDays" type="number" min="7" max="365" /></label>
                    <label class="sf-field lw-field"><span class="sf-k">Cash-in win (points)</span><input v-model.number="t.bonuses.moneyInTheBank" type="number" min="0" max="20" /></label>
                  </div>
                  <small class="lw-help">The champion can't decline a cash-in; it's played within {{ t.mitb.playHours }} hours. Gold, SPP and progression count as in any game.</small>
                </div>
              </div>
            </fieldset>
          </template>
          <!-- 4. Review -->
          <template v-else>
            <dl class="tr-sum">
              <dt>Name</dt><dd>{{ f.name }}</dd>
              <dt>Played on</dt><dd>{{ f.playOnFork ? "Super FUMBBL and the tabletop" : "The tabletop" }}</dd>
              <dt>Ruleset</dt><dd>{{ f.rulesetPackage || f.ruleset }}</dd>
            </dl>
            <ul class="lwl-review"><li v-for="(l, i) in reviewLines" :key="i">{{ l }}</li></ul>
            <p class="lw-help">Saved ladders stay in setup, seen by organisers only, until you start them. Discord posts go to the ladder's own webhook (copied from the league's) in League management -> Ladders.</p>
          </template>
        </div>
        <footer class="lw-foot">
          <button class="sf-btn" type="button" :disabled="state.step === 'general' || Boolean(state.busy)" @click="back">Back</button>
          <p v-if="state.error" class="sf-error lw-msg" role="alert">{{ state.error }}</p>
          <span v-else class="lw-msg"></span>
          <template v-if="state.step === 'review'">
            <button class="sf-btn" type="button" data-action="save" :disabled="Boolean(state.busy)" @click="finish(false)">Save ladder</button>
            <button v-if="state.ladder?.state === 'setup'" class="sf-btn primary" type="button" data-action="start" :disabled="Boolean(state.busy)" @click="finish(true)">{{ state.busy === "start" ? "Starting..." : "Start ladder" }}</button>
          </template>
          <button v-else class="sf-btn primary" type="button" :disabled="Boolean(state.busy)" @click="next">{{ state.busy ? "Saving..." : "Next" }}</button>
        </footer>
      </section>
      <aside class="hm-panel lw-summary" aria-labelledby="lwl-sum-h">
        <header class="hm-band"><h2 id="lwl-sum-h">Ladder</h2><span class="hm-cap">{{ state.ladder?.stateLabel }}</span></header>
        <div class="lw-pane-body">
          <p class="ld-team">{{ f.name }}</p>
          <p class="muted">{{ RANKING_LABEL[f.settings.ranking] }} · {{ f.settings.style === "league" ? "league style" : "tournament style" }}</p>
          <p class="lw-help">Coaches find it on the league page under Ladder once it starts.</p>
          <p><RouterLink class="sf-btn small" :to="{ name: 'league-settings', params: { id }, query: { tab: 'ladders', ladder: ladderId } }">League management</RouterLink></p>
        </div>
      </aside>
    </div>
  </div>
</template>
