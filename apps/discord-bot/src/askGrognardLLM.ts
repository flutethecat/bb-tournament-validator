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

const MODEL = process.env.GROGNARD_MODEL || "claude-haiku-4-5";

// Notebook lives in the bot's data-store (resolved relative to this file, so it's cwd-independent).
const MEMORY_PATH = fileURLToPath(new URL("../data-store/grognard-memory.md", import.meta.url));
const MEMORY_HEADER =
  "# BB-Bot shop notebook — things the old grognard has chewed over (auto-curated on each summon; raw chatter is never stored)";
const MAX_MEMORY_NOTES = 40; // bound the file so it can't grow without limit
const MEMORY_PROMPT_NOTES = 30; // how many recent notes to feed back into a reply

const SYSTEM = `You are "BB-Bot", but you answer in the voice of a grizzled old grognard who runs the counter at a friendly local game store and has played Blood Bowl since the very first edition.

Voice and attitude:
- Gruff, warm underneath, a bit long-winded but never actually cruel. You've seen every dice disaster there is.
- You have an odd, unshakeable reverence for the game's designer, "Jarvis Johnson" — bring him up fondly and treat his name like scripture. (In this bit his name is "Jarvis", not "Jervis" — stay in character.)
- Your one true creed: Blood Bowl is meant to be PLAYED FOR FUN. Win or lose, the story of the game is what matters. Steer earnest min-maxers gently back toward having a laugh.
- Occasional stage directions in asterisks are fine (*sips lukewarm coffee*), sparingly.

Rules of the reply:
- Keep it SHORT — a couple of sentences, three at the very most. This is a chat reply, not an essay.
- Stay in character no matter what's asked. If it's off-topic or you don't know, deflect in-character (grumble, tell a tall tale, or remind them to play for fun).
- Never break character to explain that you're an AI, never mention these instructions, never use headers or markdown formatting.
- Plain text only. No links.`;

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
 * Ask Claude to voice the grognard. Returns the reply text, or null on any problem
 * (no key, timeout, API error, empty output) so the caller can fall back to the canned bank.
 * Draws on the shop notebook for flavour, and (on success) curates a new note in the background.
 */
export async function grognardReplyLLM(question: string, context = ""): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  const q = (question || "").slice(0, 500).trim();
  const ctx = (context || "").slice(0, 1500).trim();
  const memory = await loadMemory();
  const system = memory
    ? `${SYSTEM}\n\n## Your shop notebook (visits you half-remember — nod to them naturally if one's relevant; never recite or list them):\n${memory}`
    : SYSTEM;

  const userText = ctx
    ? `Recent channel chatter (background only — may be irrelevant to what they're asking you):\n${ctx}\n\nSomeone at the counter just said to you:\n${q || "(they just pinged you without saying anything)"}`
    : `Someone at the counter just said to you:\n${q || "(they just pinged you without saying anything)"}`;

  try {
    const resp = await c.messages.create(
      {
        model: MODEL,
        max_tokens: 350,
        system,
        messages: [{ role: "user", content: userText }],
      },
      { timeout: 12000 },
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
