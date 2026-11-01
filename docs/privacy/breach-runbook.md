# Personal data breach runbook

A breach is any loss, theft, unauthorised access to, or unauthorised change of personal data held by Super FUMBBL
(see `apps/config-web/spa/src/privacy/inventory.ts` for what we hold). GDPR and UK GDPR give us **72 hours from becoming
aware** to notify the supervisory authority, unless the breach is unlikely to put people at risk.

## Who decides

The site operator (the controller named in the privacy notice) decides whether a breach is notifiable and signs off any
notification. Anyone who suspects a breach tells the operator immediately; do not wait to be sure.

## The 72-hour steps

1. **Hour 0 - note the time.** Write down when and how you became aware. The 72 hours start here.
2. **Contain.** Stop the leak first: take the affected route or host offline if needed, revoke the access used.
3. **Rotate** whatever may have been exposed (see below).
4. **Assess.** What data (inventory ids), how many coaches, was it readable (plain, hashed, encrypted), who could have
   seen it, is it still exposed. Keep a dated log of every step.
5. **Decide (within 24 hours of awareness).** Likely to risk people's rights and freedoms? If yes, notify the authority
   within 72 hours. If the risk is high (for example emails or Discord ids published), also tell the affected coaches.
   If no notification is made, write down why.
6. **Notify the authority.** Use the lead supervisory authority's online breach form for the controller's country, or the
   authority where affected people live if there is no establishment in the EU. Give what you know; you may send the rest in phases.
7. **Tell affected coaches** when required: use the template below, by Discord message or email.
8. **Fix and review.** Close the root cause, add a test or check, and record the lessons.
9. **Keep the record** (facts, effects, actions) even when no notification was needed.

## What to rotate

| Secret | Where | How |
|---|---|---|
| Discord client secret | Discord developer portal, `DISCORD_CLIENT_SECRET` in the live `.env` | Reset in the portal, update `.env`, restart config-web. |
| League Discord webhook URLs | each league's settings (stored under `data-store/leagues/`); `DISCORD_RECORDER_WEBHOOK_URL` | Delete and recreate the webhook in Discord, paste the new URL. |
| Session store | `sessions.json` | Stop config-web, delete the file, start it: every coach must sign in again. |
| Admin password and fork passwords | `ADMIN_PASSWORD`, `FORK_ADMIN_PASSWORD` | Change in `.env`, restart. |
| Translation provider key | translate provider env settings | Revoke at the provider, set a new key. |

## Template message to affected coaches

> Subject: A security incident affecting your Super FUMBBL data
>
> On [date] we found that [what happened, in one or two plain sentences]. The data involved was [data kinds, for example
> your coach name and Discord username]. It [was / was not] publicly visible.
>
> What we have done: [containment and fixes]. What you should do: [for example, nothing is needed / be careful of
> messages that mention Super FUMBBL / review your Discord security settings].
>
> You can contact us at [contact address from the privacy notice] with any questions. You may also complain to your data
> protection authority.
