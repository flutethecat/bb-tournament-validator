/**
 * Bug-report triage notifications (owner 2026-09-08): bb-bot polls config-web's bug-report store
 * and DMs the triager (and/or posts to a channel) a card for every NEW report, with triage buttons.
 * A button opens a modal (root cause + reason); submitting it PATCHes the report's triage on
 * config-web, so the owner can triage straight from Discord without opening the admin panel.
 *
 * Env (discord-bot/.env):
 *   CONFIG_WEB_URL               config-web base the bot calls (default http://127.0.0.1:4310)
 *   CONFIG_WEB_PUBLIC_URL        link target for the "Open in admin" button (default = CONFIG_WEB_URL)
 *   CONFIG_WEB_SERVICE_COACH     fork coach the bot signs in as (POST /api/fork/login -> Bearer session). Must be
 *                                organizer/admin level in config-web's identities store: the report read/PATCH
 *                                routes are organizer-gated in-handler and sidecar-session-gated in front.
 *   CONFIG_WEB_SERVICE_PASSWORD  that coach's fork password (md5'd client-side before it rides the wire)
 *   BUG_REPORT_NOTIFY_USER_ID    Discord user to DM (the triager). Only this user may press the buttons.
 *   BUG_REPORT_NOTIFY_CHANNEL_ID optional channel to post the same card into
 *
 * Same seed-then-announce idiom as the build/daily-summary pollers: the first run records what
 * already exists and posts nothing, so a restart never replays history. State + short-id map live
 * in DATA_DIR/bug-report-notify.json.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
} from "discord.js";

export type TriageStatus = "new" | "triaged" | "in-progress" | "resolved" | "closed";
const TRIAGE_STATUSES: readonly TriageStatus[] = ["new", "triaged", "in-progress", "resolved", "closed"];
const BUTTON_STATUSES: readonly TriageStatus[] = ["triaged", "in-progress", "resolved", "closed"];
const STATUS_LABEL: Record<TriageStatus, string> = {
  new: "New",
  triaged: "Triaged",
  "in-progress": "In progress",
  resolved: "Resolved",
  closed: "Closed",
};
const STATUS_COLOR: Record<TriageStatus, number> = {
  new: 0xe04040,
  triaged: 0xe0a020,
  "in-progress": 0x3a7bd5,
  resolved: 0x22e05a,
  closed: 0x777777,
};

export interface BugReportRow {
  id: string;
  coach: string;
  gameId: string | null;
  gameService: "fumbbl" | "fork" | null;
  clientVersion: string | null;
  description: string;
  submittedAt: string;
  kind: "bug" | "feedback";
  triage: { status: TriageStatus; rootCause: string; reason: string; updatedAt: string | null; updatedBy: string | null };
}

/** Full report.json adds the file inventory; everything else mirrors the listing row. */
export interface BugReportDetail extends BugReportRow {
  files?: { wireLog?: string | null; appLog?: string | null; screenshot?: string | null };
}

const isStatus = (v: unknown): v is TriageStatus => TRIAGE_STATUSES.includes(v as TriageStatus);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Defensive parse of config-web's `{ reports: [...] }` listing — a malformed row is skipped, never thrown on. */
export function parseBugReportRows(json: unknown): BugReportRow[] {
  const list = (json as { reports?: unknown } | null)?.reports;
  if (!Array.isArray(list)) return [];
  const rows: BugReportRow[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    const t = (r.triage && typeof r.triage === "object" ? r.triage : {}) as Record<string, unknown>;
    rows.push({
      id,
      coach: str(r.coach),
      gameId: typeof r.gameId === "string" ? r.gameId : null,
      gameService: r.gameService === "fumbbl" || r.gameService === "fork" ? r.gameService : null,
      clientVersion: typeof r.clientVersion === "string" ? r.clientVersion : null,
      description: str(r.description),
      submittedAt: str(r.submittedAt),
      kind: r.kind === "feedback" ? "feedback" : "bug",
      triage: {
        status: isStatus(t.status) ? t.status : "new",
        rootCause: str(t.rootCause),
        reason: str(t.reason),
        updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : null,
        updatedBy: typeof t.updatedBy === "string" ? t.updatedBy : null,
      },
    });
  }
  return rows;
}

/** Report ids can run past Discord's 100-char customId cap, so buttons carry an 8-hex token instead. */
export function shortToken(id: string): string {
  return createHash("sha1").update(id).digest("hex").slice(0, 8);
}

interface NotifyStateFile {
  seen?: string[];
  tokens?: Record<string, string>;
}

