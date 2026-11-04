// Coach clubs (creation wizards v2, round 2 / 2b Q12-Q16 / round 3; owner 11-02): a club has a name, a crest, a home region
// and a description; coaches join by request, club admins approve; the creator is the first admin and can add more. A coach
// may be in several clubs and picks which one (or none) they represent at each league / tournament join.
//
// Stored in <FORK_STATE_DIR>/clubs/clubs.json (src/clubs/store.ts). Coaches are stored in their identity-record spelling and
// matched by the identity key (trim + lower case). Nothing here holds contact data.

export const CLUB_NAME_MIN = 3;
export const CLUB_NAME_MAX = 60;
export const CLUB_REGION_MAX = 60;
export const CLUB_DESCRIPTION_MAX = 2000;
export const CLUB_REQUEST_MESSAGE_MAX = 300;
/** Members per club (a soft cap that keeps the file and the stats pass bounded). */
export const CLUB_MEMBERS_MAX = 500;
/** Pending join requests per club. */
export const CLUB_REQUESTS_MAX = 200;
/** Clubs one coach may be a member of at once. */
export const CLUBS_PER_COACH_MAX = 25;
/** Former-member rows kept per club (oldest dropped first; their games stay in the stats, which read the competitions). */
export const CLUB_FORMER_MAX = 1000;
export const CLUB_ID = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export type ClubRole = "admin" | "member";

/** The member's own notification choices (both off by default, owner 11-02: "opt in"). */
export interface ClubMemberNotify {
  /** An inbox note when a clubmate wins a game counted for this club. */
  wins?: boolean;
  /** An inbox note (coalesced) when there are new posts on the club board. */
  board?: boolean;
}

export interface ClubMember {
  coach: string;
  role: ClubRole;
  joinedAt: string;
  notify?: ClubMemberNotify;
}

export interface ClubRequest {
  coach: string;
  at: string;
  message?: string;
}

/** A coach who left or was removed: history stays (their games keep counting for the competitions they represented the
 *  club in; this row only lists them under "Former members"). */
export interface ClubFormerMember {
  coach: string;
  joinedAt: string;
  leftAt: string;
  reason: "left" | "removed";
}

/** What the club's Discord webhook posts (each toggleable; all on by default once a webhook is set). */
export interface ClubWebhookEvents {
  results: boolean;
  podiums: boolean;
  titles: boolean;
}

export interface ClubSettings {
  /** League ladder games count toward the club's stats (spec-league-ladder Q9: a club setting, default OFF). */
  ladderGamesCount: boolean;
  webhookEvents: ClubWebhookEvents;
}

export const DEFAULT_CLUB_SETTINGS: ClubSettings = {
  ladderGamesCount: false,
  webhookEvents: { results: true, podiums: true, titles: true },
};

export interface ClubRecord {
  id: string;
  name: string;
  homeRegion: string;
  description: string;
  /** Relative path of the uploaded crest under the clubs dir (crests/<sha>.<ext>), or absent (the initials badge shows). */
  crestPath?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  revision: number;
  members: ClubMember[];
  requests: ClubRequest[];
  former: ClubFormerMember[];
  settings: ClubSettings;
  /** When the current Discord webhook was connected: the observer posts only events after it (each connection baselines). */
  webhookConnectedAt?: string;
  /** Set by account deletion when the club's creator was deleted: its text may need an admin's look (cleared on edit). */
  review?: { reason: "creator-deleted"; at: string };
  /** Archived: read-only (no joins, no posts), hidden from the directory unless asked for. */
  archivedAt?: string;
}

export interface ClubsFile {
  version: 1;
  clubs: Record<string, ClubRecord>;
}

/** The identity key coaches are matched by everywhere on the site. */
export const clubCoachKey = (coach: string): string => coach.normalize("NFC").trim().toLowerCase();
