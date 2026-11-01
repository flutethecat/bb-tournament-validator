// The data inventory (spec-privacy-gdpr §0) as one typed list. The privacy notice renders its "What we collect" table
// from it, and the export/delete lanes import the same list (src/privacy/export.ts must have a collector per `id`), so
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

export const FEATURES: PrivacyFeatures = { export: false, delete: false, consentRecording: true, consentWithdrawal: true };

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
    data: "The name you prefer to be called, a contact email you enter (it can differ from your Discord email, and we note whether it is verified), and up to three phone numbers.",
    purpose: "So Super FUMBBL can send you league messages from the organisers of leagues you join, if you allow it. Organisers message you through the portal and do not see your contact details.",
    public: "no", publicNote: "Your email and phone numbers are never shared with organisers or made public. League messages are sent by Super FUMBBL through our email delivery provider. League organisers can message you through the portal and see names on league pages. Tournament organisers can record NAF details for the coaches entered in their tournament, and see nothing else about you through that.",
    retention: ACCOUNT_LIFETIME,
  },
  {
    id: "consents", store: "identities.json (consent records)",
    data: "Whether you agreed to be contacted by league and tournament organisers, and when; for each league, whether you agreed to show your profile to its organisers and receive their league messages, and when; and which version of this notice you accepted, and when.",
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
    data: "Your tournament entries, rosters, fixtures, results and organiser news.",
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
    id: "notifications", store: "data-store/notifications/",
    data: "Your notifications (the bell and inbox).",
    purpose: "Telling you about fixtures, deadlines and league events.",
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
] as const;

/** The notice's "What we collect" groups, in plain language, each pointing at the inventory rows behind it. */
export interface CollectGroup { title: string; text: string; ids: readonly string[] }

export const COLLECT_GROUPS: readonly CollectGroup[] = [
  { title: "Your account", text: "Your Discord user id and username, the verified email on your Discord account, and your Discord avatar. If you add them: your preferred name, a contact email, and up to three phone numbers.", ids: ["identities", "contact-details", "consents", "sessions", "discord-sso", "organizers"] },
  { title: "What you create", text: "Rosters, teams, logos, avatars, match records, and league and tournament entries.", ids: ["coach-avatars", "team-avatars", "builder-saves", "team-library", "tournaments", "leagues", "tabletop"] },
  { title: "Game results and ratings", text: "Who played, who won, and the ratings and titles that follow.", ids: ["results", "fork-db"] },
  { title: "Notifications, email, chat and bug reports", text: "Notices we send you on the site, emails we send you (only if you opt in and confirm an address), lobby chat messages, and the bug reports you choose to send.", ids: ["notifications", "mail", "bug-reports", "lobby-chat"] },
  { title: "Technical data", text: "A session cookie, and your IP address held in memory only, for abuse limits.", ids: ["logs", "desktop-claims", "translation-cache"] },
];

import { PRIVACY_VERSION } from "./version";

export { PRIVACY_VERSION };
export const PRIVACY_LAST_UPDATED = PRIVACY_VERSION;
export const PRIVACY_HOSTING = "United States";
