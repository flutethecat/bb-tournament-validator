# Portal mail: owner setup (Postmark)

The site sends two kinds of email, both from the server, so league organisers never see a coach's address:

- **Address confirmation** (transactional): Account page, Email panel, "Send confirmation link".
- **League messages**: an organiser's "Message members" on the league page (Overview, newest season). Every recipient
  gets an in-portal notification; email goes only to members who acknowledged sharing with that league, gave
  league-contact consent and have a confirmed, non-bounced address. Each email carries a one-click unsubscribe link
  and `List-Unsubscribe` / `List-Unsubscribe-Post` headers.

No marketing mail. Until `POSTMARK_SERVER_TOKEN` is set, nothing leaves the host: the log transport writes one redacted
line per message (template and recipient count, never an address).

Code: `apps/config-web/src/mail/`. State: `<FORK_STATE_DIR>/mail/` (outbox journal, prefs, suppression hashes, audit).

## 1. Create the Postmark server

1. Sign up at https://postmarkapp.com and create a **Server** (for example "Super FUMBBL").
2. It comes with a transactional stream called `outbound`. That stream carries the confirmation emails.
3. Recommended: add a **Broadcasts** message stream for league messages (Servers > your server > Message Streams >
   Create stream > Broadcasts), id for example `broadcast`. Postmark asks for bulk-style mail (one message to many
   people) to go through a Broadcasts stream; league messages are that. In the stream's settings, unsubscribe
   handling: the site adds its own unsubscribe link and headers. If you leave Postmark's own unsubscribe link on too,
   coaches see two links; both work (Postmark's sends a Subscription Change webhook the site honours).
4. Copy the **Server API token** (Servers > your server > API Tokens). It goes into `.env` only (step 4), never into
   the repo or a chat.
5. Postmark needs the account approved before it sends to anyone outside your own domain; request approval from the
   account page once DNS (step 3) is verified.

## 2. Sender signature for superfumbbl.com

Sender Signatures > Add Domain > `superfumbbl.com`. Postmark then shows the exact DNS values for your account (the DKIM
key is unique to it). The From address is a no-reply address on that domain (for example `noreply@` the domain); the
display name is always "Super FUMBBL" (set in code).

## 3. DNS records (at the superfumbbl.com DNS host)

| Type | Host / name | Value | Notes |
|---|---|---|---|
| TXT | `@` (the domain) | `v=spf1 include:spf.mtasv.net ~all` | If an SPF record already exists, add `include:spf.mtasv.net` to it instead of creating a second one (only one SPF record per name). |
| TXT | the DKIM host Postmark shows (looks like `<date>pm._domainkey`) | the `k=rsa; p=...` value Postmark shows | Copy both exactly from the Postmark Domains page. |
| CNAME | `pm-bounces` | `pm.mtasv.net` | Return-Path: aligns bounces with the domain (Postmark calls it "Custom Return-Path"). Then press Verify in Postmark. |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:<a mailbox you read>` | Start with `p=none` (report only). After a few weeks of clean reports, move to `p=quarantine`. |

Wait for Postmark to show DKIM and Return-Path as **Verified** (DNS can take up to a day).

## 4. Environment keys (`apps/config-web/.env` on the host)

Set the values on the host only; the repo's `.env.example` lists the names.

| Key | Value |
|---|---|
| `POSTMARK_SERVER_TOKEN` | the Server API token from step 1 |
| `MAIL_FROM` | the no-reply address on superfumbbl.com (bare address, no name) |
| `MAIL_REPLY_TO` | optional; leave unset (replies to league mail are not read; the footer says so) |
| `MAIL_STREAM` | `outbound` (default) |
| `MAIL_LEAGUE_STREAM` | the Broadcasts stream id from step 1.3 (for example `broadcast`); unset = `MAIL_STREAM` |
| `MAIL_LINK_SECRET` | a random string of at least 32 characters (for example `openssl rand -hex 32`); signs unsubscribe and confirmation links. Changing it invalidates links already sent. Unset = a host key file `<state>/mail/link.key` |
| `MAIL_LINK_BASE_URL` | the public site origin, for example `https://superfumbbl.com`; unset = `PUBLIC_BASE_URL`. Without either, email stays off |
| `POSTMARK_WEBHOOK_SECRET` | a random string; the password Postmark sends to the webhook (step 5) |

Restart config-web (the scheduled task). The log shows `[mail] ...` warnings for anything missing (names only).

## 5. Webhook (bounces and spam complaints)

Servers > your server > the **outbound** stream > Webhooks > Add webhook (repeat for the Broadcasts stream):

- URL: `https://postmark:<POSTMARK_WEBHOOK_SECRET>@<site host>/api/mail/postmark/webhook` (Postmark sends the user and
  password as HTTP Basic auth; the site checks the password).
- Events: **Bounce**, **Spam Complaint**, **Subscription Change**. (Delivery, Open and Click are not needed; open and
  link tracking are off.)
- Hard bounces, spam complaints and Postmark suppressions mark the address as suppressed. The site stores only a
  salted hash of the address; it never mails that address again. Soft bounces are ignored.

Postmark's "Send test" button should return 200.

## 6. Test

1. On the Account page, Email panel: enter an address you own and press **Send confirmation link**. The email arrives
   from "Super FUMBBL"; the link shows "Email confirmed".
2. League emails also need league-contact consent and the league acknowledgement (the onboarding flow records both).
   Until that lands, league messages reach notifications only and report every member as "no email".
3. As an organiser, League page > Overview > **Message members** > one coach (yourself on a second account) > Send. The
   result shows no counts for one coach or one team (counts would reveal that coach's choices); an all-members message
   to 5 or more shows the notified count, and the email breakdown only when no group is 1 or 2 members.
4. Open the email's "Stop league emails" link: a confirmation page with one button. In Gmail, the "Unsubscribe" link next
   to the sender uses the one-click header.
5. Postmark Activity shows each message; the outbox is `<state>/mail/outbox/journal.jsonl`.

## Limits and retention

- Worker: 10 emails a second; each league at most 500 emails a UTC day (a message that would pass the cap is refused
  with a clear error); an organiser at most 10 messages an hour per league.
- Retryable failures (Postmark 5xx / 429 / network) retry inside the request (3 times, backoff from 0.5 s), then in the
  outbox (30 s, 2 min, 8 min, 32 min, 1 h; 6 attempts), then dead-letter. Other 4xx are not retried; Postmark error 406
  (inactive recipient) suppresses the address.
- Outbox: addresses and bodies of sent / dead messages are removed after 30 days; the remaining record (no address or
  text) after 180 days; a daily sweep applies this on a running server. Suppression hashes are kept.
- Queued league mail is re-checked right before each attempt: a coach who withdrew consent, changed or lost the
  confirmed address, or got suppressed meanwhile is dropped (the audit counts it as skipped).
- Complaints are sticky: a later bounce or a Postmark reactivation never lifts them. Only an explicit admin clear
  (`mail.clearSuppression`, logged) or the coach re-confirming the address after turning league email back on does.
- Unsubscribe links last 60 days and are bound to the coach, the address the email went to and the coach's consent
  generation: after an address change or a re-consent, older links show "Link out of date" and change nothing.
- Asking for a confirmation link to an address that bounced or complained answers like any other request (and uses up
  the rate limit) but sends nothing, so the form cannot be used to test which addresses are suppressed.
- The outbox is channel-agnostic (`channel: "email"` on every item, a transport per channel), ready for a Discord DM
  channel later. Postmark keeps its own activity (with addresses) for the retention
  set on the server (45 days by default); lower it in the server settings if you like.
- Processor record: `docs/privacy/processors.md`. Inventory row: `mail` in `apps/config-web/spa/src/privacy/inventory.ts`.
