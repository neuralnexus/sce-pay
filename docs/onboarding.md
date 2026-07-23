# Onboarding

## Prerequisites

- Node.js 22 or newer
- Google Chrome
- a Cloudflare account with Workers, Browser Run, Durable Objects, and a
  `workers.dev` subdomain available
- Wrangler authenticated with `npx wrangler login`
- the SCE customer account number and five-digit mailing ZIP
- a card that the current SCE Guest Pay experience can tokenize or remember

## Wizard

Run:

```bash
npm ci
npx wrangler login
npm run setup
```

Chrome opens on the current SCE payment route. Choose Guest Pay and complete the
flow until the final review page. Enter card data only into the SCE-controlled
page. Do not click the final submission control.

Back in the terminal, confirm the exact top-level and embedded HTTPS origins.
Do not approve an origin you do not recognize from the reviewed payment flow.

The wizard then requests:

- SCE customer account number (hidden input);
- five-digit mailing ZIP (hidden input);
- the reviewed card's last four digits;
- maximum bill amount;
- exclusive fee ceiling, default `$4.00`;
- number of days before due date to pay, default `14`; and
- optional HTTPS notification webhook.

The default fee policy accepts `$0.00` through `$3.99` and rejects `$4.00` or
more.

## Deployment gate

The wizard deploys the Worker in a disarmed state, installs fresh secrets,
uploads the encrypted bundle, and invokes a dry run in Cloudflare Browser Run.
Only a successful review arms the Cron.

If the dry run fails, the deployment remains disarmed. Common causes:

- the guest token is not reusable;
- the card method is no longer visible;
- SCE asked for an anti-automation challenge;
- Cloudflare's browser was blocked;
- an origin changed between local calibration and cloud execution; or
- SCE labels or review structure changed.

Never work around a CAPTCHA or broaden origin approval blindly. Inspect the
current flow and rerun onboarding.

## Recovery

Token expiration or page drift does not require keeping the computer online.
It requires a new one-time setup:

```bash
npm run setup
```

The new encrypted bundle replaces the old one. Confirmed bill fingerprints and
unresolved payment intents remain in the Durable Object.
