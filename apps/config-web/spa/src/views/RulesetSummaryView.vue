<script setup lang="ts">
// Ruleset summary (/app/ruleset-summary?package=<name>[&tournament=<id>|&league=<id>], creation wizards v2 Q3): the
// shareable read-only page of a ruleset, laid out for reviewers, plus a PDF of the same content. Public: no sign-in. The
// server builds every value (src/rulesetSummary.ts) and hides a draft package from anyone but organisers. No comments.
import { computed, inject, onMounted, onServerPrefetch, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { API_KEY } from "../app";
import { ApiError } from "../shared/api";
import { usePageTitle } from "../shell/pageTitle";
import { goldCell, goldText, ruleKind, sanitizeSummary, summaryPdfDoc, summaryPdfName, teamColumns, type RulesetSummaryView } from "../tournaments/rulesetSummary";
import "../../../public/sheet-pdf.js";
import "../tournaments/summary.css";
import { copyText } from "../shell/copyText";

const api = inject(API_KEY)!;
const route = useRoute();
const view = ref<RulesetSummaryView | null>(null);
const error = ref("");
const loading = ref(true);
const pdfBusy = ref(false);
const pdfError = ref("");
const q = (k: string): string => (typeof route.query[k] === "string" ? (route.query[k] as string) : "");

async function load(): Promise<void> {
  const name = q("package");
  loading.value = true;
  error.value = "";
  view.value = null;
  if (!name) { error.value = "No ruleset was named in the link."; loading.value = false; return; }
  const extra = q("tournament") ? `&tournament=${encodeURIComponent(q("tournament"))}` : q("league") ? `&league=${encodeURIComponent(q("league"))}` : "";
  try {
    view.value = sanitizeSummary(await api<unknown>(`/api/ruleset-summary?package=${encodeURIComponent(name)}${extra}`));
    if (!view.value) error.value = "This ruleset summary could not be read.";
  } catch (e) {
    error.value = (e instanceof ApiError ? e.status : (e as { status?: number }).status) === 404 ? "This ruleset doesn't exist or isn't public yet." : `Couldn't load the ruleset (${(e as Error).message}).`;
  } finally {
    loading.value = false;
  }
}
onServerPrefetch(load);
onMounted(() => { if (!view.value) void load(); });
watch(() => [route.query.package, route.query.tournament, route.query.league], () => void load());
usePageTitle(() => (view.value ? `Ruleset summary · ${view.value.name}` : "Ruleset summary"));

const cols = computed(() => (view.value ? teamColumns(view.value) : []));
const shareUrl = computed(() => (typeof window === "undefined" ? "" : window.location.href));
const copied = ref(false);
async function copyLink(): Promise<void> {
  try { await copyText(shareUrl.value); copied.value = true; setTimeout(() => (copied.value = false), 2000); } catch { copied.value = false; }
}

interface SheetPdfGlobal { loadPdfMake(): Promise<{ createPdf(doc: unknown): { getBlob(): Promise<Blob> } }> }
async function downloadPdf(): Promise<void> {
  if (!view.value || pdfBusy.value) return;
  pdfBusy.value = true;
  pdfError.value = "";
  try {
    const pdf = (globalThis as unknown as { SheetPdf?: SheetPdfGlobal }).SheetPdf;
    if (!pdf) throw new Error("the PDF writer is not loaded");
    const make = await pdf.loadPdfMake();
    const blob = await make.createPdf(summaryPdfDoc(view.value)).getBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = summaryPdfName(view.value.name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) {
    pdfError.value = `Couldn't make the PDF (${(e as Error).message}). Use your browser's Print instead.`;
  } finally {
    pdfBusy.value = false;
  }
}
</script>

<template>
  <div class="hm-page rs-page sf-fit">
    <p v-if="loading" class="hm-empty" role="status">Loading the ruleset summary...</p>
    <section v-else-if="error" class="hm-panel" aria-labelledby="rs-err-h">
      <header class="hm-band"><h2 id="rs-err-h">Ruleset summary</h2></header>
      <p class="hm-empty">{{ error }}</p>
    </section>
    <template v-else-if="view">
      <section class="hm-panel rs-head" aria-labelledby="rs-name">
        <header class="hm-band"><h2 id="rs-name">{{ view.name }}</h2><span class="hm-cap">Ruleset summary</span></header>
        <div class="rs-head-body">
          <p class="rs-meta">
            <span v-if="view.draft" class="sf-chip" data-tone="urgent" data-draft>Draft: not public</span>
            <span v-if="view.format === 'sevens'" class="sf-chip" data-tone="muted">Sevens</span>
            <span v-if="view.competition" class="sf-chip" data-tone="ok">{{ view.competition.kind === "league" ? "League" : "Tournament" }}: {{ view.competition.name }}</span>
            <span v-if="view.description" class="rs-desc">{{ view.description }}</span>
          </p>
          <div class="sf-btn-row rs-actions">
            <button type="button" class="sf-btn" data-copy-link @click="copyLink">{{ copied ? "Link copied" : "Copy link" }}</button>
            <button type="button" class="sf-btn primary" data-download-pdf :disabled="pdfBusy" @click="downloadPdf">{{ pdfBusy ? "Making the PDF..." : "Download PDF" }}</button>
          </div>
        </div>
        <p v-if="pdfError" class="sf-error" role="alert">{{ pdfError }}</p>
      </section>

      <div class="rs-grid sf-fill">
        <div class="rs-col sf-scroll sf-col">
          <section class="hm-panel" aria-labelledby="rs-limits-h" data-section="limits">
            <header class="hm-band"><h2 id="rs-limits-h">Budget and limits</h2></header>
            <dl class="rs-kv"><template v-for="l in view.limits" :key="l.k"><dt>{{ l.k }}</dt><dd>{{ l.v }}</dd></template></dl>
          </section>
          <section class="hm-panel" aria-labelledby="rs-bans-h" data-section="bans">
            <header class="hm-band"><h2 id="rs-bans-h">Bans</h2></header>
            <dl class="rs-kv">
              <dt>Star Players</dt><dd>{{ view.bans.stars.length ? view.bans.stars.join(", ") : "None" }}</dd>
              <dt>Skills</dt><dd>{{ view.bans.skills.length ? view.bans.skills.join(", ") : "None" }}</dd>
            </dl>
          </section>
          <section class="hm-panel" aria-labelledby="rs-house-h" data-section="house-rules">
            <header class="hm-band"><h2 id="rs-house-h">House rules</h2><span class="hm-cap">{{ view.competition ? view.competition.name : "Per competition" }}</span></header>
            <dl v-if="view.houseRules" class="rs-kv">
              <template v-for="r in view.houseRules" :key="r.k"><dt>{{ r.k }}</dt><dd>{{ r.v }}</dd></template>
              <template v-if="view.progression"><dt>{{ view.progression.k }}</dt><dd data-progression>{{ view.progression.v }}</dd></template>
            </dl>
            <p v-else class="hm-empty">Each league or tournament using this ruleset sets its own house rules and progression. Open the summary from a competition to see them.</p>
          </section>
          <section class="hm-panel" aria-labelledby="rs-stars-h" data-section="custom-stars">
            <header class="hm-band"><h2 id="rs-stars-h">Custom stars</h2><span class="hm-cap">{{ view.customStars.length || "none" }}</span></header>
            <p v-if="!view.customStars.length" class="hm-empty">This ruleset has no custom stars.</p>
            <article v-for="s in view.customStars" :key="s.name" class="rs-star">
              <span class="sprite-frame rs-sprite" aria-hidden="true"><span class="sprite-fallback">{{ s.name.slice(0, 2).toUpperCase() }}</span><img v-if="s.sprite" class="sprite-image" :src="s.sprite" alt="" /></span>
              <div class="rs-star-body">
                <h3 class="rs-star-name">{{ s.name }} <small>{{ goldText(s.cost) }}</small></h3>
                <p class="rs-star-stats">MA {{ s.MA }} · ST {{ s.ST }} · AG {{ s.AG }} · PA {{ s.PA }} · AV {{ s.AV }}</p>
                <p class="rs-star-skills">{{ s.skills.join(", ") || "No skills" }}</p>
                <div v-if="s.specialRules.length" class="rs-special" data-special-rules>
                  <span class="rs-special-h">Special rules</span>
                  <p v-for="(r, i) in s.specialRules" :key="i"><b>{{ r.name }}</b> <small>{{ ruleKind(r.kind) }}</small><br />{{ r.description }}</p>
                </div>
              </div>
            </article>
          </section>
        </div>

        <div class="rs-col sf-scroll sf-col">
          <section class="hm-panel" aria-labelledby="rs-tiers-h" data-section="tiers">
            <header class="hm-band"><h2 id="rs-tiers-h">Tiers</h2></header>
            <dl class="rs-kv rs-highlights"><template v-for="l in view.overview.summary" :key="l.label"><dt>{{ l.label }}</dt><dd>{{ l.text }}<template v-if="l.details.length"> ({{ l.details.join(", ") }})</template></dd></template></dl>
            <div class="rs-table-wrap">
              <table class="sf-table rs-table">
                <thead><tr><th scope="col">Team</th><th scope="col">Gold</th><th scope="col">Skills</th><th v-for="c in cols" :key="c.key" scope="col">{{ c.label }}</th></tr></thead>
                <tbody v-for="g in view.overview.groups" :key="g.label">
                  <tr class="rs-group"><th :colspan="3 + cols.length" scope="rowgroup">{{ g.label }}</th></tr>
                  <tr v-for="t in g.teams" :key="t.name"><th scope="row">{{ t.name }}</th><td>{{ goldCell(t) }}</td><td>{{ t.allotment.join(" / ") }}</td><td v-for="c in cols" :key="c.key">{{ t[c.key] ?? "" }}</td></tr>
                </tbody>
              </table>
            </div>
          </section>
          <section class="hm-panel" aria-labelledby="rs-ind-h" data-section="inducements">
            <header class="hm-band"><h2 id="rs-ind-h">Inducements</h2><span class="hm-cap">{{ view.inducements.length }}</span></header>
            <div class="rs-table-wrap">
              <table class="sf-table rs-table">
                <thead><tr><th scope="col">Inducement</th><th scope="col">Price</th><th scope="col">Max</th><th scope="col">Notes</th></tr></thead>
                <tbody><tr v-for="i in view.inducements" :key="i.name" :data-house-rule="i.houseRule ? 'true' : undefined"><th scope="row">{{ i.name }}</th><td>{{ goldText(i.price) }}</td><td>{{ i.max ?? "—" }}</td><td>{{ i.note }}</td></tr></tbody>
              </table>
            </div>
          </section>
        </div>

        <div class="rs-col sf-scroll sf-col">
          <section class="hm-panel" aria-labelledby="rs-access-h" data-section="skill-access">
            <header class="hm-band"><h2 id="rs-access-h">Skill access</h2><span class="hm-cap">P primary · S secondary</span></header>
            <div class="rs-table-wrap">
              <table class="sf-table rs-table rs-access">
                <thead><tr><th scope="col">Team</th><th scope="col">Position</th><th v-for="c in view.skillAccess.categories" :key="c" scope="col" :title="c">{{ c.slice(0, 3) }}</th></tr></thead>
                <tbody><tr v-for="(r, i) in view.skillAccess.rows" :key="i"><th scope="row">{{ r.race }}</th><td>{{ r.position }}</td><td v-for="(c, j) in r.cells" :key="j" :data-access="c || undefined">{{ c }}</td></tr></tbody>
              </table>
            </div>
          </section>
          <p v-if="view.dataNote" class="rs-note">Rules note: {{ view.dataNote }}</p>
        </div>
      </div>
    </template>
  </div>
</template>
