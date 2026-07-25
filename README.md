# SCE Pay

`sce-pay` automates paying the entire current Southern California Edison bill by
card through SCE Guest Pay. A one-time local wizard calibrates the live flow and
deploys a Cloudflare Worker; Cloudflare Cron, Browser Run, and a Durable Object
then operate without a computer left online.

This is necessary because SCE does not allow credit cards for autopay. Shame!

The project is independent of and not endorsed by Southern California Edison or
Cloudflare.

## Install

```bash
git clone https://github.com/neuralnexus/sce-pay.git
cd sce-pay
npm ci
npx wrangler login
npm run setup
```

The wizard performs a preflight, opens the current SCE Guest Pay route in local
Chrome, and asks you to stop at the final review without submitting. It then:

1. proves the reviewed card ending from the page rather than trusting typed
   digits;
2. captures tokenized browser state and every HTTPS page, frame, and network
   origin;
3. asks you to approve that exact origin set;
4. collects the SCE account number, mailing ZIP, bill ceiling, due window, and
   optional notification webhook;
5. encrypts the bundle locally with authenticated AES-256-GCM;
6. deploys the Worker and both secrets in one version, initially disarmed;
7. uploads the ciphertext and runs the complete review in Cloudflare Browser
   Run; and
8. arms only that exact Worker release and configuration after the cloud dry run
   succeeds.

Card number, expiration, and security code are entered only into SCE's page.
`sce-pay` does not prompt for, extract, persist, log, or transmit raw card
fields.

## Runtime

- `0 17 * * *` Cron wakes the Worker daily in UTC.
- The Durable Object defers Browser Run until a meaningful check is due, so
  "daily Cron" does not mean "open a browser daily."
- Browser Run starts only at
  `https://www.sce.com/mysce/billsnpayments/paybills`.
- Top-level navigation must remain in that SCE application. The retired external
  portal is never an allowed top-level fallback.
- Frames, requests, and WebSockets must match the onboarding allowlist exactly.
- Browser state is refreshed and re-encrypted after safe runs when possible.
- Deploying new code or secrets changes the Worker version and automatically
  invalidates the prior arm state.

Cloudflare documents Browser Run support and current limits at
[Playwright](https://developers.cloudflare.com/browser-run/playwright/) and
[Browser Run limits](https://developers.cloudflare.com/browser-run/limits/).

## Payment authorization

Every real submission requires:

- a current, plausible SCE bill cycle;
- the entire current amount due;
- an amount at or below the configured bill ceiling;
- a due date inside the configured payment window;
- the same account, amount, due date, and card ending at bill and review;
- a convenience fee **strictly below `$4.00`**;
- exact `bill amount + fee = displayed total` arithmetic;
- one unique, enabled final-payment control;
- the reviewed route and origin contract;
- no confirmed fingerprint for the same account, due date, and amount; and
- no unresolved earlier submission.

The old exact `$1.65` assumption is gone.

Immediately before the one final click, the Durable Object revalidates its
exclusive lease and writes a durable `submitting` intent in the same serialized
state boundary. A recognizable SCE confirmation makes that intent `confirmed`.
Any ambiguous post-click result becomes `unknown`, disarms useful progress, and
blocks every automatic retry until manual reconciliation.

## Operate

`.sce-pay/control.json` contains the deployed URL and a private administrator
token. It is not used by Cron; the computer can be off or the file can be
deleted without stopping scheduled execution.

```bash
npm run sce-pay -- doctor
npm run sce-pay -- status
npm run sce-pay -- dry-run
npm run sce-pay -- disarm
npm run sce-pay -- arm       # performs a fresh dry run first
npm run sce-pay -- run --yes # deliberate real run
```

After independently checking SCE and the card account, reconcile an uncertain
intent:

```bash
npm run sce-pay -- reconcile INTENT_ID paid "Verified in SCE payment history"
npm run sce-pay -- reconcile INTENT_ID not-paid "Verified absent from SCE and card activity"
```

Read the [operations runbook](docs/operations.md) before reconciling or rotating
configuration.

## Notifications

An optional HTTPS webhook receives only `payment-confirmed` and
`attention-required` events. It never receives the account number, ZIP, card
token, card ending, bill amount, fee, or confirmation number.

Events include an ID and timestamp and are signed as:

```text
X-SCE-Pay-Signature: v1=BASE64URL(HMAC_SHA256(secret, timestamp + "." + body))
```

The wizard prints the signing secret once. Delivery has a five-second timeout,
one bounded retry, and cannot change a payment result.

## Development

```bash
npm ci
npm run validate
npm audit --audit-level=high
```

The gate runs formatting/lint rules, strict TypeScript, deterministic tests,
the production build, a Wrangler bundle dry run, and package-content
inspection. CI runs the same gate on Node.js 24.

See [architecture](docs/architecture.md),
[onboarding](docs/onboarding.md),
[payment target](docs/payment-target.md), and
[security](docs/security.md).

## Deployment qualification

The code can be validated without a real charge, but SCE exposes no supported
card-payment API and Cloudflare Browser Run is identifiable as automation. A
deployment is intentionally not armed until its account-specific Guest Pay
state reaches a valid review from Cloudflare. CAPTCHA, login, blocked cloud
browsers, expired/device-bound tokens, new origins, route changes, ambiguous
labels, or an unknown confirmation stop safely; the project does not bypass
those controls.

A dry run proves the current review path, not that SCE will keep a token valid
forever. Keep payment notifications enabled and periodically confirm SCE
payment history.
