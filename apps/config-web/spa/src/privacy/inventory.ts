// The data inventory (spec-privacy-gdpr §0) as one typed list. The privacy notice renders its "What we collect" table
// from it, and the export/delete registry (src/privacy/collectors.ts INVENTORY_ROWS) must cover every `id`, so
// the page and the export cannot drift. No personal data lives here: only the kinds of data the site stores.

/**
 * Which privacy features the running site actually has. The notice states a feature only when its flag is true and
 * otherwise says "coming soon, email the contact". Flip each flag (one line) in the change that lands the feature.
 */
export interface PrivacyFeatures {
  /** "Download my data" on the Account page. */
  export: boolean;
  /** "Delete my account", including anonymising public history. */
  delete: boolean;
  /** Consent and notice acceptance are recorded at sign-up. */
  consentRecording: boolean;
  /** League-contact consent can be withdrawn on the Account page. */
  consentWithdrawal: boolean;
}

export const FEATURES: PrivacyFeatures = { export: true, delete: true, consentRecording: true, consentWithdrawal: true };

export type PublicVisibility = "no" | "yes" | "partly";

export interface InventoryRow {
  /** Stable key: the export collector registry and the delete job address stores by it. */
  id: string;
  /** Where it lives (live path or env override), for engineers and the export README. */
  store: string;
  /** What we hold, in plain language. */
  data: string;
  /** Why we hold it. */
  purpose: string;
  /** Whether other people can see it. */
  public: PublicVisibility;
  /** Who can see it, when `public` is not "no". */
  publicNote?: string;
  /** How long we keep it, in plain language. */
  retention: string;
}

// Retention strings say only what is true on every build. What happens on account deletion depends on the feature flags
// below and is stated by the notice page, never here.
const ACCOUNT_LIFETIME = "While your account exists.";
const HISTORY_RETENTION = "Kept as league and tournament history.";

