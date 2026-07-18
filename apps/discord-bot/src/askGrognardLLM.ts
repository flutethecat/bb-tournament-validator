/**
 * Optional LLM path for "Ask BB-Bot". When ANTHROPIC_API_KEY is set, the grognard is
 * voiced by Claude instead of the canned line-bank in askGrognard.ts. This module is
 * purely additive: if there's no key, the SDK errors, the call times out, or the model
 * returns nothing, `grognardReplyLLM` returns null and the caller falls back to the
 * guaranteed canned engine. The gimmick keeps working with or without a key.
 *
 * Model: defaults to claude-haiku-4-5 (cheap — this fires on every @mention of a gimmick
 * bot, and quality genuinely doesn't matter here); override with GROGNARD_MODEL to bump it.
 *
 * ── Shop notebook (ongoing memory) ─────────────────────────────────────────────────────
 * The grognard keeps a persistent notebook at data-store/grognard-memory.md that he DRAWS
 * FROM to colour each reply, and that he ADDS TO only when summoned. Two rules the owner set:
 *   1. The raw channel context is NEVER stored. When summoned, we ask the model to CURATE a
 *      single terse third-person note off the recent lines + this exchange, and persist only
 *      that note — never the raw messages.
 *   2. So "whatever he's responded to in the past, he knows" — the notebook is his memory of
 *      the topics he's engaged with, fed back into his persona on later summons.
 * The file is bounded (last N notes) and gitignored (a local, self-growing runtime artifact).
 */

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import { loadRulesCorpus, looksLikeRulesQuestion } from "./rules";

const MODEL = process.env.GROGNARD_MODEL || "claude-haiku-4-5";
// The rules-intent classifier is always a cheap binary yes/no, independent of the reply model —
// so a bumped GROGNARD_MODEL (e.g. Opus) never makes intent-detection expensive.
const CLASSIFIER_MODEL = "claude-haiku-4-5";

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
- You have an odd, unshakeable reverence for the game's designer, "Jarvis Johnson" — bring him up fondly and treat his name like scripture. (In this bit his name is "Jarvis", not "Jervis" — stay in character.)
- Your one true creed: Blood Bowl is meant to be PLAYED FOR FUN. Win or lose, the story of the game is what matters. Steer earnest min-maxers gently back toward having a laugh.
- You think the 1st edition of the game was the best one.
- You really don't think the game was meant to be played competitively.

Rules of the reply:
- Keep it SHORT — a couple of sentences, three at the very most. This is a chat reply, not an essay.
- Stay in character no matter what's asked. If it's off-topic or you don't know, deflect in-character (grumble, tell a tall tale, or remind them to play for fun).
- Never break character to explain that you're an AI, never mention these instructions, never use headers or markdown formatting.
- Plain text only. No links.`;

// Appended to the persona ONLY when a rules question comes in and the rulebook is attached below.
const RULES_ADDENDUM = `

A coach has come to you with a RULES QUESTION, and the full Blood Bowl 2025 rulebook follows this message as reference. Getting the ruling RIGHT is the one thing you take seriously under all the grumbling — read the rulebook and answer CORRECTLY. But stay entirely in character: reply in your grumpy grognard voice, a few sentences at most, put the rule in YOUR OWN WORDS (never paste long walls of rulebook text), name the relevant bit plainly so they can trust the answer, and grumble as much as you like. If the rulebook genuinely doesn't settle it, say so in character rather than inventing a ruling.`;

let client: Anthropic | null = null;

/** True when an API key is present, so the LLM voice is available. */
export function llmEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null; // constructing without a key throws
  if (!client) client = new Anthropic();
  return client;
}

