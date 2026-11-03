<script setup lang="ts">
// Create a tournament (/app/tournaments/new; registration spec 2026-11-02 §6, lane L3): the step tabs sit in the shell
// header from 640 px (the Roster Builder pattern), the step pane on the left scrolls inside itself, the Tournament
// summary fills in on the right, and the step's actions stay at the foot of the pane (fits 1920x1080, design.md §6).
// Ruleset (+ house rules) -> General -> Format -> Registration -> Review, then Save as draft (unpublished: only its
// organisers see it) or Publish now.
// Server: POST /api/tournaments (src/tournaments/api.ts wizardCreateFields). Controller: tournaments/wizard.ts.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import DiscordLoginButton from "../components/DiscordLoginButton.vue";
import { API_KEY } from "../app";
import { appPath, discordLoginUrl, SESSION_KEY } from "../session";
import { canCreateTournament, createdLocation, FORMAT_OPTIONS, TOURNAMENT_CREATOR_KEY } from "../tournaments/create";
import { PAIRING_LABEL, SEEDING_LABEL } from "../tournaments/detail";
import {
  APPROVAL_LABEL, createTournamentWizard, DRAFT_NOTICE, PUBLISHED_NOTICE, summaryRows, TOURNAMENT_WIZARD_KEY,
  TOURNAMENT_DISCORD_EVENTS, TURN_TIMER_LABEL, WIZARD_STEPS, type WizardStep,
} from "../tournaments/wizard";
import CompetitionFormatFields from "../components/CompetitionFormatFields.vue";
import HouseRulesFields from "../components/HouseRulesFields.vue";
import PlayedOnToggle from "../components/PlayedOnToggle.vue";
import RulesetCardPicker from "../components/RulesetCardPicker.vue";
import { PAY_NOTE, payPalProblem, venmoProblem } from "../shared/payLinks";
import { isDiscordWebhook } from "../shared/discord";
import "../tournaments/wizard.css";

const fetcher = inject(API_KEY)!;
const session = inject(SESSION_KEY)!;
const route = useRoute();
const router = useRouter();
const creator = inject(TOURNAMENT_CREATOR_KEY, null);
// A wizard provided from outside (tests) is used as it stands; otherwise a fresh one per visit.
const provided = inject(TOURNAMENT_WIZARD_KEY, null);
const wizard = provided ?? createTournamentWizard({
  api: fetcher,
  onSignedOut: () => void session.load(true),
  onCreated: (id, published) => creator?.noteCreated(id, published ? PUBLISHED_NOTICE : DRAFT_NOTICE),
});
const { state } = wizard;
const allowed = computed(() => canCreateTournament(session));
const loginHref = computed(() => discordLoginUrl(appPath(route.fullPath)));
const index = computed(() => WIZARD_STEPS.findIndex((s) => s.id === state.step));
const stepTitle: Record<WizardStep, string> = { ruleset: "Pick a ruleset", general: "General", format: "Format", registration: "Registration", review: "Review" };
const rows = computed(() => summaryRows(state.form, state.series));
const payErrors = computed(() => ({ payPal: payPalProblem(state.form.payPal), venmo: venmoProblem(state.form.venmo) }));
const webhookError = computed(() => (state.discord.webhook.trim() && !isDiscordWebhook(state.discord.webhook) ? "Paste the webhook URL from Discord (https://discord.com/api/webhooks/...)." : ""));
const swiss = computed(() => state.form.format === "swiss");
const seriesName = computed(() => state.series.find((s) => s.id === state.form.seriesId)?.name ?? "");
const body = ref<HTMLElement | null>(null);
const query = (k: string) => (typeof route.query[k] === "string" ? (route.query[k] as string) : undefined);

// Header tabs (Roster Builder pattern): in the shell header from 640 px, after mount; inline in server rendering; none on phones.
const inHeader = ref(false);
const phone = ref(false);
let narrowMq: MediaQueryList | null = null;
function placeTabs(): void {
  phone.value = Boolean(narrowMq?.matches);
  inHeader.value = !phone.value && Boolean(typeof document !== "undefined" && document.getElementById("sf-header-slot"));
}
onMounted(() => {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    narrowMq = window.matchMedia("(max-width: 639.98px)");
    narrowMq.addEventListener?.("change", placeTabs);
    placeTabs();
  }
});
onBeforeUnmount(() => { narrowMq?.removeEventListener?.("change", placeTabs); narrowMq = null; });