export const INVENTORY: readonly InventoryRow[] = [
  {
    id: "identities", store: "identities.json",
    data: "Coach name, Discord user id, Discord username, Discord avatar, the verified email on your Discord account, display name, links to your FUMBBL / NAF profiles, roles, ban flag.",
    purpose: "Your account and signing in; contacting you about your account.",
    public: "partly", publicNote: "Coach name and avatar only. Email and Discord ids are never shown.",
    retention: ACCOUNT_LIFETIME,
  },
  {
    id: "contact-details", store: "identities.json (profile and contact fields)",
    data: "The name you prefer to be called, a contact email you enter (it can differ from your Discord email, and we note whether it is verified), your country (it sets the prefix for your phone number), and one phone number if you add one (a phone number is optional).",
    purpose: "So Super FUMBBL can send you league messages from the organisers of leagues you join, if you allow it, and so you can choose to show your details to the organisers of a league or tournament you join.",
    public: "no", publicNote: "Organisers of a league or tournament you join see your coach name and teams. Anything else (your preferred name, email or phone number) they see only if you chose to share it with that league or tournament, and only while you are in it; you choose per league and per tournament, and can change it on the Account page under Sharing. NAF name and number from your profile are shared with organisers of NAF-sanctioned tournaments you enter. Nothing here is made public. League messages are sent by Super FUMBBL through our email delivery provider, so organisers can message you without seeing your address. Tournament organisers can also record NAF details for the coaches entered in their tournament.",
    retention: ACCOUNT_LIFETIME,
  },
  {
    id: "consents", store: "identities.json (consent records)",
    data: "Whether you agreed to be contacted by league and tournament organisers, and when; for each league, whether you joined (agreed that its organisers see your coach name and teams) or declined, and when; for each league and tournament, what you chose to share with its organisers (preferred name, email, phone), and when; and which version of this notice you accepted, and when.",
    purpose: "Proof of your choices: your consents (which you can withdraw on the Account page) and your acceptance of this notice.",
    public: "no", retention: ACCOUNT_LIFETIME,
  },
  {
    id: "sessions", store: "sessions.json",
    data: "A session id (stored in your session cookie), your coach name, and when the session expires.",
    purpose: "Keeps you signed in.",
    public: "no", retention: "Until the session expires (idle and absolute limits) or you sign out.",
  },
  {
    id: "discord-sso", store: "data-store/discord-sso-*.json",
    data: "Short-lived sign-in handshake state and pending sign-ins.",
    purpose: "Completing the Discord sign-in.",
    public: "no", retention: "Minutes; cleared when the handshake finishes or expires.",
  },
  {
    id: "organizers", store: "organizers.json",
    data: "The coach names that have organiser rights.",
    purpose: "Permissions.",
    public: "no", retention: ACCOUNT_LIFETIME,
  },
  {
    id: "coach-avatars", store: "coach-avatars/ (COACH_AVATARS_DIR)",
    data: "The profile picture you upload, and a cached copy of your Discord avatar.",
    purpose: "Your profile picture.",
    public: "yes", publicNote: "Shown next to your coach name.",
    retention: ACCOUNT_LIFETIME,
  },
  {
    id: "team-avatars", store: "team-avatars/ (TEAM_AVATARS_DIR)",
    data: "Team logos you upload.",
    purpose: "Team identity.",
    public: "yes", publicNote: "Shown with the team.",
    retention: ACCOUNT_LIFETIME,
  },
  {
    id: "builder-saves", store: "data-store/builder-saves/ (FORK_BUILDER_SAVES_DIR)",
    data: "Rosters you save in the Roster Builder, and their share links.",
    purpose: "The Roster Builder.",
    public: "partly", publicNote: "Only to people you give the share link to.",
    retention: ACCOUNT_LIFETIME,
  },
  {
    id: "team-library", store: "data-store/library/ (FORK_LIBRARY_DIR)",
    data: "Your team library for playing on Super FUMBBL.",
    purpose: "Playing games.",
    public: "partly", publicNote: "Team names are visible in games.",
    retention: ACCOUNT_LIFETIME,
  },
  {
    id: "tournaments", store: "data-store/tournaments.json and tournament folders",
    data: "Your tournament entries, rosters, fixtures, results and organiser news; for an entry, that you said you are not a NAF member, or a NAF number stored with an older entry (seen by you and the tournament's organisers only). On a NAF-sanctioned tournament the organisers see the NAF name and number on your profile.",
    purpose: "Running tournaments.",
    public: "yes", publicNote: "On the public tournament pages.",
    retention: HISTORY_RETENTION,
  },
  {
    id: "leagues", store: "data-store/leagues/",
    data: "League teams, players, coach assignments, stats and honours; a league's Discord webhook (a secret, never shown).",
    purpose: "Running leagues.",
    public: "yes", publicNote: "Everything except webhook secrets.",
    retention: HISTORY_RETENTION,
  },
  {
    id: "tabletop", store: "data-store/tabletop/",
    data: "Tabletop matches, their events and journals, and the teams used.",
    purpose: "The match recorder.",
    public: "partly", publicNote: "Tabletop matches are visible to spectators while they are recorded and after publication; test matches never.",
    retention: HISTORY_RETENTION,
  },
  {
    id: "results", store: "data-store/tournament-results.json, naf-games.json, coach-titles.json, replay-moments/",
    data: "Game results, ratings inputs, titles and replay moments.",
    purpose: "Results, ratings and game pages.",
    public: "yes", publicNote: "Results and ratings are public standings.",
    retention: HISTORY_RETENTION,
  },
  {
    id: "tabletop-teams", store: "data-store/tabletop/teams/",
    data: "The revision history of the teams you used in tabletop matches (roster changes after each match), tied to your coach name.",
    purpose: "Keeping your tabletop team up to date after each match, with undo.",
    public: "no", retention: ACCOUNT_LIFETIME,
  },
  {
    id: "tournament-matches", store: "data-store/tournament-matches.json",
    data: "Which online games were tournament matches, with the two coach names and teams.",
    purpose: "Counting games in tournaments and tournament ratings.",
    public: "yes", publicNote: "Tournament results are public standings.",
    retention: HISTORY_RETENTION,
  },
  {
    id: "notifications", store: "data-store/notifications/",
    data: "Your notifications (the bell and inbox).",
    purpose: "Telling you about fixtures, deadlines and league events.",
    public: "no", retention: ACCOUNT_LIFETIME,
  },
  {
    id: "friends", store: "data-store/friends/",
    data: "Your friends and the friend requests you sent or received (coach names and dates).",
    purpose: "The Friends list on your coach page. People you know is worked out from public game results and is not stored.",
    public: "no", publicNote: "A friend request shows your coach name to the coach you sent it to.",
    retention: ACCOUNT_LIFETIME,
  },
  {
    id: "messages", store: "data-store/messages/",
    data: "Private messages between you and another coach (the text, who sent it and when), and your conversation list with unread counts.",
    purpose: "Private messages between coaches on the site. They are not sent by email or Discord.",
    public: "no", publicNote: "Only you and the other coach in the conversation. A tournament organiser's message to you also appears in your conversation with them.",
    retention: "While your account exists. The other coach in a conversation keeps their copy of it.",
  },
  {
    id: "fixture-lobbies", store: "data-store/fixture-lobbies/",
    data: "The lobby of each of your league fixtures: chat messages (your coach name, the text and a timestamp), your roster and inducement choices and locks, Ready, and who started the match.",
    purpose: "Agreeing and starting a league match with your opponent, including pre-match inducements.",
    public: "partly", publicNote: "The chat is seen by the two coaches and the league organisers. Locks, Ready and (once both sides lock) the inducement picks are shown to anyone who opens the lobby.",
    retention: HISTORY_RETENTION,
  },
  {
    id: "schedule-proposals", store: "data-store/schedule/proposals.json",
    data: "Game times you proposed for one of your fixtures or were offered (both coaches' names, up to three times, and whether they were accepted, countered or declined).",
    purpose: "Agreeing when to play a league or tournament fixture with your opponent. The agreed time is saved on the fixture.",
    public: "no", publicNote: "Only you and your opponent see a proposal. Once a time is agreed it shows on the fixture like its date.",
    retention: "While your account exists; answered proposals are removed after 60 days.",
  },
  {
    id: "blocks", store: "data-store/blocks/",
    data: "The coaches you blocked, and when.",
    purpose: "Stopping blocked coaches from messaging you or sending you friend requests.",
    public: "no", retention: ACCOUNT_LIFETIME,
  },
  {
    id: "mail", store: "data-store/mail/ (outbox/journal.jsonl, prefs.json, suppression.json, audit.jsonl)",
    data: "Emails waiting to be sent or recently sent (your address and the message), the address you confirmed for league emails and any open confirmation request, whether you turned league emails off, a one-way hash of addresses that bounced or reported spam, and a log of league messages (league, sender, how many recipients; no addresses).",
    purpose: "Sending confirmation links and league messages without showing your address to organisers; not sending to addresses that bounced.",
    public: "no",
    retention: "Message bodies and addresses in the outbox: 30 days after sending; the rest of the outbox record (no address or text): 180 days. Bounce and complaint hashes are kept so we never mail that address again. Your confirmed address and email choice: while your account exists.",
  },
  {
    id: "bug-reports", store: "bug-reports/ (BUG_REPORTS_DIR)",
    data: "Bug reports you send: a game log, wire trace and optional screenshot, named by your coach name.",
    purpose: "Support and fixing bugs.",
    public: "no", retention: "12 months; older reports are deleted automatically each day.",
  },
  {
    id: "logs", store: "config-web.*.log, data-store/config-web.log",
    data: "Server logs of errors and operations. They do not carry email addresses or IP addresses (see docs/privacy/log-hygiene.md).",
    purpose: "Keeping the site running and secure.",
    public: "no", retention: "14 days; older log files are deleted automatically each day.",
  },
  {
    id: "lobby-chat", store: "Server memory (Start Game lobby; never written to disk)",
    data: "Lobby chat messages (your coach name, the text and a timestamp) and who is in the lobby while connected.",
    purpose: "Chatting with your opponent while you set up a game.",
    public: "partly", publicNote: "Seen by the people in that lobby.",
    retention: "Up to 24 hours after the lobby opens (1 hour once its game starts); lost when the server restarts.",
  },
  {
    id: "desktop-claims", store: "Server memory (desktop sign-in)",
    data: "A one-time claim that hands your browser sign-in to the Super FUMBBL desktop app, tied to your coach name.",
    purpose: "Signing in to the desktop app.",
    public: "no", retention: "10 minutes; lost when the server restarts.",
  },
  {
    id: "translation-cache", store: "Server memory (chat translation cache)",
    data: "Chat text sent for translation and its translation, when an operator has chat translation switched on.",
    purpose: "Translating chat, and not translating the same text twice.",
    public: "no", retention: "24 hours; lost when the server restarts.",
  },
  {
    id: "fork-db", store: "Fork server database (separate service)",
    data: "Your Super FUMBBL game account, games and replays.",
    purpose: "Playing games.",
    public: "partly", publicNote: "Game records appear on the site's game pages.",
    retention: "Game records are kept as history; the account is disabled when you delete yours.",
  },
  {
    id: "fork-teams-xml", store: "Fork server team files (FORK_TEAMS_DIR)",
    data: "The team files the game server plays with, including the coach name.",
    purpose: "Playing games.",
    public: "partly", publicNote: "Team and coach names appear in games and on game pages.",
    retention: "Kept as game records.",
  },
  {
    id: "bot-registry", store: "Discord bot data (coaches.json, validated-rosters.csv)",
    data: "The Discord bot's coach registry (Discord id, FUMBBL and NAF names) and the rosters it validated.",
    purpose: "Tournament roster checks in Discord.",
    public: "no", retention: "Held by the Discord bot, not by this site; ask the contact to remove it.",
  },
] as const;

