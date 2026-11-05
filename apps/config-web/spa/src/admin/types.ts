// Shapes the admin console reads from the server (src/admin/console.ts, src/admin/opsLog.ts, src/ratings/backup.ts).

export interface OpsLogRow { at: string; by: string; action: string; dryRun: boolean; ok: boolean; status: number; summary: string; backup?: string }

export interface RatingsBackupRow { name: string; createdAt: string; size: number; reason: string; existed: boolean; resetAt: string | null }

export interface ModerationReport {
  id: string; postId: string; threadId: string; reporter: string; reason: string; at: string;
  post: { author: string; text: string; removed: boolean; hidden: boolean } | null;
}
export interface ModerationBoard {
  scope: string; kind: "league" | "tournament"; id: string; name: string; href: string; enabled: boolean; publicRead: boolean;
  openReports: ModerationReport[]; mutes: Array<{ coach: string; until: string; by: string; reason?: string }>;
}