if (!provided) wizard.start({ packageName: query("package"), seriesId: query("series"), restore: query("fresh") !== "1" });
onMounted(async () => {
  await session.load();
  if (!allowed.value) return;
  await Promise.all([wizard.loadPackages(), wizard.loadSeries()]);
});

function show(step: WizardStep): void {
  if (!wizard.go(step)) return;
  wizard.remember();
  void nextTick(() => { body.value?.scrollTo?.({ top: 0 }); body.value?.focus({ preventScroll: true }); });
}
const next = (): void => show(WIZARD_STEPS[Math.min(index.value + 1, WIZARD_STEPS.length - 1)]!.id);
const back = (): void => show(WIZARD_STEPS[Math.max(index.value - 1, 0)]!.id);
function pick(name: string): void { wizard.pickPackage(name); wizard.remember(); }
function newRuleset(): void {
  wizard.remember();
  void router.push({ name: "tournament-creator", query: { new: "1", return: "wizard" } });
}
/** "Create a star" (creation wizards v2): the picked ruleset's Stars tab in the Tournament Creator; a save comes back here. */
function createStar(): void {
  wizard.remember();
  void router.push({ name: "tournament-creator", query: { package: state.form.packageName, tab: "stars", return: "wizard" } });
}
async function create(publish: boolean): Promise<void> {
  const id = await wizard.submit(publish);
  if (id) await router.push(createdLocation(id));
}
function startOver(): void {
  wizard.forget();
  wizard.start({ restore: false });
}
</script>