/** Seen-report ledger + token→id map. Atomic writes (tmp + rename), same as the sibling announcers. */
export class BugReportNotifyState {
  constructor(private readonly filePath: string) {}

  private read(): NotifyStateFile {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as NotifyStateFile;
    } catch {
      return {};
    }
  }

  private write(d: NotifyStateFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  /** True before the first seed — nothing has been recorded yet. */
  isEmpty(): boolean {
    return !Array.isArray(this.read().seen);
  }

  hasSeen(id: string): boolean {
    return (this.read().seen ?? []).includes(id);
  }

  /** Record ids as seen and remember their short tokens for the triage buttons. */
  mark(ids: readonly string[]): void {
    const d = this.read();
    const seen = new Set(d.seen ?? []);
    const tokens = { ...(d.tokens ?? {}) };
    for (const id of ids) {
      seen.add(id);
      tokens[shortToken(id)] = id;
    }
    this.write({ seen: [...seen], tokens });
  }

  resolveToken(token: string): string | undefined {
    return this.read().tokens?.[token];
  }
}

/** Reports not yet in the ledger, oldest first so a burst posts in submission order. */
export function selectNewReports(rows: readonly BugReportRow[], state: BugReportNotifyState): BugReportRow[] {
  return rows.filter((r) => !state.hasSeen(r.id)).sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------
// config-web client (coach session: login once, Bearer thereafter, one re-login on a 401)

export interface ConfigWebClient {
  listReports(): Promise<BugReportRow[]>;
  getReport(id: string): Promise<BugReportDetail | undefined>;
  patchTriage(id: string, triage: { status: TriageStatus; rootCause: string; reason: string }): Promise<{ ok: boolean; error?: string }>;
}

export function createConfigWebClient(opts: {
  baseUrl: string;
  coach: string;
  password: string;
  fetchImpl?: typeof fetch;
}): ConfigWebClient {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const passwordMd5 = createHash("md5").update(opts.password).digest("hex");
  let token: string | undefined;

  async function login(): Promise<string> {
    const res = await f(`${base}/api/fork/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coach: opts.coach, passwordMd5 }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!res.ok || !body.token) throw new Error(`config-web login as ${opts.coach} failed: ${body.error ?? res.status}`);
    token = body.token;
    return token;
  }

  /** Authenticated request; a 401 (expired/evicted session) re-logs in once and retries. */
  async function call(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const bearer = token ?? (await login());
    const res = await f(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    });
    if (res.status === 401 && retry) {
      token = undefined;
      return call(path, init, false);
    }
    return res;
  }

  return {
    async listReports() {
      const res = await call("/api/bug-reports");
      if (!res.ok) throw new Error(`config-web GET /api/bug-reports -> ${res.status}`);
      return parseBugReportRows(await res.json());
    },
    async getReport(id) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
      const res = await call(`/api/bug-reports/${encodeURIComponent(id)}`);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`config-web GET /api/bug-reports/${id} -> ${res.status}`);
      const json = (await res.json()) as { files?: BugReportDetail["files"] };
      const [row] = parseBugReportRows({ reports: [json] });
      return row ? { ...row, files: json.files } : undefined;
    },
    async patchTriage(id, triage) {
      const res = await call(`/api/bug-reports/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(triage) });
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? `config-web PATCH -> ${res.status}` };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Discord rendering

const CUSTOM_ID_NS = "bugtriage";
const MODAL_NS = "bugtriage-modal";

export function triageButtonId(status: TriageStatus, token: string): string {
  return `${CUSTOM_ID_NS}:${status}:${token}`;
}

export function parseTriageCustomId(customId: string): { kind: "button" | "modal"; status: TriageStatus; token: string } | undefined {
  const [ns, status, token] = customId.split(":");
  const kind = ns === CUSTOM_ID_NS ? "button" : ns === MODAL_NS ? "modal" : undefined;
  if (!kind || !isStatus(status) || !token || !/^[0-9a-f]{8}$/.test(token)) return undefined;
  return { kind, status, token };
}

/** The admin console's Reports section (deep-linkable hash); the report id rides the card footer. */
function adminReportUrl(publicUrl: string, _id: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/admin.html#reports`;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function renderBugReportEmbed(r: BugReportDetail, publicUrl: string): EmbedBuilder {
  const status = r.triage.status;
  const title = `${r.kind === "feedback" ? "💬 Feedback" : "🐛 Bug report"} from ${r.coach || "unknown coach"}`;
  const game = r.gameId ? `${r.gameService ?? "?"} #${r.gameId}` : "—";
  const attachments = [
    r.files?.wireLog ? "wire log" : null,
    r.files?.appLog ? "app log" : null,
    r.files?.screenshot ? "screenshot" : null,
  ].filter(Boolean);
  const e = new EmbedBuilder()
    .setTitle(clip(title, 256))
    .setURL(adminReportUrl(publicUrl, r.id))
    .setColor(STATUS_COLOR[status])
    .setDescription(clip(r.description || "(no description)", 2048))
    .addFields(
      { name: "Game", value: game, inline: true },
      { name: "Client", value: r.clientVersion ?? "—", inline: true },
      { name: "Attachments", value: attachments.length ? attachments.join(", ") : "none", inline: true },
      { name: "Triage", value: triageSummary(r.triage) },
    )
    .setFooter({ text: `${r.id} · submitted ${r.submittedAt || "?"}` });
  return e;
}

function triageSummary(t: BugReportRow["triage"]): string {
  const head = `**${STATUS_LABEL[t.status]}**${t.updatedBy ? ` by ${t.updatedBy}` : ""}${t.updatedAt ? ` · ${t.updatedAt}` : ""}`;
  const lines = [head];
  if (t.rootCause) lines.push(`Root cause: ${clip(t.rootCause, 400)}`);
  if (t.reason) lines.push(`Reason: ${clip(t.reason, 400)}`);
  return clip(lines.join("\n"), 1024);
}

export function renderTriageButtons(id: string, publicUrl: string, current: TriageStatus): ActionRowBuilder<ButtonBuilder>[] {
  const token = shortToken(id);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...BUTTON_STATUSES.map((s) =>
      new ButtonBuilder()
        .setCustomId(triageButtonId(s, token))
        .setLabel(STATUS_LABEL[s])
        .setStyle(s === current ? ButtonStyle.Primary : s === "closed" ? ButtonStyle.Secondary : ButtonStyle.Success),
    ),
  );
  const link = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open in admin").setStyle(ButtonStyle.Link).setURL(adminReportUrl(publicUrl, id)),
  );
  return [row, link];
}