/** The notice's "What we collect" groups, in plain language, each pointing at the inventory rows behind it. */
export interface CollectGroup { title: string; text: string; ids: readonly string[] }

export const COLLECT_GROUPS: readonly CollectGroup[] = [
  { title: "Your account", text: "Your Discord user id and username, the verified email on your Discord account, and your Discord avatar. If you add them: your preferred name, a contact email, your country and one phone number.", ids: ["identities", "contact-details", "consents", "sessions", "discord-sso", "organizers"] },
  { title: "What you create", text: "Rosters, teams, logos, avatars, match records, and league and tournament entries.", ids: ["coach-avatars", "team-avatars", "builder-saves", "team-library", "tournaments", "leagues", "tabletop", "tabletop-teams"] },
  { title: "Game results and ratings", text: "Who played, who won, and the ratings and titles that follow.", ids: ["results", "tournament-matches", "fork-db", "fork-teams-xml"] },
  { title: "Notifications, email, chat and bug reports", text: "Notices we send you on the site, emails we send you (only if you opt in and confirm an address), lobby chat messages, and the bug reports you choose to send.", ids: ["notifications", "mail", "bug-reports", "lobby-chat"] },
  { title: "Friends, private messages and blocks", text: "Your friends and friend requests, the private messages you send and receive on the site, and the coaches you blocked.", ids: ["friends", "messages", "blocks"] },
  { title: "Technical data", text: "A session cookie, and your IP address held in memory only, for abuse limits.", ids: ["logs", "desktop-claims", "translation-cache"] },
];

import { PRIVACY_VERSION } from "./version";

export { PRIVACY_VERSION };
export const PRIVACY_LAST_UPDATED = PRIVACY_VERSION;
export const PRIVACY_HOSTING = "United States";
