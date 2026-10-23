// Pure display helpers shared by the SPA (/app) and the vanilla Lobby page (/lobby/). No DOM; unit-tested from
// apps/config-web/test/lobbyPage.test.ts.

export type PresenceState = "here" | "left" | "client" | "not-here-yet";

export function presenceLine(coach: string, state: PresenceState): string {
  switch (state) {
    case "here": return `${coach} is here`;
    case "left": return `${coach} left`;
    case "client": return `${coach} is in the client`;
    default: return `${coach} is not here yet`;
  }
}

export interface RatingLike {
  title?: string;
  cr?: number;
  record?: { w: number; d: number; l: number };
  winPct?: number;
  war?: number;
}

/** "+2.0" / "−2.5" / "0.0": signed, one decimal, half away from zero (same as the client's coach card). */
export function formatWar(war: number): string {
  const magnitude = Math.floor(Math.abs(war) * 10 + 0.5 + 1e-9) / 10;
  if (magnitude === 0) return "0.0";
  return `${war < 0 ? "−" : "+"}${magnitude.toFixed(1)}`;
}

/** Only the parts FUMBBL sent (or computed from the record it sent). */
export function ratingParts(r: RatingLike | null | undefined): string[] {
  if (!r) return [];
  const parts: string[] = [];
  if (r.record) parts.push(`Record ${r.record.w}/${r.record.d}/${r.record.l}`);
  if (r.winPct !== undefined) parts.push(`${r.winPct} %`);
  if (r.cr !== undefined) parts.push(`CR ${r.cr}`);
  if (r.war !== undefined) parts.push(`${formatWar(r.war)} WAR`);
  return parts;
}

export function expiryLine(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "This lobby has expired.";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `Lobby closes in ${mins} min.`;
  return `Lobby closes in ${Math.round(mins / 60)} h.`;
}

const EMOJI: Record<string, string> = {
  smile: "😄", smiley: "😃", grinning: "😀", grin: "😁", laughing: "😆", sweat_smile: "😅", joy: "😂", rofl: "🤣",
  blush: "😊", innocent: "😇", slightly_smiling_face: "🙂", upside_down_face: "🙃", wink: "😉", heart_eyes: "😍",
  yum: "😋", stuck_out_tongue: "😛", thinking: "🤔", neutral_face: "😐", expressionless: "😑", smirk: "😏",
  unamused: "😒", roll_eyes: "🙄", grimacing: "😬", pensive: "😔", sleeping: "😴", sunglasses: "😎", nerd_face: "🤓",
  confused: "😕", worried: "😟", open_mouth: "😮", astonished: "😲", flushed: "😳", pleading_face: "🥺", cry: "😢",
  sob: "😭", scream: "😱", disappointed: "😞", sweat: "😓", weary: "😩", triumph: "😤", rage: "😡", angry: "😠",
  skull: "💀", poop: "💩", clown_face: "🤡", ghost: "👻", robot: "🤖", see_no_evil: "🙈", heart: "❤️",
  broken_heart: "💔", "100": "💯", boom: "💥", wave: "👋", ok_hand: "👌", v: "✌️", crossed_fingers: "🤞", metal: "🤘",
  "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", fist: "✊", punch: "👊", clap: "👏", raised_hands: "🙌",
  handshake: "🤝", pray: "🙏", muscle: "💪", eyes: "👀", facepalm: "🤦", shrug: "🤷", fire: "🔥", star: "⭐",
  sparkles: "✨", zap: "⚡", rat: "🐀", snake: "🐍", dragon: "🐉", football: "🏈", trophy: "🏆", game_die: "🎲",
  beer: "🍺", beers: "🍻", tada: "🎉", rocket: "🚀", warning: "⚠️", x: "❌", white_check_mark: "✅", question: "❓",
};

/**
 * Display-only shortcodes (":joy:", ":+1:"), the client chat's rules in short: a whole token `:name:` known to the
 * table; a word character, `+` or `-` touching either side keeps it literal; unknown names stay literal; nothing
 * inside a URL is replaced. The stored text keeps the literal shortcode.
 */
export function renderEmoji(text: string): string {
  const urlRe = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(urlRe)) {
    out += replaceCodes(text.slice(last, m.index));
    out += m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  return out + replaceCodes(text.slice(last));
}

function replaceCodes(part: string): string {
  return part.replace(/(^|[^\w+-]):([a-z0-9_+-]{1,40}):(?![\w+-])/gi, (whole, pre: string, name: string) => {
    const emoji = EMOJI[name.toLowerCase()];
    return emoji ? pre + emoji : whole;
  });
}

/** Shape of a lobby id (the server mints them); shared by the vanilla page's hash and the SPA's route param. */
export const LOBBY_ID_PATTERN = "[A-Za-z0-9_-]{6,32}";

export function isLobbyId(id: string): boolean {
  return new RegExp(`^${LOBBY_ID_PATTERN}$`).test(id);
}

/** Lobby id from a location hash ("#abc123" -> "abc123"); undefined for the Start page. */
export function lobbyIdFromHash(hash: string): string | undefined {
  const id = hash.replace(/^#\/?/, "").trim();
  return isLobbyId(id) ? id : undefined;
}

/** Team value / gold in thousands: 1150000 -> "1,150k" (values under 10000 are already in k). */
export function fmtK(n: number): string {
  const k = n >= 10000 ? Math.round(n / 1000) : n;
  return `${k.toLocaleString("en")}k`;
}

/** Lines of chat the page keeps (the server keeps the same number). */
export const CHAT_KEEP = 200;

export interface StatusLike {
  me: "creator" | "opponent";
  status: "waiting" | "ready" | "needs-renewal";
  opponentAccepted: boolean;
  settingUp?: boolean;
  uncertain?: boolean;
  duplicateGames?: string[];
  canLaunch: boolean;
  creator: { coach: string };
  opponent: { coach: string };
  game: { gameId: string | null } | null;
}

/** One line of lobby status, from the server's pairing state only. */
export function lobbyStatusLine(v: StatusLike): string {
  const other = v.me === "creator" ? v.opponent.coach : v.creator.coach;
  if (v.status === "ready") {
    const extra = v.duplicateGames?.length ? " An extra game was created; an organiser can remove it." : "";
    return `Game set up${v.game?.gameId ? ` (game ${v.game.gameId})` : ""}. ${v.canLaunch ? "Ready to start." : "Waiting for both coaches."}${extra}`;
  }
  if (v.uncertain) return "Game setup did not confirm. A game may already exist: check Your games, then press Check again. Start over withdraws both challenges.";
  if (v.settingUp) return "Setting up the game on the server…";
  if (v.status === "waiting") {
    if (v.me === "creator") return `Waiting for ${other} to accept.`;
    return v.opponentAccepted ? "You accepted. Setting up the game…" : `${other} challenged you. Pick a team to accept.`;
  }
  if (v.me === "creator") {
    return v.opponentAccepted
      ? `${other} accepted. Your challenge needs confirming before the game is set up.`
      : "Your challenge is no longer open. Confirm it to keep the lobby going.";
  }
  return v.opponentAccepted
    ? `You accepted. Waiting for ${other} to confirm.`
    : `Waiting for ${other} to confirm. You can accept now.`;
}
