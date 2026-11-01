// Email templates. User text is plain text only: escaped for the HTML part, never interpreted as HTML or Markdown.

import type { MailHeader } from "./transport.js";

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Strips control characters (keeps newlines and tabs) and CR; header-safe one-liners drop newlines too. */
export const cleanText = (s: string): string => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
export const oneLine = (s: string): string => cleanText(s).replace(/[\n\t]+/g, " ").trim();

function shell(title: string, inner: string, footer: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>`
    + `<body style="margin:0;padding:0;background:#f2efe8;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1d1b18">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #d8d2c4">`
    + `<tr><td style="background:#1d1b18;color:#f2c14e;padding:14px 20px;font-weight:700;letter-spacing:.04em">SUPER FUMBBL</td></tr>`
    + `<tr><td style="padding:20px">${inner}</td></tr>`
    + `<tr><td style="padding:14px 20px;border-top:1px solid #e6e1d6;font-size:12px;color:#6b665c">${footer}</td></tr>`
    + `</table></td></tr></table></body></html>`;
}

export interface LeagueMessageInput {
  leagueName: string;
  senderCoach: string;
  subject: string;
  body: string;
  leagueUrl: string;
  unsubscribeUrl: string;
}

export interface RenderedMail { subject: string; text: string; html: string; headers: MailHeader[] }

export function renderLeagueMessage(m: LeagueMessageInput): RenderedMail {
  const league = oneLine(m.leagueName);
  const sender = oneLine(m.senderCoach);
  const subject = `[${league}] ${oneLine(m.subject)}`;
  const body = cleanText(m.body).trim();
  const text = [
    `${sender} (organiser of ${league}) sent this message to league members through Super FUMBBL.`,
    "",
    body,
    "",
    "--",
    `League page: ${m.leagueUrl}`,
    "Replies to this email are not read. Contact the organiser through the league page.",
    `Stop league emails: ${m.unsubscribeUrl}`,
  ].join("\n");
  const html = shell(
    subject,
    `<p style="margin:0 0 4px;font-size:13px;color:#6b665c">${escapeHtml(league)} · from ${escapeHtml(sender)}, organiser</p>`
      + `<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(oneLine(m.subject))}</h1>`
      + `<div style="white-space:pre-wrap;line-height:1.5;font-size:15px">${escapeHtml(body)}</div>`
      + `<p style="margin:20px 0 0"><a href="${escapeHtml(m.leagueUrl)}" style="color:#8a5a00">Open the league page</a></p>`,
    `Sent through Super FUMBBL to members of ${escapeHtml(league)} who agreed to league emails. The organiser does not see your address. `
      + `Replies are not read. <a href="${escapeHtml(m.unsubscribeUrl)}" style="color:#6b665c">Stop league emails</a>.`,
  );
  return {
    subject,
    text,
    html,
    headers: [
      { name: "List-Unsubscribe", value: `<${m.unsubscribeUrl}>` },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ],
  };
}

export function renderVerifyEmail(m: { coach: string; verifyUrl: string }): RenderedMail {
  const coach = oneLine(m.coach);
  const subject = "Confirm your email for Super FUMBBL";
  const text = [
    `Hello ${coach},`,
    "",
    "Confirm this address for league emails on Super FUMBBL by opening the link below (it works for 24 hours):",
    m.verifyUrl,
    "",
    "If you did not ask for this, ignore this email: nothing changes.",
  ].join("\n");
  const html = shell(
    subject,
    `<p style="margin:0 0 12px">Hello ${escapeHtml(coach)},</p>`
      + `<p style="margin:0 0 16px">Confirm this address for league emails on Super FUMBBL. The link works for 24 hours.</p>`
      + `<p style="margin:0 0 16px"><a href="${escapeHtml(m.verifyUrl)}" style="display:inline-block;background:#1d1b18;color:#f2c14e;padding:10px 16px;text-decoration:none;font-weight:700">Confirm email</a></p>`
      + `<p style="margin:0;font-size:13px;color:#6b665c">If you did not ask for this, ignore this email: nothing changes.</p>`,
    "Super FUMBBL account email. You get this only because someone entered this address on the Account page.",
  );
  return { subject, text, html, headers: [] };
}

/** The small HTML pages the public link routes answer with. */
export function linkPage(title: string, message: string, form?: { action: string; token: string; button: string }): string {
  const formHtml = form
    ? `<form method="post" action="${escapeHtml(form.action)}"><input type="hidden" name="token" value="${escapeHtml(form.token)}">`
      + `<button type="submit" style="font:inherit;padding:8px 16px;background:#1d1b18;color:#f2c14e;border:0;cursor:pointer">${escapeHtml(form.button)}</button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${escapeHtml(title)} · Super FUMBBL</title></head>`
    + `<body style="margin:0;padding:32px 16px;background:#f2efe8;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1d1b18">`
    + `<main style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #d8d2c4;padding:20px">`
    + `<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1><p style="margin:0 0 16px">${escapeHtml(message)}</p>${formHtml}`
    + `<p style="margin:16px 0 0;font-size:13px"><a href="/app/account">Account page</a></p></main></body></html>`;
}
