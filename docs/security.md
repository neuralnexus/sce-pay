# Security and threat model

## Protected data

The encrypted guest bundle contains the SCE account number, mailing ZIP, masked
card ending, tokenized browser storage, approved origin contract, payment
limits, and optional webhook configuration. Raw card number, expiration,
security code, SCE password, screenshots, HTML, and network payloads are outside
the application data model.

The bundle uses AES-256-GCM with a random 96-bit IV, authenticated context, and a
SHA-256-derived bundle ID. The key is a non-readable Worker secret; Durable
Object storage holds only ciphertext. Runtime validation bounds bundle,
cookie/storage, origin, request, note, confirmation, and API-body sizes.

## Trust boundaries

- SCE remains the billing and payment system of record.
- The card issuer remains the independent source for charge verification.
- Cloudflare runs the Worker/browser and controls secrets and Durable state.
- The local machine performs one-time reviewed calibration and optional control.
- A notification endpoint receives sanitized signed events only.

A Cloudflare administrator can replace Worker code or secrets. Protect the
Cloudflare account with phishing-resistant MFA and least privilege.

## Payment controls

- exact SCE top-level route;
- reviewed page, frame, request, and WebSocket origins;
- service workers blocked so network enforcement remains visible;
- popups, downloads, dialogs, and new origins rejected;
- current observation and plausible bill-cycle bounds;
- entire balance, bill ceiling, due window, displayed card ending;
- fee strictly below the configured ceiling and never above `$4.00`;
- unambiguous review values and exact arithmetic;
- unique enabled final action;
- exclusive lease revalidated at the intent transaction;
- intent before click, confirmed fingerprint after success;
- no automatic retry after `submitting` crash or `unknown` result;
- new code/secrets automatically invalidate arming;
- exact-release dry run required within one hour;
- no CAPTCHA, authentication, or anti-bot bypass.

## Control API

The public surface has a liveness endpoint and a bearer-authenticated API.
Bearer comparison is hash-based constant-time; routes enforce exact methods,
JSON content type, and body limits. Responses disable caching, framing,
sniffing, referrers, and cross-origin embedding. Authenticated readiness is 200
only when configured, armed for the current release, and not blocked.

`.sce-pay/control.json` contains the Worker URL and administrator token, is
created with private permissions, and is ignored by Git. It is unnecessary for
Cron. If exposed, rotate the deployment credentials and run a fresh cloud dry
run; version binding prevents the replacement release from paying before that
validation.

## Notifications and telemetry

Webhook bodies omit account, ZIP, card, amount, fee, confirmation, and browser
state. Each body has a unique ID/timestamp and HMAC-SHA-256 signature. Delivery
uses HTTPS without URL credentials, rejects redirects, times out after five
seconds, and retries at most once.

Worker logs contain release ID, high-level outcome, HTTP status, and sanitized
errors. Browser screenshots, traces, HTML, request/response bodies, secrets, and
payment identifiers are never logged.

## Residual risks

SCE offers no supported card-payment API for this project. Browser state may be
short-lived, device/IP-bound, or unusable from Cloudflare, and Browser Run is
identifiable as automation. The mandatory cloud dry run is an initial
qualification, not a guarantee of future acceptance. Site changes stop safely
but still require human attention to avoid a late bill.

An SCE or payment-page compromise within an already approved origin remains
inside the user's trust decision. Origin allowlists limit unexpected expansion;
they do not replace SCE's own security.
