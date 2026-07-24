# Onboarding

## Prerequisites

- Node.js 22 or newer
- Google Chrome
- a Cloudflare account with Workers, Browser Run, Durable Objects, and a
  `workers.dev` subdomain
- Wrangler authenticated with `npx wrangler login`
- SCE customer account number and five-digit mailing ZIP
- a card the current SCE Guest Pay flow can tokenize or retain

Run the standalone preflight at any time:

```bash
npm run sce-pay -- doctor
```

It checks Node, Wrangler authentication, and Chrome without touching an SCE
account or deploying.

## Wizard

```bash
npm ci
npx wrangler login
npm run setup
```

Chrome opens at the current SCE-owned payment route. Choose Guest Pay, complete
the guest card flow, and stop at final review. Do not submit.

The capture must remain top-level at:

```text
https://www.sce.com/mysce/billsnpayments/paybills
```

The wizard rejects legacy/external top-level portals. It derives the masked card
ending from the review and displays every top-level, frame, and supporting
network origin observed. Approve only the origins you recognize from this
reviewed flow.

The remaining prompts collect:

- SCE customer account number and ZIP as hidden input;
- maximum bill amount, default `$750.00`;
- exclusive convenience-fee ceiling, default and maximum `$4.00`;
- days before due date to pay, default `14`; and
- optional credential-free HTTPS notification webhook.

The default fee policy accepts `$0.00` through `$3.99` and rejects `$4.00` or
more.

## Deployment transaction

The wizard generates a configuration ID, encryption key, administrator token,
and optional webhook signing secret. It encrypts the complete bundle locally,
writes a temporary private secrets file, and asks Wrangler to deploy code and
both Worker secrets in one version. The temporary file is removed in `finally`.

The local control file is saved immediately after deployment, before state
upload, so an interrupted reconfiguration still leaves a recovery credential.
The Worker decrypts and validates the bundle before accepting it and always
stores new configuration disarmed.

The wizard then performs the complete account-specific review in Cloudflare
Browser Run. Only that exact release and configuration can be armed, and the
attestation expires after one hour.

## Expected failures

The Worker remains disarmed when:

- Guest Pay does not retain a reusable tokenized method;
- the payment method ending is absent or ambiguous;
- SCE requests CAPTCHA, login, or another interactive challenge;
- SCE blocks Browser Run;
- a page, frame, request, or WebSocket origin was not reviewed;
- top-level navigation leaves the current SCE route;
- labels, dates, arithmetic, or final control are ambiguous; or
- the Worker release changes after validation.

Do not solve CAPTCHA programmatically or approve unfamiliar origins. Inspect the
current flow and rerun onboarding.

## Reconfiguration

Rerunning setup rotates Worker secrets and configuration, invalidating the
prior arm record. Confirmed fingerprints remain. A blocking unresolved intent
prevents configuration replacement; reconcile it first using the current
control token.
