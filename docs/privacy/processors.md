# Processors and recipients

Who handles personal data on our behalf, or receives it. Keep this in step with the "Who we share it with" section of the
privacy notice.

| Processor | What they do | What they receive | Public terms / DPA |
|---|---|---|---|
| Discord Inc. | Sign-in (OAuth2) and league news posted through league webhooks | At sign-in, Discord tells us your id, username, avatar and verified email (we send them nothing about you); league webhooks receive the league news text we post | Terms and privacy: https://discord.com/privacy and https://discord.com/terms; developer terms: https://discord.com/developers/docs/policy; Discord's data processing terms are linked from its Privacy Policy page |
| Hosting provider (today: the operator's own machine in the United States; planned: DigitalOcean) | Runs the site and stores all the data in the inventory | Everything held on the server | DigitalOcean DPA: https://www.digitalocean.com/legal/data-processing-agreement |
| Postmark (ActiveCampaign, LLC; only while `POSTMARK_SERVER_TOKEN` is set) | Delivers portal email: address-confirmation links and league messages organisers send through the site (organisers never receive addresses). Sends bounce / spam-complaint webhooks back | Recipient address, subject and message text, the league id and message id as metadata; open and link tracking are off | Privacy: https://postmarkapp.com/privacy-policy; DPA (with standard contractual clauses): https://postmarkapp.com/dpa; terms: https://postmarkapp.com/terms-of-service; accept the DPA before the first send |
| DeepL SE (optional: only when an operator sets `TRANSLATE_PROVIDER=deepl` with a key) | Translates chat text sent through `/api/translate` | The message text and language codes; no coach identity is forwarded | https://www.deepl.com/en/pro-data-security and the DPA linked from https://www.deepl.com/en/privacy |
| Microsoft Azure Translator (optional: only when `TRANSLATE_PROVIDER=azure` with a key) | Same | Same | https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA |
| LibreTranslate (default, self-hosted on the same host) | Same | Stays on our own server | Not a third party |

The privacy notice names Postmark only while `POSTMARK_SERVER_TOKEN` is set (`GET /api/privacy/contact` reports
`mail: "postmark"`, never the token); without it no email leaves the host (the log transport writes a redacted line).
What the mail module stores is the `mail` row of the inventory (`apps/config-web/spa/src/privacy/inventory.ts`): outbox
bodies and addresses are stripped 30 days after sending, bounce / complaint addresses are kept only as salted hashes.

The privacy notice names DeepL or Azure only while one is enabled: `GET /api/privacy/contact` reports `translation` from
`TRANSLATE_PROVIDER` and the matching key being set (never the key).

Checklist when adding a processor: sign or accept its DPA, record it in this file, add it to the notice, and update
`docs/privacy/log-hygiene.md` if it receives logs.
