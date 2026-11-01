# Processors and recipients

Who handles personal data on our behalf, or receives it. Keep this in step with the "Who we share it with" section of the
privacy notice.

| Processor | What they do | What they receive | Public terms / DPA |
|---|---|---|---|
| Discord Inc. | Sign-in (OAuth2) and league news posted through league webhooks | At sign-in, Discord tells us your id, username, avatar and verified email (we send them nothing about you); league webhooks receive the league news text we post | Terms and privacy: https://discord.com/privacy and https://discord.com/terms; developer terms: https://discord.com/developers/docs/policy; Discord's data processing terms are linked from its Privacy Policy page |
| Hosting provider (today: the operator's own machine in the United States; planned: DigitalOcean) | Runs the site and stores all the data in the inventory | Everything held on the server | DigitalOcean DPA: https://www.digitalocean.com/legal/data-processing-agreement |
| Mail provider (future, not in use) | Would send account or announcement email | Recipient address and message | Choose one with a published DPA and standard contractual clauses; record it here and in the notice before sending anything |
| DeepL SE (optional: only when an operator sets `TRANSLATE_PROVIDER=deepl` with a key) | Translates chat text sent through `/api/translate` | The message text and language codes; no coach identity is forwarded | https://www.deepl.com/en/pro-data-security and the DPA linked from https://www.deepl.com/en/privacy |
| Microsoft Azure Translator (optional: only when `TRANSLATE_PROVIDER=azure` with a key) | Same | Same | https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA |
| LibreTranslate (default, self-hosted on the same host) | Same | Stays on our own server | Not a third party |

The privacy notice names DeepL or Azure only while one is enabled: `GET /api/privacy/contact` reports `translation` from
`TRANSLATE_PROVIDER` and the matching key being set (never the key).

Checklist when adding a processor: sign or accept its DPA, record it in this file, add it to the notice, and update
`docs/privacy/log-hygiene.md` if it receives logs.