export function buildTriageModal(status: TriageStatus, token: string, current: BugReportRow["triage"]): ModalBuilder {
  const rootCause = new TextInputBuilder()
    .setCustomId("rootCause")
    .setLabel("Root cause")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(1000)
    .setPlaceholder("What actually broke (optional)");
  if (current.rootCause) rootCause.setValue(clip(current.rootCause, 1000));
  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Notes / reason")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(2000)
    .setPlaceholder("Triage notes (optional)");
  if (current.reason) reason.setValue(clip(current.reason, 2000));
  return new ModalBuilder()
    .setCustomId(`${MODAL_NS}:${status}:${token}`)
    .setTitle(`Mark as ${STATUS_LABEL[status]}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(rootCause),
      new ActionRowBuilder<TextInputBuilder>().addComponents(reason),
    );
}

// ---------------------------------------------------------------------------------------------
// Runtime: poll + interaction handlers

export interface BugReportNotifyContext {
  client: Client;
  api: ConfigWebClient;
  state: BugReportNotifyState;
  publicUrl: string;
  /** Discord user id to DM; also the only user allowed to press the triage buttons (when set). */
  notifyUserId?: string;
  notifyChannelId?: string;
}

export function bugReportNotifyContextFromEnv(client: Client, state: BugReportNotifyState): BugReportNotifyContext | undefined {
  const coach = process.env.CONFIG_WEB_SERVICE_COACH?.trim();
  const password = process.env.CONFIG_WEB_SERVICE_PASSWORD?.trim();
  const notifyUserId = process.env.BUG_REPORT_NOTIFY_USER_ID?.trim() || undefined;
  const notifyChannelId = process.env.BUG_REPORT_NOTIFY_CHANNEL_ID?.trim() || undefined;
  if (!coach || !password || (!notifyUserId && !notifyChannelId)) return undefined;
  const baseUrl = process.env.CONFIG_WEB_URL?.trim() || "http://127.0.0.1:4310";
  return {
    client,
    api: createConfigWebClient({ baseUrl, coach, password }),
    state,
    publicUrl: process.env.CONFIG_WEB_PUBLIC_URL?.trim() || baseUrl,
    notifyUserId,
    notifyChannelId,
  };
}

async function deliver(ctx: BugReportNotifyContext, payload: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }): Promise<string[]> {
  const notes: string[] = [];
  if (ctx.notifyUserId) {
    try {
      const user = await ctx.client.users.fetch(ctx.notifyUserId);
      await user.send(payload);
      notes.push(`DM → ${user.tag}`);
    } catch (e) {
      notes.push(`DM failed: ${(e as Error).message}`);
    }
  }
  if (ctx.notifyChannelId) {
    try {
      const ch = await ctx.client.channels.fetch(ctx.notifyChannelId);
      if (!ch?.isTextBased()) throw new Error(`<#${ctx.notifyChannelId}> is not a text channel`);
      await (ch as unknown as { send: (o: unknown) => Promise<unknown> }).send(payload);
      notes.push(`channel → <#${ctx.notifyChannelId}>`);
    } catch (e) {
      notes.push(`channel post failed: ${(e as Error).message}`);
    }
  }
  return notes;
}

