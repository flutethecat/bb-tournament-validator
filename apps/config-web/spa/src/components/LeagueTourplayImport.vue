<script setup lang="ts">
// League management → TourPlay import (lane L8), also the wizard's "Import from TourPlay" (mode="wizard": upload, preview
// and apply only, with a link here for the review). The organiser uploads the export they downloaded from TourPlay (a .zip
// or its .csv files; nothing is fetched from TourPlay, law 20a), sees what will be imported (seasons, teams, fixtures,
// coaches matched / not / ambiguous), picks an account per coach where they want, and applies. The review list keeps the
// coaches nobody is linked to with likely matches (suggestions only: nothing fuzzy is linked without a pick) and coach
// claims ("Is this you?") to approve or decline. The server sends NAF numbers only for rows linked to a site coach.
import { computed, inject, reactive, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { API_KEY } from "../app";
import {
  ACTION_LABEL, BASIS_LABEL, createTourplayImport, STATUS_LABEL, STATUS_TONE, ZIP_MAX_MB, type PreviewCoach, type ReviewRow,
} from "../leagues/tourplayImport";
import "../leagues/tourplayImport.css";

const props = withDefaults(defineProps<{ leagueId: string; mode?: "full" | "wizard" }>(), { mode: "full" });
const ctl = createTourplayImport({ api: inject(API_KEY)! });
const { state } = ctl;
const input = ref<HTMLInputElement | null>(null);
const allSeasons = ref(true);
const showLinked = ref(false);
const other = reactive<Record<string, string>>({});

watch(() => props.leagueId, (id) => { if (props.mode === "full") void ctl.loadReview(id); else state.leagueId = id; }, { immediate: true });

const onPick = (e: Event): void => { void ctl.pick(props.leagueId, [...((e.target as HTMLInputElement).files ?? [])]); };
const cancel = (): void => { ctl.reset(); if (input.value) input.value.value = ""; };
const busy = computed(() => Boolean(state.busy));
const preview = computed(() => state.preview);
const seasonsReady = computed(() => preview.value?.seasons.filter((s) => !s.problem).length ?? 0);
const applyLabel = computed(() => (seasonsReady.value === 1 ? `Import ${preview.value?.seasons.find((s) => !s.problem)?.name ?? "season"}` : `Import ${seasonsReady.value} seasons`));
const coachCaption = computed(() => {
  const c = preview.value?.counts;
  return c ? `${c.linked} confirmed · ${c.proposed} proposed · ${c.unmatched + c.ambiguous + c.conflict} without a match` : "";
});
const unconfirmed = computed(() => preview.value?.coaches.filter((c) => c.status === "matched" && c.proposed && !c.confirmed).length ?? 0);

/** The account a preview row will get, and the choices its picker offers. */
const pickValue = (c: PreviewCoach): string => (Object.prototype.hasOwnProperty.call(state.decisions, c.id) ? (state.decisions[c.id] === null ? "__none__" : state.decisions[c.id]!) : "");
const choices = (c: { proposed?: string; coachId?: string; candidates?: { byName: string[]; byNumber: string[] }; suggestions: Array<{ coach: string }> }): string[] =>
  [...new Set([c.proposed, c.coachId, ...(c.candidates?.byNumber ?? []), ...(c.candidates?.byName ?? []), ...c.suggestions.map((s) => s.coach)].filter((x): x is string => Boolean(x)))];
const onChoice = (c: PreviewCoach, e: Event): void => {
  const v = (e.target as HTMLSelectElement).value;
  void ctl.decide(c.id, v === "" ? undefined : v === "__none__" ? null : v);
};
const defaultLabel = (c: PreviewCoach): string => (c.decision ? (c.decision.coachId ? `Confirmed: ${c.decision.coachId}` : "Confirmed: no account") : "Not linked yet");
const useOther = (id: string, preview: boolean): void => {
  const name = (other[id] ?? "").trim();
  if (!name) return;
  other[id] = "";
  if (preview) void ctl.decide(id, name); else void ctl.assign(id, name, allSeasons.value);
};

const rows = computed(() => state.review?.rows ?? []);
const open = computed(() => rows.value.filter((r) => r.needsReview));
const linked = computed(() => rows.value.filter((r) => !r.needsReview));
const seasonsLine = (r: ReviewRow): string => r.seasons.map((s) => `S${s.number}: ${s.teams.join(", ") || "no team"}`).join(" · ");
const linkLine = (r: ReviewRow): string => {
  if (r.decision) return r.decision.coachId ? `${r.decision.coachId} (${r.decision.via === "claim" ? "claim approved" : "organiser"})` : "No account (organiser)";
  if (r.obsolete) return "No longer in the latest export";
  if (r.assignedOnTeams) return `${r.coachId} (assigned on the teams)`;
  return r.coachId ?? "";
};
const onChoose = (id: string, e: Event): void => { void ctl.choose(id, (e.target as HTMLInputElement).checked); };
const when = (iso: string): string => iso.slice(0, 16).replace("T", " ");
</script>

<template>
  <section class="hm-panel tpi" aria-labelledby="tpi-h" data-tourplay-import>
    <header class="hm-band"><h2 id="tpi-h">TourPlay import</h2><span class="hm-cap">{{ preview ? "Preview" : "Upload" }}</span></header>
    <div class="tpi-body">
      <p class="tpi-help">
        Upload the export you downloaded from TourPlay's organiser pages: the .zip, or its .csv files. Only the files you
        pick are read; nothing is fetched from TourPlay. Uploading the same season again updates it and keeps the coach
        accounts you assigned.
      </p>
      <div class="tpi-pick">
        <label class="sf-field">
          <span class="sf-k">Export files</span>
          <input ref="input" class="sf-input" type="file" accept=".zip,.csv,application/zip,text/csv" multiple :disabled="busy" data-tourplay-file @change="onPick" />
        </label>
        <small class="tpi-muted">One .zip up to {{ ZIP_MAX_MB }} MB, or the .csv files. Payment, checked and observation columns are not imported; NAF numbers are kept privately for matching coaches.</small>
      </div>
      <p v-if="state.busy === 'preview'" class="hm-empty" role="status">Reading the export...</p>
      <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
      <p v-if="state.notice" class="sf-notice" role="status">{{ state.notice }}
        <RouterLink v-if="mode === 'wizard'" :to="{ name: 'league-settings', params: { id: leagueId }, query: { tab: 'tourplay' } }">Review the coaches</RouterLink>
      </p>
    </div>
  </section>

  <section v-if="preview" class="hm-panel tpi" aria-labelledby="tpi-prev-h" data-tourplay-preview>
    <header class="hm-band"><h2 id="tpi-prev-h">What will be imported</h2><span class="hm-cap">{{ preview.seasons.length }} {{ preview.seasons.length === 1 ? "season" : "seasons" }} · {{ preview.coaches.length }} coaches</span></header>
    <div class="tpi-body">
      <ul class="tpi-seasons">
        <li v-for="s in preview.seasons" :key="s.slug" class="tpi-season" :data-problem="s.problem ? 'true' : undefined">
          <div class="tpi-season-head">
            <strong>{{ s.name ?? `Season ${s.number}` }}</strong>
            <span class="sf-chip" :data-tone="s.problem ? 'urgent' : s.action === 'new' ? 'ok' : 'soon'">{{ s.problem ? "Can't import" : ACTION_LABEL[s.action] }}</span>
            <span v-if="s.ruleset" class="sf-chip" data-tone="muted">{{ s.ruleset }}</span>
            <span v-if="s.status" class="sf-chip" data-tone="muted">{{ s.status === "active" ? "In progress" : "Completed" }}</span>
          </div>
          <p v-if="s.problem" class="sf-error">{{ s.problem }}</p>
          <dl v-else class="tpi-facts">
            <div><dt>Teams</dt><dd>{{ s.teams }}</dd></div>
            <div><dt>Players</dt><dd>{{ s.players }}</dd></div>
            <div><dt>Fixtures</dt><dd>{{ s.fixtures }} ({{ s.played }} played)</dd></div>
            <div><dt>Standings</dt><dd>{{ s.standings }}</dd></div>
            <div><dt>Honours</dt><dd>{{ s.honours }}</dd></div>
            <div><dt>Awards</dt><dd>{{ s.awards }}</dd></div>
          </dl>
          <p v-if="s.renumbered" class="tpi-muted">Season {{ s.renumbered.from }} is a season made here and is kept: this export becomes Season {{ s.number }}.</p>
          <p v-if="s.derivedTeams?.length" class="tpi-muted">No roster file for {{ s.derivedTeams.join(", ") }}: added without players.</p>
          <p v-if="s.merge" class="tpi-muted">Merge: {{ s.merge.fixturesAdded }} fixtures added, {{ s.merge.fixturesUpdated }} updated, {{ s.merge.teamsAdded }} teams added, {{ s.merge.teamsUpdated }} updated; changes made here are kept.</p>
          <div v-if="s.conflicts?.length" class="tpi-conflicts" data-merge-conflicts>
            <span class="sf-k">Kept here ({{ s.conflicts.length }}): tick to use the export instead</span>
            <label v-for="cf in s.conflicts" :key="cf.id" class="sf-check tpi-conflict">
              <input type="checkbox" :checked="state.choices.includes(cf.id)" :disabled="busy" @change="onChoose(cf.id, $event)" />
              <span><strong>{{ cf.label }}</strong> <span class="tpi-muted">{{ cf.reason }} · here: {{ cf.local }} · export: {{ cf.export }}</span></span>
            </label>
          </div>
          <p v-if="!s.problem && s.phases?.length" class="tpi-muted">{{ s.phases.join(" · ") }}{{ s.mismatches ? ` · ${s.mismatches} standings rows differ from the fixtures` : "" }}</p>
        </li>
      </ul>

      <h3 class="tpi-sub">Coaches <span class="tpi-muted">{{ coachCaption }}</span></h3>
      <p class="tpi-help">A NAF match is only a proposal: NAF details on a profile are typed by the coach. Nothing is linked until you confirm it.</p>
      <div v-if="unconfirmed" class="sf-btn-row"><button class="sf-btn small" type="button" :disabled="busy" data-confirm-all @click="ctl.confirmAll()">Confirm all exact matches ({{ unconfirmed }})</button></div>
      <ul class="tpi-rows">
        <li v-for="c in preview.coaches" :key="c.id" class="tpi-row" :data-status="c.status" data-preview-coach>
          <div class="tpi-who">
            <strong>{{ c.name }}</strong>
            <span class="tpi-muted">{{ c.nafUser ? `NAF ${c.nafUser}` : "No NAF name" }}{{ c.hasNafNumber ? " · NAF number on file" : "" }} · {{ c.teams.join(", ") }}</span>
          </div>
          <div class="tpi-match">
            <span class="sf-chip" :data-tone="STATUS_TONE[c.status]">{{ STATUS_LABEL[c.status] }}</span>
            <span class="tpi-muted">Basis: {{ BASIS_LABEL[c.basis] }}{{ c.proposed ? `, proposes ${c.proposed}` : "" }}</span>
            <span v-if="c.confirmed" class="sf-chip" data-tone="info">Confirmed</span>
            <span v-if="c.reason" class="tpi-muted">{{ c.reason }}</span>
            <span v-if="c.suggestions.length" class="tpi-muted">Likely: {{ c.suggestions.map((s) => `${s.coach} (${s.reasons.join(", ")})`).join("; ") }}</span>
          </div>
          <div class="tpi-pickrow">
            <label class="sf-field tpi-account">
              <span class="sf-k">Account</span>
              <select class="sf-input" :value="pickValue(c)" :disabled="busy" :aria-label="`Account for ${c.name}`" @change="onChoice(c, $event)">
                <option value="">{{ defaultLabel(c) }}</option>
                <option v-for="o in choices(c)" :key="o" :value="o">{{ o }}</option>
                <option value="__none__">No account</option>
              </select>
            </label>
            <form class="tpi-other" @submit.prevent="useOther(c.id, true)">
              <input v-model="other[c.id]" class="sf-input" type="text" maxlength="64" placeholder="Other coach" :aria-label="`Other coach for ${c.name}`" />
              <button class="sf-btn small" type="submit" :disabled="busy || !other[c.id]">Use</button>
            </form>
          </div>
        </li>
      </ul>
      <ul v-if="preview.problems.length" class="tpi-problems"><li v-for="p in preview.problems" :key="p" class="sf-error">{{ p }}</li></ul>
      <div class="sf-btn-row tpi-actions">
        <button class="sf-btn" type="button" :disabled="busy" @click="cancel">Cancel</button>
        <button class="sf-btn primary" type="button" :disabled="busy || !preview.canApply" data-tourplay-apply @click="ctl.apply()">{{ state.busy === "apply" ? "Importing..." : applyLabel }}</button>
      </div>
    </div>
  </section>

  <section v-if="mode === 'full'" class="hm-panel tpi" aria-labelledby="tpi-rev-h" data-tourplay-review>
    <header class="hm-band"><h2 id="tpi-rev-h">Coach review</h2><span class="hm-cap">{{ state.review ? `${state.review.counts.review} to review · ${state.review.counts.claims} claims` : "" }}</span></header>
    <div class="tpi-body">
      <p v-if="!state.review && state.busy === 'review'" class="hm-empty" role="status">Loading...</p>
      <p v-else-if="state.review && !rows.length" class="hm-empty">No TourPlay import yet. Upload an export above.</p>
      <template v-else-if="state.review">
        <p class="tpi-help">TourPlay coaches nobody is linked to yet. Pick the site coach they are, or mark them as not on the site. Coaches can also claim a name ("Is this you?") from the league page.</p>
        <label class="sf-check tpi-check"><input v-model="allSeasons" type="checkbox" /> Apply to every season of that name</label>
        <p v-if="!open.length" class="hm-empty">Every imported coach is linked or decided.</p>
        <ul class="tpi-rows">
          <li v-for="r in open" :key="r.id" class="tpi-row" :data-status="r.status" data-review-row>
            <div class="tpi-who">
              <strong>{{ r.name }}</strong>
              <span class="tpi-muted">{{ r.nafUser ? `NAF ${r.nafUser}` : "No NAF name" }}{{ r.hasNafNumber ? " · NAF number on file" : "" }}</span>
              <span class="tpi-muted">{{ seasonsLine(r) }}</span>
            </div>
            <div class="tpi-match">
              <span class="sf-chip" :data-tone="STATUS_TONE[r.status]">{{ STATUS_LABEL[r.status] }}</span>
              <span class="tpi-muted">Basis: {{ BASIS_LABEL[r.basis] }}</span>
              <span v-if="r.reason" class="tpi-muted">{{ r.reason }}</span>
            </div>
            <div v-if="r.claims.length" class="tpi-claims">
              <div v-for="cl in r.claims" :key="cl.id" class="tpi-claim" data-claim>
                <span><strong>{{ cl.coach }}</strong> says this is them <span class="tpi-muted">· {{ when(cl.at) }}</span></span>
                <span class="sf-btn-row">
                  <button class="sf-btn small" type="button" :disabled="busy" @click="ctl.decideClaim(cl.id, 'decline')">Decline</button>
                  <button class="sf-btn small primary" type="button" :disabled="busy" @click="ctl.decideClaim(cl.id, 'approve', allSeasons)">Approve</button>
                </span>
              </div>
            </div>
            <div class="tpi-suggest">
              <span class="sf-k">Likely matches</span>
              <span v-if="!r.suggestions.length" class="tpi-muted">None found.</span>
              <button v-for="s in r.suggestions" :key="s.coach" class="sf-btn small tpi-sugg" type="button" :disabled="busy" :title="s.reasons.join(', ')" @click="ctl.assign(r.id, s.coach, allSeasons)">
                Link to {{ s.coach }} <span class="tpi-why">{{ s.reasons.join(", ") }}</span>
              </button>
            </div>
            <div class="tpi-pickrow">
              <form class="tpi-other" @submit.prevent="useOther(r.id, false)">
                <input v-model="other[r.id]" class="sf-input" type="text" maxlength="64" placeholder="Site coach name" :aria-label="`Site coach for ${r.name}`" />
                <button class="sf-btn small" type="submit" :disabled="busy || !other[r.id]">Link</button>
              </form>
              <button class="sf-btn small" type="button" :disabled="busy" @click="ctl.assign(r.id, null, allSeasons)">Not on the site</button>
            </div>
          </li>
        </ul>
        <button v-if="linked.length" class="sf-btn small tpi-toggle" type="button" :aria-expanded="showLinked" @click="showLinked = !showLinked">{{ showLinked ? "Hide" : "Show" }} linked coaches ({{ linked.length }})</button>
        <ul v-if="showLinked" class="tpi-rows tpi-linked">
          <li v-for="r in linked" :key="r.id" class="tpi-row tpi-row-done" data-linked-row>
            <div class="tpi-who"><strong>{{ r.name }}</strong><span class="tpi-muted">{{ seasonsLine(r) }}</span></div>
            <div class="tpi-match"><span>{{ linkLine(r) || "No account" }}</span><span v-if="r.nafNumber" class="tpi-muted">NAF number {{ r.nafNumber }}</span></div>
            <div v-if="!r.obsolete" class="tpi-pickrow">
              <form class="tpi-other" @submit.prevent="useOther(r.id, false)">
                <input v-model="other[r.id]" class="sf-input" type="text" maxlength="64" placeholder="Change to" :aria-label="`Change the account for ${r.name}`" />
                <button class="sf-btn small" type="submit" :disabled="busy || !other[r.id]">Change</button>
              </form>
            </div>
          </li>
        </ul>
        <p v-if="state.review.imports.length" class="tpi-muted tpi-last">Last import {{ when(state.review.imports[0]!.at) }} by {{ state.review.imports[0]!.by }}: {{ state.review.imports[0]!.seasons.map((s) => `Season ${s.number}`).join(", ") }}.</p>
      </template>
    </div>
  </section>
</template>
