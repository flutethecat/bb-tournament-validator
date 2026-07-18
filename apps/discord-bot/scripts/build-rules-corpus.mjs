/**
 * Rebuild BB-Bot's local BB2025 rules mirror from bloodbowlbase.ru into
 * data-store/rules-corpus.md (gitignored local cache — the grognard's rules grounding).
 *
 * Polite by design: fetches the ~11 core-rules pages ONCE, sequentially, ~1.5s apart, with a
 * descriptive UA — so we never hammer their site. Run this only to (re)build the mirror after a
 * rules update; the running bot never hits the site, it reads the cached corpus.
 *
 *   node scripts/build-rules-corpus.mjs
 */

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";

const BASE = "https://bloodbowlbase.ru/bb2025/core_rules";
const UA = "BB-Bot-rules-mirror/1.0 (private FLGS Discord gimmick; one-time local cache to avoid repeat load)";
const PAGES = [
  ["game_essentials", "Game Essentials"],
  ["rules_and_regulations", "Rules & Regulations"],
  ["the_game_of_blood_bowl", "The Game of Blood Bowl"],
  ["drafting_a_blood_bowl_team", "Drafting a Team"],
  ["league_play", "League Play"],
  ["matched_play", "Matched Play"],
  ["exhibition_play", "Exhibition Play"],
  ["skills_and_traits", "Skills & Traits"],
  ["inducements", "Inducements"],
  ["latest_faq", "Latest FAQ"],
  ["cheat_sheet", "Cheat Sheet"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function toText(html) {
  const m = html.match(/<article[^>]*md-typeset[^>]*>([\s\S]*?)<\/article>/i);
  let s = m ? m[1] : html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<(h[1-6])[^>]*>/gi, (_, h) => "\n\n" + "#".repeat(+h[1]) + " ").replace(/<\/h[1-6]>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
  s = s.replace(/<\/(p|div|tr|table|ul|ol|section)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<(td|th)[^>]*>/gi, " | ");
  s = s.replace(/<[^>]+>/g, "");
  s = decode(s);
  s = s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

const OUT = fileURLToPath(new URL("../data-store/rules-corpus.md", import.meta.url));

async function main() {
  let out = "# BLOOD BOWL 2025 — CORE RULES (local mirror of bloodbowlbase.ru/bb2025, cached for BB-Bot)\n";
  for (const [slug, title] of PAGES) {
    const res = await fetch(`${BASE}/${slug}/`, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
    let t = toText(await res.text());
    const i = t.indexOf("# ");
    if (i > 0 && i < 600) t = t.slice(i); // drop leading breadcrumb echo
    out += `\n\n\n=== ${title} (core_rules/${slug}) ===\n\n${t}`;
    console.log(`${slug}: ${t.length} chars`);
    await sleep(1500); // be polite
  }
  writeFileSync(OUT, out);
  console.log(`\nwrote ${OUT} — ${out.length} chars (~${Math.round(out.length / 4)} tokens)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
