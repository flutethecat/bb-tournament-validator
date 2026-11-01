// The data inventory (spec-privacy-gdpr §0) as one typed list. The privacy notice renders its "What we collect" table
// from it, and the export/delete lanes import the same list (src/privacy/export.ts must have a collector per `id`), so
// the page and the export cannot drift. No personal data lives here: only the kinds of data the site stores.

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

const ACCOUNT_LIFETIME = "While your account exists; removed when you delete your account.";
const HISTORY_RETENTION = "Kept as league and tournament history; your coach name is replaced by \"Deleted coach\" when you delete your account.";

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
    purpose: "So organisers of leagues and tournaments you join can reach you, if you allow it.",
    public: "no", publicNote: "Only organisers of leagues and tournaments you joined and agreed to be contacted by can see them. Never public.",
    retention: ACCOUNT_LIFETIME,
  },
  {
    id: "consents", store: "identities.json (consent records)",
    data: "Whether you agreed to be contacted by league and tournament organisers, and when, and which version of this notice you accepted, and when.",
    purpose: "Proof of your choices: your consent (which you can withdraw on the Account page) and your acceptance of this notice.",
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
    public: "partly", publicNote: "Published matches only.",
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
    id: "bug-reports", store: "bug-reports/ (BUG_REPORTS_DIR)",
    data: "Bug reports you send: a game log, wire trace and optional screenshot, named by your coach name.",
    purpose: "Support and fixing bugs.",
    public: "no", retention: "12 months, or until you delete your account.",
  },
  {
    id: "logs", store: "config-web.*.log, data-store/config-web.log",
    data: "Server logs of errors and operations. They do not carry email addresses or IP addresses (see docs/privacy/log-hygiene.md).",
    purpose: "Keeping the site running and secure.",
    public: "no", retention: "14 days.",
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
  { title: "Notifications and bug reports", text: "Notices we send you on the site, and the bug reports you choose to send.", ids: ["notifications", "bug-reports"] },
  { title: "Technical data", text: "A session cookie, and your IP address held in memory only, for abuse limits.", ids: ["logs"] },
];

import { PRIVACY_VERSION } from "./version";

export { PRIVACY_VERSION };
export const PRIVACY_LAST_UPDATED = PRIVACY_VERSION;
export const PRIVACY_HOSTING = "United States";