/** Poll config-web; first run seeds silently, later runs post one card per genuinely new report. */
export async function pollBugReports(ctx: BugReportNotifyContext): Promise<string> {
  const rows = await ctx.api.listReports();
  if (ctx.state.isEmpty()) {
    ctx.state.mark(rows.map((r) => r.id));
    return `Bug-report notifier seeded with ${rows.length} existing report(s); new reports will notify.`;
  }
  const fresh = selectNewReports(rows, ctx.state);
  const notes: string[] = [];
  for (const row of fresh) {
    const detail = (await ctx.api.getReport(row.id).catch(() => undefined)) ?? row;
    const delivered = await deliver(ctx, {
      embeds: [renderBugReportEmbed(detail, ctx.publicUrl)],
      components: renderTriageButtons(detail.id, ctx.publicUrl, detail.triage.status),
    });
    ctx.state.mark([row.id]); // marked even on a failed delivery: never spam-retry a broken DM every minute
    notes.push(`${row.id}: ${delivered.join("; ")}`);
  }
  return notes.length ? notes.join("\n") : "";
}

function allowed(ctx: BugReportNotifyContext, userId: string): boolean {
  return !ctx.notifyUserId || ctx.notifyUserId === userId;
}

/** Button → modal (root cause + notes). Returns false when the customId isn't ours. */
export async function handleBugTriageButton(i: ButtonInteraction, ctx: BugReportNotifyContext): Promise<boolean> {
  const parsed = parseTriageCustomId(i.customId);
  if (!parsed || parsed.kind !== "button") return false;
  if (!allowed(ctx, i.user.id)) {
    await i.reply({ content: "Only the configured triager can update bug reports.", flags: MessageFlags.Ephemeral }).catch(() => void 0);
    return true;
  }
  const id = ctx.state.resolveToken(parsed.token);
  const current = id ? await ctx.api.getReport(id).catch(() => undefined) : undefined;
  if (!id || !current) {
    await i.reply({ content: "That report is no longer available on config-web.", flags: MessageFlags.Ephemeral }).catch(() => void 0);
    return true;
  }
  await i.showModal(buildTriageModal(parsed.status, parsed.token, current.triage));
  return true;
}

/** Modal submit → PATCH triage on config-web → refresh the card. Returns false when the customId isn't ours. */
export async function handleBugTriageModal(i: ModalSubmitInteraction, ctx: BugReportNotifyContext): Promise<boolean> {
  const parsed = parseTriageCustomId(i.customId);
  if (!parsed || parsed.kind !== "modal") return false;
  if (!allowed(ctx, i.user.id)) {
    await i.reply({ content: "Only the configured triager can update bug reports.", flags: MessageFlags.Ephemeral }).catch(() => void 0);
    return true;
  }
  const id = ctx.state.resolveToken(parsed.token);
  if (!id) {
    await i.reply({ content: "That report is no longer tracked by the bot.", flags: MessageFlags.Ephemeral }).catch(() => void 0);
    return true;
  }
  const rootCause = i.fields.getTextInputValue("rootCause") ?? "";
  const reason = i.fields.getTextInputValue("reason") ?? "";
  const result = await ctx.api.patchTriage(id, { status: parsed.status, rootCause, reason }).catch((e) => ({ ok: false, error: (e as Error).message }));
  if (!result.ok) {
    await i.reply({ content: `❌ Triage not saved: ${result.error ?? "unknown error"}`, flags: MessageFlags.Ephemeral }).catch(() => void 0);
    return true;
  }
  const updated = await ctx.api.getReport(id).catch(() => undefined);
  if (updated && i.isFromMessage()) {
    await i
      .update({
        embeds: [renderBugReportEmbed(updated, ctx.publicUrl)],
        components: renderTriageButtons(updated.id, ctx.publicUrl, updated.triage.status),
      })
      .catch(() => void 0);
  } else {
    await i.reply({ content: `✅ Marked ${STATUS_LABEL[parsed.status]}.`, flags: MessageFlags.Ephemeral }).catch(() => void 0);
  }
  return true;
}
