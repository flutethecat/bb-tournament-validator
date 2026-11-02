/**
 * Payment links for leagues and tournaments (owner 11-02: "Allow the user to input a link to PayPal and Venmo here to
 * receive payment"). Links only: coaches pay the organiser outside the site and organisers mark entries paid. There is
 * no PayPal or Venmo API, no money handling and nothing is fetched from either service.
 *
 * The server is the authority; spa/src/shared/payLinks.ts mirrors these rules for the forms (test/payLinks.test.ts
 * runs both over the same cases).
 *
 *   PayPal  https only, and only paypal.me/<name>[/<amount>] or www.paypal.com/paypalme/<name>[/<amount>]. A link typed
 *           without the scheme gets https://. Stored in its https form (host lower-cased, no query, fragment or
 *           trailing slash). <name> is 1-20 letters or digits (PayPal.Me names); <amount> is a number with up to two
 *           decimals and an optional three-letter currency ("15", "15.50", "15GBP").
 *   Venmo   the username only: letters, digits, - and _, 5-30 characters, an optional leading @. Stored without the @.
 *           The link is always built here as https://venmo.com/u/<handle>.
 *
 * Anything else (other hosts, http:, javascript:, data:, credentials, ports, encoded characters, look-alike hosts) is
 * refused. Reads re-check stored values (paymentLinksView), so a bad value written some other way never becomes a link.
 */

export const PAYPAL_INPUT_MAX = 200;
export const PAYPAL_ERROR = "PayPal link must be a paypal.me link, like https://paypal.me/YourName.";
export const VENMO_ERROR = "Venmo username must be 5 to 30 letters, digits, - or _ (like @Your-Name).";

export type PayLinkCheck = { ok: true; value: string } | { ok: false; error: string };

const PAYPAL_NAME = /^[A-Za-z0-9]{1,20}$/;
const PAYPAL_AMOUNT = /^(\d{1,7}(?:\.\d{1,2})?)([A-Za-z]{3})?$/;
const VENMO_HANDLE = /^[A-Za-z0-9_-]{5,30}$/;
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f\\%]/;

/** A PayPal.Me link in its stored https form, "" for a cleared field, or the refusal. */
export function normalisePayPal(raw: string): PayLinkCheck {
  const input = raw.trim();
  if (!input) return { ok: true, value: "" };
  const bad = { ok: false as const, error: PAYPAL_ERROR };
  if (input.length > PAYPAL_INPUT_MAX || UNSAFE_CHARS.test(input)) return bad;
  // A scheme other than https (http:, javascript:, data:, ...) is refused; no scheme at all means https.
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(input);
  if (scheme && scheme[1]!.toLowerCase() !== "https") return bad;
  if (scheme && !/^https:\/\//i.test(input)) return bad;
  let url: URL;
  try { url = new URL(scheme ? input : `https://${input}`); } catch { return bad; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return bad;
  if (input.includes("?") || input.includes("#") || input.includes("@")) return bad;
  const host = url.hostname.toLowerCase();
  // The pathname starts with "/" and may end with one: drop those only (an empty middle segment stays and fails).
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

/** A Venmo username without the @, "" for a cleared field, or the refusal. */
export function normaliseVenmo(raw: string): PayLinkCheck {
  const input = raw.trim();
  if (!input) return { ok: true, value: "" };
  const handle = input.startsWith("@") ? input.slice(1) : input;
  return VENMO_HANDLE.test(handle) ? { ok: true, value: handle } : { ok: false, error: VENMO_ERROR };
}

/** The Venmo profile link for a stored handle (undefined when the handle is not valid). */
export function venmoUrl(handle: string): string | undefined {
  return VENMO_HANDLE.test(handle) ? `https://venmo.com/u/${handle}` : undefined;
}

/**
 * A body field: undefined = untouched; null or "" = clear (""); otherwise the normalised value. Non-strings and refused
 * values answer `{ ok: false }` with the message for the field.
 */
export function parsePayField(kind: "payPal" | "venmo", value: unknown): PayLinkCheck | undefined {
  if (value === undefined) return undefined;
  if (value === null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, error: kind === "payPal" ? PAYPAL_ERROR : VENMO_ERROR };
  return kind === "payPal" ? normalisePayPal(value) : normaliseVenmo(value);
}

export interface PaymentLinksView {
  /** The PayPal.Me link (https). */
  payPal?: string;
  venmo?: { handle: string; url: string };
}

/** The links a page may show for stored values: each re-checked, so only valid links come out. Undefined = none. */
export function paymentLinksView(payPal: unknown, venmo: unknown): PaymentLinksView | undefined {
  const out: PaymentLinksView = {};
  if (typeof payPal === "string" && payPal) {
    const p = normalisePayPal(payPal);
    if (p.ok && p.value === payPal) out.payPal = p.value;
  }
  if (typeof venmo === "string" && venmo) {
    const url = venmoUrl(venmo);
    if (url) out.venmo = { handle: venmo, url };
  }
  return out.payPal || out.venmo ? out : undefined;
}
