/**
 * Optional LLM path for "Ask BB-Bot". The grognard can be voiced by EITHER backend, chosen at the
 * single invoke point (`llmComplete`) by the GROGNARD_BACKEND settings variable:
 *
 *   GROGNARD_BACKEND=claude → Anthropic Claude via @anthropic-ai/sdk (needs ANTHROPIC_API_KEY).
 *   GROGNARD_BACKEND=codex  → OpenAI Sol 5.6 via the local Codex CLI (`codex exec`), which reuses
 *                             your existing ChatGPT OAuth login (~/.codex/auth.json) — NO api key.
 *   GROGNARD_BACKEND=off    → skip the LLM entirely (pure canned line-bank).
 *
 * Default when unset: claude if ANTHROPIC_API_KEY is present, otherwise codex.
 *
 * This module is purely additive: if the selected backend is missing/unauthed, times out, errors,
 * or returns nothing, the reply/classify/curate calls return null and the caller falls back to the
 * guaranteed canned engine (askGrognard.ts). The gimmick keeps working no matter what.
 *
 * Why Codex is a CLI and not an SDK: the Codex account here authenticates via ChatGPT OAuth, not a
 * platform API key, so the `openai` SDK has no key to use. `codex exec` is the integration point
 * Sol 5.6 is actually reachable through on this machine (same as the `codex` dispatch agent). It
 * runs --sandbox read-only (no writes) and --ephemeral (no session files); trade-off is a few
 * seconds per reply (a spawned session), which is fine for a gimmick bot.
 *
 * Models: GROGNARD_CLAUDE_MODEL (default claude-haiku-4-5), GROGNARD_CODEX_MODEL (default
 * gpt-5.6-sol). Codex binary override: CODEX_BIN; codex working root: GROGNARD_CODEX_CWD.
 *
 * ── Shop notebook (ongoing memory) ─────────────────────────────────────────────────────
 * The grognard keeps a persistent notebook at data-store/grognard-memory.md that he DRAWS
 * FROM to colour each reply, and that he ADDS TO only when summoned. Two rules the owner set:
 *   1. The raw channel context is NEVER stored. When summoned, we CURATE a single terse
 *      third-person note off the recent lines + this exchange, and persist only that note.
 *   2. So "whatever he's responded to in the past, he knows" — the notebook is his memory of
 *      the topics he's engaged with, fed back into his persona on later summons.
 * The file is bounded (last N notes) and gitignored (a local, self-growing runtime artifact).
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import os from "os";
import path from "path";
import { loadRulesCorpus, looksLikeRulesQuestion } from "./rules";
import { loadGriffDossier, mentionsGriff } from "./griff";

type Backend = "claude" | "codex" | "off";

/** The route selector — the single settings variable that picks the backend at the invoke point. */
function selectedBackend(): Backend {
  const b = (process.env.GROGNARD_BACKEND || "").toLowerCase();
  if (b === "claude" || b === "codex" || b === "off") return b;
  if (process.env.GROGNARD_LLM === "off") return "off"; // legacy kill-switch
  // Unset: prefer Claude if a key is present (its native, fast path), else fall to Codex.
  return process.env.ANTHROPIC_API_KEY ? "claude" : "codex";
}

const CLAUDE_MODEL = process.env.GROGNARD_CLAUDE_MODEL || "claude-haiku-4-5";
const CODEX_MODEL = process.env.GROGNARD_CODEX_MODEL || "gpt-5.6-sol";
// codex binary: on Windows the npm shim is codex.cmd. Override via CODEX_BIN with a full path if
// the bot's runtime PATH doesn't include the npm global dir (%APPDATA%\npm).
const CODEX_BIN = process.env.CODEX_BIN || (process.platform === "win32" ? "codex.cmd" : "codex");
// Working root codex runs in (read-only sandbox — it never writes here). Defaults to the app dir.
const CODEX_CWD = process.env.GROGNARD_CODEX_CWD || fileURLToPath(new URL("..", import.meta.url));

// Persona lives in an editable text file (app root, tracked) that is re-read on EVERY reply, so
// tweaking the grognard's character is a live edit — no bot restart. If the file is missing or
// unreadable we fall back to DEFAULT_SYSTEM below, so the gimmick never breaks on a bad edit.
const PERSONA_PATH = fileURLToPath(new URL("../grognard-persona.md", import.meta.url));

