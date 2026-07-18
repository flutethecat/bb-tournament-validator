/**
 * "Ask BB-Bot" — a gimmick. @-mention the bot and it answers in character as a grizzled
 * old FLGS grognard who's played Blood Bowl since First Edition, worships Jarvis Johnson,
 * and will tell you — at length — that the game is meant to be played FOR FUN.
 *
 * Deliberately dependency-free: no LLM, no API key, no network. Topic keywords in the
 * question steer which persona bank we draw from; a hash of the message keeps repeats
 * varied without being random-per-render. It doesn't have to be smart — it has to be
 * grumpy, and it has to work.
 */

import type { Message } from "discord.js";

// ─── deterministic-but-varied pick (hash the text so the same question is stable-ish) ───
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function pick<T>(arr: readonly T[], seed: number): T {
  // Safe positive modulo: seeds arrive from signed bit-shifts and can be negative.
  const i = ((Math.trunc(seed) % arr.length) + arr.length) % arr.length;
  return arr[i]!;
}

// ─── persona flavour woven into most replies ───
const JARVIS = [
  "Jarvis Johnson, blessed be his dice bag, would've sorted you out.",
  "As Jarvis Johnson himself once told me — well, told the shop, I was stood nearby — it's about the story, not the score.",
  "Jarvis Johnson knew. That man *knew*. Greatest designer to ever push a Skaven around a board.",
  "You young'uns forget we owe all this to Jarvis Johnson. Pour one out for Jarvis.",
  "Jarvis would weep, kid. Jarvis would weep.",
];
const FUN = [
  "It's meant to be PLAYED FOR FUN. Write that on your hand.",
  "Win, lose, whatever — did you laugh when your Ogre ate the ball? That's the game.",
  "Nobody remembers who won. Everybody remembers the double-skulls on turn one.",
  "Play for the story, not the standings. That's free advice, worth every penny.",
  "The trophy gathers dust. The tale of the exploding Troll lasts forever.",
];
const OPENERS = [
  "*sips lukewarm coffee* ",
  "*adjusts glasses, sighs* ",
  "*leans on the glass counter* ",
  "*sets down a very chipped Ogre miniature* ",
  "Right, listen here, kid. ",
  "Hah. ",
  "Back in my day — and I mean the actual day — ",
];

// ─── topic banks ───
interface Topic {
  test: RegExp;
  lines: readonly string[];
}
const TOPICS: readonly Topic[] = [
  {
    test: /\b(dice|luck|roll|rolls|rolled|1s|ones|skull|armour break|armor break)\b/i,
    lines: [
      "The dice giveth and the dice taketh, and mostly they taketh. Stop blaming the cubes and set up better.",
      "You didn't get unlucky, you got greedy on a 2+. Two-plus is not a sure thing, it never was.",
      "In my day we rolled on a felt mat so the sixes couldn't run away. Learn to lose a Blitz and smile.",
    ],
  },
  {
    test: /\b(win|winning|meta|tier|best team|op|overpowered|netlist|competitive|tournament|min-?max|optimi[sz]e)\b/i,
    lines: [
      "Meta? META? Son, the only meta is whether the pizza's here yet.",
      "Netlists. Bah. Build the team you fancy the look of and take your lumps like a coach.",
      "Tier lists are for folk who've forgotten the game is meant to be PLAYED FOR FUN.",
      "You want the 'best' team? The one with the coach who buys the first round. That's the best team.",
    ],
  },
  {
    test: /\b(rule|rules|faq|legal|allowed|errata|how do i|how does|can i)\b/i,
    lines: [
      "It's in the rulebook, clear as day. Jarvis wrote it plain — you just have to actually open the thing.",
      "Look it up, kid. Page's got a corner folded on it in every good shop's copy for a reason.",
      "Rules lawyering, are we? Fine. But the spirit of the rule beats the letter of it, always has.",
    ],
  },
  {
    test: /\b(block|dodge|guard|tackle|blitz|foul|skill|skills|level up|spp)\b/i,
    lines: [
      "Block on everything that can hold a chainsaw, then worry about the fancy stuff. Fundamentals, kid.",
      "Guard wins games and loses friendships. Take it anyway.",
      "Fouling's not cheating, it's *tradition*. Just don't cry when the ref sends your git off.",
      "SPP chasing turns a lovely lineman into a diva. Spread the love around the whole team.",
    ],
  },
  {
    test: /\b(orcs?|dwarf|dwarves|elf|elves|skaven|rats?|halflings?|goblins?|chaos|undead|humans?|amazons?|nurgle|ogres?|vampires?|norse|lizards?|saurus|snotlings?|trolls?)\b/i,
    lines: [
      "Ah, a coach with taste — or no taste, hard to say from here. Play 'em with heart and they'll pay you back.",
      "Every team's a winner if you're grinning. Even Halflings. *Especially* Halflings.",
      "That lot? I've buried better teams than that under a pile of dead linemen. Beautiful game.",
    ],
  },
  {
    test: /\b(hi|hello|hey|yo|greetings|good morning|good evening|sup|howdy)\b/i,
    lines: [
      "Hrmph. You're interrupting my coffee. What d'you want?",
      "Well well, a fresh face at the counter. Pull up a stool, mind the dice.",
      "Evening. Or morning. Time doesn't mean much once you've watched enough Ogres flub a Right Stuff.",
    ],
  },
  {
    test: /\b(who are you|what are you|your name|about you)\b/i,
    lines: [
      "Me? I've been shoving little plastic men round this board since First Edition. I run the counter. I've seen things.",
      "Just an old coach who never left the shop. Ask me anything — the answer's probably 'play for fun'.",
    ],
  },
  {
    test: /\b(jarvis|jervis|johnson|designer)\b/i,
    lines: [
      "JARVIS JOHNSON. Finally, someone with reverence. Sit down, this'll take a while.",
      "You said the name. The GOOD name. Jarvis Johnson, patron saint of the pitch.",
    ],
  },
  {
    test: /\b(fumbbl|online|app|client|bot40k|40k|digital)\b/i,
    lines: [
      "Playing on a screen, are we? In my day the ball scattered onto the floor and stayed there. Progress, I suppose.",
      "The little computer's fine, fine. But nothing beats the sound of a fistful of block dice on real felt.",
    ],
  },
];

