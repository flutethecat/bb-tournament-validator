/**
 * The one cleaning step every Discord post goes through before it leaves (owner 11-02: Discord notices always obscure
 * listed words): listed words left in any text (content, a title, a description, a field name or value, a footer) are
 * starred, escaped so the stars show as stars. Builders still run each user string through safe() (posts.ts); this is the
 * net under them. Used by the default webhook poster (src/leagues/discord.ts postWebhook), targets.ts postTo / postRaw,
 * the organiser routes (src/discord/api.ts, the league test post), the redraft posts and the recorder webhook.
 */
import { starProfanity } from "./profanity.js";

interface EmbedLike { title?: string; description?: string; footer?: { text: string }; fields?: Array<{ name: string; value: string; inline?: boolean }> }

export function cleanPayload<T extends { content?: string; embeds: EmbedLike[] }>(p: T): T {
  const star = (s: string): string => starProfanity(s, "\\*\\*\\*");
  return {
    ...p,
    ...(p.content ? { content: star(p.content) } : {}),
    embeds: p.embeds.map((e) => ({
      ...e,
      ...(e.title !== undefined ? { title: star(e.title) } : {}),
      ...(e.description !== undefined ? { description: star(e.description) } : {}),
      ...(e.footer ? { footer: { ...e.footer, text: star(e.footer.text) } } : {}),
      ...(e.fields ? { fields: e.fields.map((f) => ({ ...f, name: star(f.name), value: star(f.value) })) } : {}),
    })),
  };
}