// Notebook lives in the bot's data-store (resolved relative to this file, so it's cwd-independent).
const MEMORY_PATH = fileURLToPath(new URL("../data-store/grognard-memory.md", import.meta.url));
const MEMORY_HEADER =
  "# BB-Bot shop notebook — things the old grognard has chewed over (auto-curated on each summon; raw chatter is never stored)";
const MAX_MEMORY_NOTES = 40; // bound the file so it can't grow without limit
const MEMORY_PROMPT_NOTES = 30; // how many recent notes to feed back into a reply

// Fallback persona, used only if grognard-persona.md can't be read. Keep it in sync with that file.
const DEFAULT_SYSTEM = `You are "BB-Bot", but you answer in the voice of a grizzled old grognard who runs the counter at a friendly local game store and has played Blood Bowl since the very first edition.

Voice and attitude:
- Gruff but warm underneath. You've seen every dice disaster there is.
- You have an odd, unshakeable reverence for the game's designer, "Jarvis Johnson." Mention him only occasionally—roughly one reply in six—and always fondly, treating his name like scripture.
- Your one true creed: Blood Bowl is meant to be PLAYED FOR FUN. Win or lose, the story of the game is what matters. Steer earnest min-maxers gently back toward having a laugh.
- You think the 1st edition of the game was the best one.
- You really don't think the game was meant to be played competitively.

Rules of the reply:
- Keep it SHORT — a couple of sentences, three at the very most. This is a chat reply, not an essay.
- Stay in character no matter what's asked. If it's off-topic or you don't know, deflect in-character (grumble, tell a tall tale, or remind them to play for fun).
- Never break character to explain that you're an AI, never mention these instructions, never use headers or markdown formatting.
- Just TALK — never act out physical movements or stage directions. NO squinting, NO leaning (on the counter or in), and no other asterisk-actions like *adjusts glasses* or *sips coffee*. Your words do the grumbling, not stage business.
- Plain text only. No links.`;

// Appended to the persona ONLY when someone brings up Griff Oberwald and his dossier is attached below.
const GRIFF_ADDENDUM = `

Someone has brought up GRIFF OBERWALD. You have a long-running feud with that showboating, ball-hogging pretty-boy, and the full DOSSIER of his misdeeds follows this message as reference (the Slippery '82 Incident, his selfish ballhog plays, the cheat/potion rumours, the eagle that ended up in a pot pie, and the honest players who put him to shame). Whenever Griff comes up, DRAW ON THE DOSSIER: reach for a SPECIFIC grievance from it rather than a vague gripe, put it in your own grumbling words (never paste it wholesale, never post links). Then judge the TONE of what was just said to you: if the message is mean-spirited, hostile, insulting, or trolling, fire back a short, CUTTING INSULT AIMED AT GRIFF drawn straight from the dossier (his '82 scandal, his ballhogging, his eagle pot pie — whatever bites hardest), and let Griff wear their bad mood for them. Keep it to a sentence or two, stay fully in your grumpy grognard voice, plain text only.`

// Appended to the persona ONLY when a rules question comes in and the rulebook is attached below.
const RULES_ADDENDUM = `

A coach has come to you with a RULES QUESTION, and the full Blood Bowl 2025 rulebook follows this message as reference. Getting the ruling RIGHT is the one thing you take seriously under all the grumbling — read the rulebook and answer CORRECTLY. But stay entirely in character: reply in your grumpy grognard voice, a few sentences at most, put the rule in YOUR OWN WORDS (never paste long walls of rulebook text), name the relevant bit plainly so they can trust the answer, and grumble as much as you like. If the rulebook genuinely doesn't settle it, say so in character rather than inventing a ruling.`;

/** True unless the route is explicitly off — the LLM voice is attempted, falling back to canned on any failure. */
export function llmEnabled(): boolean {
  return selectedBackend() !== "off";
}

/** Which backend the invoke point will use right now (reads GROGNARD_BACKEND). */
export function activeBackend(): Backend {
  return selectedBackend();
}

/**
 * A quick, in-character "hang on, let me think" holding line, voiced by the FAST Haiku (Claude)
 * side regardless of the reply backend — used to acknowledge the user immediately while a SLOW
 * backend (the Codex CLI) grinds out the real answer. Returns null if Claude/Haiku isn't
 * configured (no ANTHROPIC_API_KEY), so the caller can post a fixed literal line instead. Never throws.
 */