<template>
  <div class="hm-page tw-page tw-fit sf-fit">
    <Teleport to="#sf-header-slot" :disabled="!inHeader">
      <nav v-if="allowed && !phone" class="tl-seg tw-steps" :class="{ 'tw-steps-header': inHeader }" aria-label="Create tournament steps">
        <button
          v-for="(s, i) in WIZARD_STEPS" :key="s.id" type="button" class="tl-seg-btn" :data-step="s.id"
          :aria-current="state.step === s.id ? 'step' : undefined" @click="show(s.id)"
        ><b class="tw-num">{{ i + 1 }}</b>{{ s.label }}</button>
      </nav>
    </Teleport>

    <section v-if="!allowed" class="hm-panel" aria-labelledby="tw-denied-h">
      <header class="hm-band"><h2 id="tw-denied-h">Organisers only</h2></header>
      <p v-if="!session.signedIn()">Sign in to create a tournament.</p>
      <p v-else>Site organisers and admins create tournaments. You can ask to become one.</p>
      <div class="sf-btn-row tw-denied-actions">
        <DiscordLoginButton v-if="!session.signedIn()" :href="loginHref" />
        <RouterLink v-else class="sf-btn primary" to="/organiser/request">Ask to become an organiser</RouterLink>
        <RouterLink class="sf-btn" to="/tournaments">All tournaments</RouterLink>
      </div>
    </section>

    <div v-else class="tw-grid sf-fill">
      <section class="hm-panel tw-pane" aria-labelledby="tw-step-h" :data-step="state.step">
        <header class="hm-band"><h2 id="tw-step-h">{{ stepTitle[state.step] }}</h2><span class="hm-cap">Step {{ index + 1 }} of {{ WIZARD_STEPS.length }}</span></header>

        <div ref="body" class="tw-body" tabindex="-1">
          <!-- 1. Ruleset: the shared card picker (Featured first, BB2025 preselected) and the house rules group -->
          <div v-if="state.step === 'ruleset'" class="tw-stack">
            <RulesetCardPicker
              kind="tournament" :packages="state.packages" :status="state.packagesStatus" :selected="state.form.packageName"
              @pick="(c) => pick(c.packageName)" @create="newRuleset" @retry="wizard.loadPackages()"
            />
            <p v-if="state.form.packageName" class="sf-btn-row tw-ruleset-tools">
              <button type="button" class="sf-btn small" data-create-star @click="createStar">Create a star</button>
              <a class="sf-btn small" data-export-summary :href="`/app/ruleset-summary?package=${encodeURIComponent(state.form.packageName)}`" target="_blank" rel="noopener">Export summary</a>
            </p>
            <HouseRulesFields v-model="state.form.houseRules" kind="tournament" id-prefix="tw" />
          </div>

          <!-- 2. General: the event, where it is played -->
          <div v-else-if="state.step === 'general'" class="tw-groups">
            <fieldset class="tw-group">
              <legend class="tw-legend">Event</legend>
              <label class="sf-field tw-wide"><span class="sf-k">Name</span><input v-model="state.form.name" type="text" maxlength="100" autocomplete="off" required /></label>
              <label v-if="state.series.length || state.form.seriesId" class="sf-field tw-wide">
                <span class="sf-k">Series</span>
                <select v-model="state.form.seriesId">
                  <option value="">None</option>
                  <option v-if="state.form.seriesId && !seriesName" :value="state.form.seriesId">{{ state.form.seriesId }}</option>
                  <option v-for="s in state.series" :key="s.id" :value="s.id">{{ s.name }}</option>
                </select>
              </label>
              <label class="sf-field"><span class="sf-k">Starts (UTC)</span><input v-model="state.form.startsAt" type="datetime-local" /></label>
              <label class="sf-field"><span class="sf-k">Ends (UTC)</span><input v-model="state.form.endsAt" type="datetime-local" /></label>
              <label class="sf-field tw-wide"><span class="sf-k">Summary</span><textarea v-model="state.form.summary" rows="3" maxlength="4000" placeholder="What the event is about (shown on its page)"></textarea></label>
            </fieldset>

            <fieldset class="tw-group">
              <legend class="tw-legend">Played on</legend>
              <PlayedOnToggle v-model="state.form.playOnFork" class="tw-wide" />
              <template v-if="!state.form.playOnFork">
                <label class="sf-field tw-wide"><span class="sf-k">Venue</span><input v-model="state.form.venue" type="text" maxlength="120" autocomplete="off" /></label>
                <label class="sf-field tw-wide"><span class="sf-k">Address</span><input v-model="state.form.address" type="text" maxlength="200" autocomplete="off" /></label>
                <label class="sf-field"><span class="sf-k">Map link</span><input v-model="state.form.mapUrl" type="url" maxlength="500" placeholder="https://" /></label>
                <label class="sf-field"><span class="sf-k">Local start time</span><input v-model="state.form.startTime" type="time" /></label>
              </template>
              <p v-else class="tw-help tw-wide">Fixtures are played online: the fixture lobby launches each game.</p>
            </fieldset>
          </div>

          <!-- 3. Format: format, rounds, pairing, seeding, timer; points, the tiebreaker chain, avoidance, regions -->
          <div v-else-if="state.step === 'format'" class="tw-stack">
            <fieldset class="tw-group tw-group-wide">
              <legend class="tw-legend">Format</legend>
              <label class="sf-field">
                <span class="sf-k">Format</span>
                <select v-model="state.form.format"><option v-for="f in FORMAT_OPTIONS" :key="f.id" :value="f.id">{{ f.label }}</option></select>
              </label>
              <label v-if="swiss" class="sf-field"><span class="sf-k">Rounds</span><input v-model.number="state.form.roundCount" type="number" min="1" max="50" step="1" inputmode="numeric" placeholder="Auto" /></label>
              <label v-if="swiss" class="sf-field">
                <span class="sf-k">Pairing</span>
                <select v-model="state.form.pairingSystem">
                  <option value="">Default{{ state.form.seriesId ? " (series)" : " (Dutch)" }}</option>
                  <option v-for="(label, key) in PAIRING_LABEL" :key="key" :value="key">{{ label }}</option>
                </select>
              </label>
              <label class="sf-field">
                <span class="sf-k">Seeding</span>
                <select v-model="state.form.seedingMode"><option v-for="(label, key) in SEEDING_LABEL" :key="key" :value="key">{{ label }}</option></select>
              </label>
              <label class="sf-field">
                <span class="sf-k">Turn timer</span>
                <select v-model="state.form.turnTimer"><option v-for="(label, key) in TURN_TIMER_LABEL" :key="key" :value="key">{{ label }}</option></select>
              </label>
            </fieldset>
            <CompetitionFormatFields
              v-model:points="state.form.points" v-model:chain="state.form.tiebreakerChain" v-model:avoid="state.form.pairingAvoid" v-model:regions="state.form.regions"
              id-prefix="tw" :swiss="swiss"
            />
          </div>

          <!-- 4. Registration -->
          <div v-else-if="state.step === 'registration'" class="tw-groups">
            <fieldset class="tw-group">
              <legend class="tw-legend">Window</legend>
              <label class="sf-field"><span class="sf-k">Opens (UTC)</span><input v-model="state.form.opensAt" type="datetime-local" /></label>
              <label class="sf-field"><span class="sf-k">Closes (UTC)</span><input v-model="state.form.closesAt" type="datetime-local" /></label>
              <p class="tw-help tw-wide">Blank: open as soon as it's published, until the start. Registration never opens before you publish.</p>
            </fieldset>

            <fieldset class="tw-group">
              <legend class="tw-legend">Places</legend>
              <label class="sf-field"><span class="sf-k">Places</span><input v-model.number="state.form.maxPlayers" type="number" min="2" max="512" step="1" inputmode="numeric" required /></label>
              <label class="sf-check tw-check"><input v-model="state.form.waitlist" type="checkbox" /> Waitlist when full</label>
              <div class="sf-tabs small tw-wide" role="group" aria-label="Approval">
                <button type="button" class="sf-tab" :aria-pressed="state.form.approval === 'auto' ? 'true' : 'false'" @click="state.form.approval = 'auto'">Automatic</button>
                <button type="button" class="sf-tab" :aria-pressed="state.form.approval === 'organiser' ? 'true' : 'false'" @click="state.form.approval = 'organiser'">Organisers approve</button>
              </div>
              <p class="tw-help tw-wide">{{ APPROVAL_LABEL[state.form.approval] }}. {{ state.form.approval === "organiser" ? "You accept, waitlist or decline each entry in Manage, Registrations." : "Entries are accepted while there are places." }}</p>
            </fieldset>

            <fieldset class="tw-group">
              <legend class="tw-legend">Rosters</legend>
              <label class="sf-check tw-check tw-wide"><input v-model="state.form.rosterLater" type="checkbox" /> Register now, roster later</label>
              <label v-if="state.form.rosterLater" class="sf-field"><span class="sf-k">Roster deadline (UTC)</span><input v-model="state.form.rosterBy" type="datetime-local" /></label>
              <p class="tw-help tw-wide">{{ state.form.rosterLater ? "Coaches can enter first and submit their roster by the deadline." : "Coaches enter with a team." }}</p>
            </fieldset>

            <fieldset class="tw-group">
              <legend class="tw-legend">Check-in</legend>
              <label class="sf-check tw-check tw-wide"><input v-model="state.form.selfCheckIn" type="checkbox" /> Coaches check themselves in</label>
              <template v-if="state.form.selfCheckIn">
                <label class="sf-field"><span class="sf-k">Opens (UTC)</span><input v-model="state.form.checkInOpensAt" type="datetime-local" /></label>
                <label class="sf-field"><span class="sf-k">Closes (UTC)</span><input v-model="state.form.checkInClosesAt" type="datetime-local" /></label>
                <p class="tw-help tw-wide">Blank: opens 24 hours before the start and closes at the start.</p>
              </template>
            </fieldset>

            <fieldset class="tw-group tw-group-wide">
              <legend class="tw-legend">Entry</legend>
              <label class="sf-field"><span class="sf-k">Entry fee</span><input v-model="state.form.entryFee" type="text" maxlength="40" placeholder="e.g. 15 GBP or Free" autocomplete="off" /></label>
              <label class="sf-field" :data-invalid="payErrors.payPal ? 'true' : undefined">
                <span class="sf-k">PayPal link (optional)</span>
                <input v-model="state.form.payPal" type="url" maxlength="200" placeholder="https://paypal.me/YourName" autocomplete="off" :aria-invalid="payErrors.payPal ? 'true' : undefined" />
                <small v-if="payErrors.payPal" class="sf-error">{{ payErrors.payPal }}</small>
              </label>
              <label class="sf-field" :data-invalid="payErrors.venmo ? 'true' : undefined">
                <span class="sf-k">Venmo username (optional)</span>
                <input v-model="state.form.venmo" type="text" maxlength="31" placeholder="@Your-Name" autocomplete="off" :aria-invalid="payErrors.venmo ? 'true' : undefined" />
                <small v-if="payErrors.venmo" class="sf-error">{{ payErrors.venmo }}</small>
              </label>
              <p class="tw-help tw-wide" data-pay-note="true">Coaches see a "Pay entry fee" block with these links on the overview. {{ PAY_NOTE }}</p>
              <label class="sf-check tw-check"><input v-model="state.form.nafSanctioned" type="checkbox" /> NAF sanctioned</label>
              <p v-if="state.form.nafSanctioned" class="tw-help tw-wide" data-naf-note="true">
                Coaches' NAF name and number come from their profile and go to the organisers with the entry. A coach without one adds it to their profile or says they're not a NAF member. Organisers can set NAF details only for their active entrants.
              </p>
            </fieldset>

            <fieldset class="tw-group tw-group-wide" data-group="discord">
              <legend class="tw-legend">Discord</legend>
              <label class="sf-field tw-wide" :data-invalid="webhookError ? 'true' : undefined">
                <span class="sf-k">Webhook URL (optional)</span>
                <input v-model="state.discord.webhook" type="password" autocomplete="off" spellcheck="false" maxlength="300" placeholder="https://discord.com/api/webhooks/..." />
                <small v-if="webhookError" class="sf-error">{{ webhookError }}</small>
              </label>
              <label v-for="e in TOURNAMENT_DISCORD_EVENTS" :key="e.key" class="sf-check tw-check"><input v-model="state.discord.events[e.key]" type="checkbox" :data-event="e.key" /> {{ e.label }}</label>
              <p class="tw-help tw-wide">Tournament mode: the key events start ticked. Nothing posts while the tournament is a draft. Every event, in-game posts and the digests are in Manage, Discord.</p>
            </fieldset>
          </div>

          <!-- 5. Review: every step grouped (the Roster Builder summary layout) with Edit links -->
          <div v-else class="tw-review" data-review>
            <section v-for="s in WIZARD_STEPS.slice(0, 4)" :key="s.id" class="tw-review-block" :aria-labelledby="`tw-rev-${s.id}`">
              <header class="tw-review-head">
                <h3 :id="`tw-rev-${s.id}`" class="tw-legend">{{ s.label }}</h3>
                <button type="button" class="sf-btn small" :aria-label="`Edit ${s.label.toLowerCase()}`" @click="show(s.id)">Edit</button>
              </header>
              <dl class="tw-facts">
                <div v-for="r in rows[s.id]" :key="r.k"><dt>{{ r.k }}</dt><dd>{{ r.v }}</dd></div>
              </dl>
            </section>
            <p class="tw-help tw-review-note">
              <strong>Save as draft</strong> keeps it hidden: only you and its organisers see it, and nobody can register. <strong>Publish now</strong> makes it public, and registration opens per its window. Both check every step first. You can also publish later from Manage.
            </p>
          </div>
        </div>

        <footer class="tw-foot">
          <p v-if="state.error" class="sf-error" role="alert">
            {{ state.error }}
            <DiscordLoginButton v-if="state.signedOut" :href="loginHref" small />
          </p>
          <div class="sf-btn-row tw-actions">
            <button v-if="index > 0" type="button" class="sf-btn" :disabled="Boolean(state.busy)" @click="back">Back</button>
            <button type="button" class="sf-btn tw-reset" :disabled="Boolean(state.busy)" @click="startOver">Start over</button>
            <template v-if="state.step !== 'review'">
              <button type="button" class="sf-btn primary" @click="next">Next</button>
            </template>
            <template v-else>
              <!-- Payment at Publish (owner 11-02) will slot in before Publish now: see wizard.ts submit, PAYMENT SLOT. -->
              <button type="button" class="sf-btn" data-action="draft" :disabled="Boolean(state.busy)" @click="create(false)">{{ state.busy === "draft" ? "Saving..." : "Save as draft" }}</button>
              <button type="button" class="sf-btn primary" data-action="publish" :disabled="Boolean(state.busy)" @click="create(true)">{{ state.busy === "publish" ? "Publishing..." : "Publish now" }}</button>
            </template>
          </div>
        </footer>
      </section>

      <aside class="hm-panel tw-side" aria-labelledby="tw-sum-h">
        <header class="hm-band" data-tone="info"><h2 id="tw-sum-h">Tournament summary</h2><span class="hm-cap">{{ state.form.packageName ? "In progress" : "Step 1" }}</span></header>
        <div class="tw-side-body">
          <template v-for="s in WIZARD_STEPS.slice(0, 4)" :key="s.id">
            <h3 class="tw-legend tw-side-k">{{ s.label }}</h3>
            <dl class="tw-facts">
              <div v-for="r in rows[s.id]" :key="r.k"><dt>{{ r.k }}</dt><dd>{{ r.v }}</dd></div>
            </dl>
          </template>
        </div>
      </aside>
    </div>
  </div>
</template>