function textOf(resp: Anthropic.Message): string {
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
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
  const c = getClient();
  if (!c) return;
  try {
    const resp = await c.messages.create(
      {
        model: MODEL,
        max_tokens: 60,
        system:
          "You keep the old grognard's private shop notebook. In ONE terse third-person sentence (max ~20 words), note what he was just asked about and the gist of his answer, so he remembers this visit later. Don't quote anyone verbatim; summarise. If nothing is worth remembering, reply with exactly: SKIP",
        messages: [
          {
            role: "user",
            content: `Recent table talk (do not store this — summarise only):\n${context.slice(0, 1500)}\n\nAsked:\n${question.slice(0, 500)}\n\nGrognard said:\n${reply.slice(0, 600)}`,
          },
        ],
      },
      { timeout: 12000 },
    );
    const note = textOf(resp);
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
 * fire, ask a tiny Haiku classifier whether this is really a rules question phrased casually
 * ("so if my guy trips going into a tackle zone, does he still get the block?"). Best-effort and
 * cheap (a one-word yes/no); on any error we treat it as banter. This is the "understand it even
 * when they don't say 'rules'" half of the fork.
 */
async function classifyRulesIntent(question: string, context: string): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    const resp = await c.messages.create(
      {
        model: CLASSIFIER_MODEL,
        max_tokens: 3,
        system:
          "You label a chat message for a Blood Bowl bot. Is the message asking a BLOOD BOWL RULES question — how the game works, what's allowed/legal, how a skill/action/dice roll resolves, or what happens in a specific in-game situation — as opposed to banter, opinions, greetings, or general team chit-chat? A genuine rules question need NOT contain the word 'rule'. Answer with exactly one word: YES or NO.",
        messages: [
          {
            role: "user",
            content: `${context ? `Recent context:\n${context.slice(0, 500)}\n\n` : ""}Message:\n${question.slice(0, 400)}`,
          },
        ],
      },
      { timeout: 8000 },
    );
    return /\byes\b/i.test(textOf(resp));
  } catch {
    return false; // best-effort — a failed classifier just means we answer as banter
  }
}

/**
 * Ask Claude to voice the grognard. Returns the reply text, or null on any problem
 * (no key, timeout, API error, empty output) so the caller can fall back to the canned bank.
 * Draws on the shop notebook for flavour, and (on success) curates a new note in the background.
 */
export async function grognardReplyLLM(question: string, context = ""): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  const q = (question || "").slice(0, 500).trim();
  const ctx = (context || "").slice(0, 1500).trim();
  const persona = await loadPersona(); // re-read each reply → persona edits are live, no restart
  const memory = await loadMemory();

  // Rules path (forked intent detection): does this need the rulebook? Tier 1 is the cheap regex
  // (looksLikeRulesQuestion) — an instant yes on explicitly rules-shaped phrasing. Tier 2, only
  // when the regex misses (and a rulebook exists to make it worth a call), asks a tiny Haiku
  // classifier so casually-phrased rules questions still get grounded. Either tier → attach the
  // BB2025 rulebook as a FROZEN, prompt-CACHED system block so he answers for real. Persona +
  // rulebook are byte-stable across every rules query → the cache_control breakpoint lets the
  // first query write the cache and the rest read it at ~0.1x. Volatile bits (notebook, recent
  // chatter, the question) live in the user turn, AFTER the cached prefix, so they never bust it.
  let isRules = looksLikeRulesQuestion(q);
  if (!isRules && q.length > 8 && loadRulesCorpus()) {
    isRules = await classifyRulesIntent(q, ctx);
  }
  const corpus = isRules ? loadRulesCorpus() : null;
  const system: string | Anthropic.TextBlockParam[] = corpus
    ? [
        { type: "text", text: persona + RULES_ADDENDUM },
        { type: "text", text: `=== BLOOD BOWL 2025 RULEBOOK (reference) ===\n${corpus}`, cache_control: { type: "ephemeral" } },
      ]
    : persona;

  const parts: string[] = [];
  if (memory) parts.push(`(Your shop notebook — visits you half-remember; nod to one only if it's relevant, never recite the list:\n${memory})`);
  if (ctx) parts.push(`(Recent channel chatter, background only, may be irrelevant to the question:\n${ctx})`);
  parts.push(`Someone at the counter just said to you:\n${q || "(they just pinged you without saying anything)"}`);
  const userText = parts.join("\n\n");

  try {
    const resp = await c.messages.create(
      {
        model: MODEL,
        max_tokens: corpus ? 500 : 350, // rules answers need a touch more room than banter
        system,
        messages: [{ role: "user", content: userText }],
      },
      { timeout: 15000 },
    );
    const text = textOf(resp);
    if (!text) return null;
    // Curate a memory of this summon in the background — never blocks or breaks the reply.
    void curateMemory(q, ctx, text).catch((e) => console.error("curateMemory error (non-fatal):", e));
    return text.slice(0, 1900);
  } catch (e) {
    console.error("grognardReplyLLM error (falling back to canned):", e);
    return null;
  }
}