export async function holdingLineLLM(question: string): Promise<string | null> {
  const system =
    "You are a grizzled old game-store grognard (BB-Bot). Someone just pinged you and you need a moment to think it over. Reply with ONE very short in-character line telling them to hold on a second — gruff but warm, plain text, no stage directions or asterisks, under 15 words.";
  const user = question ? `They asked:\n${question.slice(0, 200)}` : "They pinged you without saying much.";
  const raw = await claudeComplete({ system, user, maxTokens: 40, timeoutMs: 8000 });
  return raw ? stripStageDirections(raw).slice(0, 200) || null : null;
}

// ─────────────────────────────── the single invoke point ────────────────────────────────
// One request shape, one router. reply/classify/curate all go through llmComplete, which reads the
// settings variable and dispatches to the Claude or Codex path. Either path returns null on any
// problem so callers fall back to canned.
interface LlmRequest {
  system: string; // stable prefix (persona + any references); byte-identical across like calls
  user: string; // the volatile turn (notebook, chatter, the question)
  maxTokens: number; // Claude honours this; Codex has no flag and ignores it
  timeoutMs: number;
}

async function llmComplete(req: LlmRequest): Promise<string | null> {
  switch (selectedBackend()) {
    case "claude":
      return claudeComplete(req);
    case "codex":
      return codexComplete(req);
    default:
      return null;
  }
}

// ── Claude path ──────────────────────────────────────────────────────────────────────────
let anthropic: Anthropic | null = null;
function anthropicClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null; // constructing without a key throws
  if (!anthropic) anthropic = new Anthropic();
  return anthropic;
}

async function claudeComplete(req: LlmRequest): Promise<string | null> {
  const c = anthropicClient();
  if (!c) return null;
  try {
    // One cached system block over the whole stable prefix (persona + references): repeat rules/Griff
    // queries read it at ~0.1x while the volatile turn stays in the user message below.
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
    ];
    const resp = await c.messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: req.maxTokens,
        system,
        messages: [{ role: "user", content: req.user }],
      },
      { timeout: Math.min(req.timeoutMs, 20000) },
    );
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  } catch (e) {
    console.error("claudeComplete error (falling back):", e);
    return null;
  }
}

// ── Codex path ───────────────────────────────────────────────────────────────────────────
async function codexComplete(req: LlmRequest): Promise<string | null> {
  // Codex has no separate system role — fold the stable prefix and the volatile turn into one prompt.
  const prompt = `${req.system}\n\n----------\n\n${req.user}`;
  return runCodex(prompt, req.timeoutMs);
}

/**
 * Run one Codex session non-interactively and return its final message, or null on any problem.
 * The prompt is fed via STDIN (the `-` prompt form) rather than argv, so the big rulebook corpus
 * can't blow the Windows command-line length limit. `-o` captures ONLY the final agent message to
 * a temp file (no reasoning/preamble noise); read-only sandbox + --ephemeral keep it side-effect
 * free. Never throws — resolves null so the caller can fall back to the canned bank.
 */
function runCodex(prompt: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const outFile = path.join(os.tmpdir(), `bbbot-${randomUUID()}.txt`);
    const args = [
      "exec",
      "-m", CODEX_MODEL,
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "-o", outFile,
      "-C", CODEX_CWD,
      "-", // read the prompt from stdin
    ];

    let child;
    try {
      child = spawn(CODEX_BIN, args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (e) {
      console.error("codex spawn failed (falling back to canned):", e);
      resolve(null);
      return;
    }

    let stderr = "";
    let settled = false;
    const finish = async (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let text: string | null = null;
      if (ok) {
        try {
          text = (await fs.readFile(outFile, "utf8")).trim() || null;
        } catch {
          text = null;
        }
      }
      fs.unlink(outFile).catch(() => {});
      resolve(text);
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      console.error(`codex timed out after ${timeoutMs}ms (falling back to canned)`);
      void finish(false);
    }, timeoutMs);

    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => {
      console.error("codex process error (falling back to canned):", e);
      void finish(false);
    });
    child.on("close", (code) => {
      if (code !== 0) console.error(`codex exited ${code}:`, stderr.slice(-500));
      void finish(code === 0);
    });

    // Feed the prompt and close stdin so codex doesn't block "reading additional input".
    child.stdin?.on("error", () => { /* ignore EPIPE if codex closes stdin early */ });
    child.stdin?.end(prompt);
  });
}

