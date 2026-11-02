// Payment links (owner 11-02): the SPA's copy of the server's rules (src/payments/links.ts), so the forms say what is
// wrong before a save. The server stays the authority and test/payLinks.test.ts runs both over the same cases.
// Links only: coaches pay the organiser outside the site; Super FUMBBL handles no money.

export const PAYPAL_ERROR = "PayPal link must be a paypal.me link, like https://paypal.me/YourName.";
export const VENMO_ERROR = "Venmo username must be 5 to 30 letters, digits, - or _ (like @Your-Name).";
export const PAY_NOTE = "Payment is made directly to the organiser. Super FUMBBL doesn't handle payments.";
const PAYPAL_INPUT_MAX = 200;

export type PayLinkCheck = { ok: true; value: string } | { ok: false; error: string };

const PAYPAL_NAME = /^[A-Za-z0-9]{1,20}$/;
const PAYPAL_AMOUNT = /^(\d{1,7}(?:\.\d{1,2})?)([A-Za-z]{3})?$/;
const VENMO_HANDLE = /^[A-Za-z0-9_-]{5,30}$/;
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f\\%]/;

/** paypal.me/<name>[/<amount>] or www.paypal.com/paypalme/<name>[/<amount>], https only, in its stored https form. */
export function normalisePayPal(raw: string): PayLinkCheck {
  const input = raw.trim();
  if (!input) return { ok: true, value: "" };
  const bad = { ok: false as const, error: PAYPAL_ERROR };
  if (input.length > PAYPAL_INPUT_MAX || UNSAFE_CHARS.test(input)) return bad;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(input);
  if (scheme && scheme[1]!.toLowerCase() !== "https") return bad;
  if (scheme && !/^https:\/\//i.test(input)) return bad;
  let url: URL;
  try { url = new URL(scheme ? input : `https://${input}`); } catch { return bad; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return bad;
  if (input.includes("?") || input.includes("#") || input.includes("@")) return bad;
  const host = url.hostname.toLowerCase();
  const segs = url.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
  let rest: string[];
  if (host === "paypal.me") rest = segs;
  else if (host === "www.paypal.com" && segs[0]?.toLowerCase() === "paypalme") rest = segs.slice(1);
  else return bad;
  if (rest.length < 1 || rest.length > 2 || !PAYPAL_NAME.test(rest[0]!)) return bad;
  let amount = "";
  if (rest.length === 2) {
    const m = PAYPAL_AMOUNT.exec(rest[1]!);
    if (!m) return bad;
    amount = `/${m[1]}${m[2] ? m[2].toUpperCase() : ""}`;
  }
  const base = host === "paypal.me" ? "https://paypal.me/" : "https://www.paypal.com/paypalme/";
  return { ok: true, value: `${base}${rest[0]}${amount}` };
}

/** A Venmo username without the @ (5-30 letters, digits, - or _). */
export function normaliseVenmo(raw: string): PayLinkCheck {
  const input = raw.trim();
  if (!input) return { ok: true, value: "" };
  const handle = input.startsWith("@") ? input.slice(1) : input;
  return VENMO_HANDLE.test(handle) ? { ok: true, value: handle } : { ok: false, error: VENMO_ERROR };
}

/** The field's problem ("" when it is fine or blank). */
export const payPalProblem = (raw: string): string => { const r = normalisePayPal(raw); return r.ok ? "" : r.error; };
export const venmoProblem = (raw: string): string => { const r = normaliseVenmo(raw); return r.ok ? "" : r.error; };

export interface PaymentLinks { payPal?: string; venmo?: { handle: string; url: string } }

/**
 * The links the page renders, from what the server sent: each re-checked (a PayPal link must already be in its https
 * form; the Venmo link is rebuilt from the handle), so only paypal.me / paypal.com and venmo.com links ever become hrefs.
 */
export function safePaymentLinks(links: PaymentLinks | null | undefined): PaymentLinks | undefined {
  if (!links || typeof links !== "object") return undefined;
  const out: PaymentLinks = {};
  if (typeof links.payPal === "string") {
    const p = normalisePayPal(links.payPal);
    if (p.ok && p.value && p.value === links.payPal) out.payPal = p.value;
  }
  const handle = links.venmo && typeof links.venmo === "object" ? links.venmo.handle : undefined;
  if (typeof handle === "string" && VENMO_HANDLE.test(handle)) out.venmo = { handle, url: `https://venmo.com/u/${handle}` };
  return out.payPal || out.venmo ? out : undefined;
}

/** "Payment: received" / "Payment: not yet marked" (a coach's own entry). */
export const paymentStatusText = (paid: boolean): string => (paid ? "Payment: received" : "Payment: not yet marked");
