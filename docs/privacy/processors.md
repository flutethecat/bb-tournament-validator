# Processors and recipients

Who handles personal data on our behalf, or receives it. Keep this in step with the "Who we share it with" section of the
privacy notice.

| Processor | What they do | What they receive | Public terms / DPA |
|---|---|---|---|
| Discord Inc. | Sign-in (OAuth2) and league news posted through league webhooks | At sign-in, Discord tells us your id, username, avatar and verified email (we send them nothing about you); league webhooks receive the league news text we post | Terms and privacy: https://discord.com/privacy and https://discord.com/terms; developer terms: https://discord.com/developers/docs/policy; Discord's data processing terms are linked from its Privacy Policy page |
| Hosting provider (today: the operator's own machine in the United States; planned: DigitalOcean) | Runs the site and stores all the data in the inventory | Everything held on the server | DigitalOcean DPA: https://www.digitalocean.com/legal/data-processing-agreement |
| Mail provider (future, not in use) | Would send account or announcement email | Recipient address and message | Choose one with a published DPA and standard contractual clauses; record it here and in the notice before sending anything |
| Translation provider (chat auto-translate relay, when enabled) | Translates chat text sent through `/api/translate` | The text to translate; no coach identity is forwarded | Provider's own DPA, recorded here when a provider is enabled |

Checklist when adding a processor: sign or accept its DPA, record it in this file, add it to the notice, and update
`docs/privacy/log-hygiene.md` if it receives logs.