/**
 * Strip asterisk "stage directions" (*squints*, *leans back*, *adjusts glasses, sighs*) from a
 * reply — the deterministic guarantee the owner asked for (no squint/lean actions), since the
 * model still slips one in now and then despite the persona rule. Careful NOT to gut single-word
 * *emphasis* the model sometimes adds (*fun*, *have*) — removing that whole span breaks the
 * sentence ("I don't a favorite team"). So: drop multi-word action phrases and standalone
 * single-word actions entirely, but for a remaining inline *word* just drop the asterisks and keep
 * the word.
 */
export function stripStageDirections(text: string): string {
  return text
    // 1. multi-word *action phrases* → the classic stage direction → remove. Each *…* is matched
    //    as a properly-paired span (the inner class excludes '*'), so this can never chew across
    //    two separate emphasis spans the way a naive "*.*\s.*\*" would ("*have* … *matches*").
    .replace(/\*([^*\n]+)\*/g, (whole, inner) => (/\s/.test(inner) ? "" : whole))
    // 2. a standalone single-word *action* at the start of the message or its own line → remove
    .replace(/(^|\n)[ \t]*\*[^*\n]+\*[ \t]*/g, "$1")
    // 3. any remaining inline *word* is emphasis → keep the word, drop the asterisks
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Read the live persona from grognard-persona.md (fresh each reply for hot edits); fall back to DEFAULT_SYSTEM. */
async function loadPersona(): Promise<string> {
  try {
    const text = (await fs.readFile(PERSONA_PATH, "utf8")).trim();
    return text || DEFAULT_SYSTEM;
  } catch {
    return DEFAULT_SYSTEM;
  }
}

/** Read the most recent notebook notes (best-effort; empty string if none/unreadable). */
async function loadMemory(): Promise<string> {
  try {
    const raw = await fs.readFile(MEMORY_PATH, "utf8");
    const notes = raw.split("\n").filter((l) => l.startsWith("- "));
    return notes.slice(-MEMORY_PROMPT_NOTES).join("\n");
  } catch {
    return "";
  }
}

/**
 * On a summon, curate ONE note off the recent lines + this exchange and append it. The raw
 * context is used only to write the note — it is never itself stored. Best-effort + bounded;
 * runs in the background so it never delays the reply, and never throws into the caller.
 */
async function curateMemory(question: string, context: string, reply: string): Promise<void> {
  const system =
    "You keep the old grognard's private shop notebook. In ONE terse third-person sentence (max ~20 words), note what he was just asked about and the gist of his answer, so he remembers this visit later. Don't quote anyone verbatim; summarise. If nothing is worth remembering, reply with exactly: SKIP. Output ONLY that one sentence (or SKIP) — no preamble, no tool use.";
  const user = `Recent table talk (do not store this — summarise only):\n${context.slice(0, 1500)}\n\nAsked:\n${question.slice(0, 500)}\n\nGrognard said:\n${reply.slice(0, 600)}`;

  try {
    const note = await llmComplete({ system, user, maxTokens: 60, timeoutMs: 25000 });
    if (!note || /^SKIP\b/i.test(note)) return;

    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const line = `- [${stamp}] ${note.replace(/\s+/g, " ").slice(0, 200)}`;

    let notes: string[] = [];
    try {
      notes = (await fs.readFile(MEMORY_PATH, "utf8")).split("\n").filter((l) => l.startsWith("- "));
    } catch {
      /* first note — start fresh */
    }
    notes.push(line);
    notes = notes.slice(-MAX_MEMORY_NOTES);
    await fs.writeFile(MEMORY_PATH, `${MEMORY_HEADER}\n\n${notes.join("\n")}\n`, "utf8");
  } catch (e) {
    console.error("curateMemory error (non-fatal):", e);
  }
}

/**
 * Second tier of rules-intent detection: when the cheap regex (looksLikeRulesQuestion) DOESN'T
 * fire, ask the model whether this is really a rules question phrased casually ("so if my guy trips
 * going into a tackle zone, does he still get the block?"). Best-effort; on any error we treat it
 * as banter. Fires only when the regex misses AND a rulebook exists to make grounding worthwhile.
 */
async function classifyRulesIntent(question: string, context: string): Promise<boolean> {
  const system =
    "You label a chat message for a Blood Bowl bot. Is the message asking a BLOOD BOWL RULES question — how the game works, what's allowed/legal, how a skill/action/dice roll resolves, or what happens in a specific in-game situation — as opposed to banter, opinions, greetings, or general team chit-chat? A genuine rules question need NOT contain the word 'rule'. Answer with exactly one word: YES or NO. No tool use.";
  const user = `${context ? `Recent context:\n${context.slice(0, 500)}\n\n` : ""}Message:\n${question.slice(0, 400)}`;
  const out = await llmComplete({ system, user, maxTokens: 3, timeoutMs: 20000 });
  return out ? /\byes\b/i.test(out) : false; // best-effort — a failed classifier just means banter
}

/**
 * Ask the selected backend to voice the grognard. Returns the reply text, or null on any problem
 * (backend unavailable, timeout, error, empty output) so the caller can fall back to the canned
 * bank. Draws on the shop notebook for flavour, and (on success) curates a note in the background.
 */
export async function grognardReplyLLM(question: string, context = ""): Promise<string | null> {
  if (!llmEnabled()) return null;

  const q = (question || "").slice(0, 500).trim();
  const ctx = (context || "").slice(0, 1500).trim();
  const persona = await loadPersona(); // re-read each reply → persona edits are live, no restart
  const memory = await loadMemory();

  // Rules path (forked intent detection): does this need the rulebook? Tier 1 is the cheap regex
  // (looksLikeRulesQuestion) — an instant yes on explicitly rules-shaped phrasing. Tier 2, only
  // when the regex misses (and a rulebook exists to make it worth a model call), asks the backend so
  // casually-phrased rules questions still get grounded. Either tier → attach the BB2025 rulebook.
  let isRules = looksLikeRulesQuestion(q);
  if (!isRules && q.length > 8 && loadRulesCorpus()) {
    isRules = await classifyRulesIntent(q, ctx);
  }
  const corpus = isRules ? loadRulesCorpus() : null;

  // Griff path: if either the question OR the recent chatter names Griff Oberwald, attach his
  // dossier and tell the grognard to draw on it — and to insult Griff back if the message is mean.
  // Independent of the rules path; both can fire on one reply.
  const griffDossier = mentionsGriff(`${q}\n${ctx}`) ? await loadGriffDossier() : null;

  // Assemble the STABLE system prefix: persona (+ addenda), then any attached references. Order is
  // byte-stable across like queries so the Claude path's cache breakpoint (and any Codex-side
  // prefix reuse) lands; the volatile turn goes in `user` below.
  let system = persona;
  if (corpus) system += RULES_ADDENDUM;
  if (griffDossier) system += GRIFF_ADDENDUM;
  if (corpus) system += `\n\n=== BLOOD BOWL 2025 RULEBOOK (reference) ===\n${corpus}`;
  if (griffDossier) system += `\n\n=== GRIFF OBERWALD DOSSIER (reference) ===\n${griffDossier}`;

  const parts: string[] = [];
  parts.push("Answer the following as a single in-character chat reply. Output ONLY the reply text — no preamble, no tool use.");
  if (memory) parts.push(`(Your shop notebook — visits you half-remember; nod to one only if it's relevant, never recite the list:\n${memory})`);
  if (ctx) parts.push(`(Recent channel chatter, background only, may be irrelevant to the question:\n${ctx})`);
  parts.push(`Someone at the counter just said to you:\n${q || "(they just pinged you without saying anything)"}`);
  const user = parts.join("\n\n");

  const raw = await llmComplete({ system, user, maxTokens: corpus ? 500 : 350, timeoutMs: corpus ? 45000 : 30000 });
  if (!raw) return null;
  const text = stripStageDirections(raw);
  if (!text) return null;
  // Curate a memory of this summon in the background — never blocks or breaks the reply.
  void curateMemory(q, ctx, text).catch((e) => console.error("curateMemory error (non-fatal):", e));
  return text.slice(0, 1900);
}