const FALLBACK = [
  "Couldn't tell you, kid, and I've been at this since the boxed set had a cardboard pitch.",
  "That's a question for a younger, dafter coach. My answer's the same as always: play for fun.",
  "Hmm. *long pause* ...anyway, did I ever tell you about the time a Snotling scored the winning touchdown?",
  "You're overthinking it. Roll the dice, cheer the carnage, buy your opponent a drink.",
  "Ask me something with a bit of Blood Bowl in it and I'll give you a proper earful.",
];

// Overheard the channel chatter and picked up the topic there rather than in the question itself.
const OVERHEARD = [
  "Couldn't help overhearing you lot — ",
  "Been earwigging the table, and — ",
  "You've all been bangin' on about it, so — ",
  "I hear the shop talk, you know — ",
];

/**
 * Build the grognard's answer. Pure + total — never throws.
 * `context` is recent channel chatter (last few messages); when the QUESTION has no topic
 * of its own, the grognard picks up on whatever the channel's been discussing instead.
 */
export function grognardReply(question: string, context = ""): string {
  const q = (question || "").slice(0, 500);
  const ctx = (context || "").slice(0, 1500);
  const seed = hash((q + "|" + ctx).toLowerCase() || "empty");

  // Topic priority: what they ASKED wins; otherwise fall back to what the channel's been ON about.
  const qTopic = q.trim() ? TOPICS.find((t) => t.test.test(q)) : undefined;
  const ctxTopic = qTopic ? undefined : TOPICS.find((t) => t.test.test(ctx));
  const topic = qTopic ?? ctxTopic;

  if (!q.trim() && !topic) {
    return `${pick(OPENERS, seed)}Well? Spit it out. I haven't got all edition. ${pick(FUN, seed >> 3)}`;
  }

  const body = topic ? pick(topic.lines, seed >> 2) : pick(FALLBACK, seed >> 2);
  // If the topic came from the channel (not the question), tip the hat to it.
  const overheard = ctxTopic ? pick(OVERHEARD, seed >> 4) : "";

  // Weave in a bit of Jarvis-worship or fun-preaching about two times out of three.
  const flavourRoll = seed % 3;
  const flavour = flavourRoll === 0 ? "" : flavourRoll === 1 ? ` ${pick(JARVIS, seed >> 5)}` : ` ${pick(FUN, seed >> 5)}`;

  return `${pick(OPENERS, seed >> 1)}${overheard}${body}${flavour}`.slice(0, 1900);
}

/**
 * Handle a possible @-mention of the bot. Returns true if it took the message (so the caller
 * can skip other handlers). Ignores bots, DMs, and @everyone/@here — only a DIRECT ping answers.
 */
export async function handleGrognardMention(message: Message, botUserId: string | undefined): Promise<boolean> {
  if (!botUserId) return false;
  if (message.author.bot || !message.inGuild()) return false;
  if (message.mentions.everyone) return false; // don't get baited by @everyone
  if (!message.mentions.users.has(botUserId)) return false;

  const strip = (s: string): string => s.replace(/<@!?\d+>/g, " ").replace(/\s+/g, " ").trim();
  const question = strip(message.content);

  // Context awareness: read the last handful of messages so the grognard can pick up on
  // whatever the channel's been chewing over. Best-effort — a fetch failure just means no context.
  let context = "";
  try {
    const recent = await message.channel.messages.fetch({ limit: 8, before: message.id });
    context = recent
      .map((m) => (m.author.bot ? "" : strip(m.content)))
      .filter((t) => t.length > 0)
      .join(" ");
  } catch {
    /* no history access → answer from the question alone */
  }

  try {
    await message.reply(grognardReply(question, context));
  } catch {
    /* a failed reply is not worth crashing the listener over */
  }
  return true;
}
