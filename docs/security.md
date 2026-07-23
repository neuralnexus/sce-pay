# Security and threat model

## Protected data

The guest bundle can contain:

- SCE customer account number;
- mailing ZIP;
- payment-method last four;
- tokenized cookies, local storage, IndexedDB, and session storage;
- reviewed origin allowlists;
- payment policy; and
- optional webhook URL.

The bundle is encrypted locally with AES-256-GCM. Cloudflare stores the
ciphertext in the account Durable Object and the encryption key as a Worker
secret.

Raw primary account number, expiration, and card security code are outside the
application boundary. They are entered into SCE's page during calibration and
are not requested or extracted by `sce-pay`.

## Trust boundaries

- SCE and its current payment provider remain the billing and payment systems
  of record.
- Cloudflare executes the browser and holds the ciphertext, encryption secret,
  administrator secret, and Durable Object state.
- The local machine is required only for calibration and control.
- The optional notification destination receives only sanitized status.

Anyone with Cloudflare account administration can replace Worker code or
secrets. Protect the Cloudflare account with strong MFA and least-privilege API
tokens.

## Controls

- exact reviewed HTTPS origins;
- no raw card handling;
- hidden account and ZIP prompts;
- AES-GCM bundle encryption before upload;
- no secrets in Wrangler configuration;
- administrator bearer authentication with hash-based constant-time compare;
- Durable Object lease;
- user bill ceiling;
- fee strictly under the configured ceiling, never above `$4.00`;
- full-balance and review-arithmetic verification;
- due-window gate;
- card-last-four binding;
- durable intent before final click;
- confirmed bill fingerprint;
- ambiguous-result stop and manual reconciliation;
- no CAPTCHA or authentication bypass;
- no screenshots, HTML dumps, or sensitive telemetry.

## Local control file

`.sce-pay/control.json` contains the Worker URL and administrator token. It is
created with private filesystem permissions and ignored by Git. It is not
needed for Cron execution.

If it is disclosed, rotate `ADMIN_TOKEN` with Wrangler and replace the local
file. If it is lost, the deployed Worker continues to run, but a new token is
needed for control operations.

## Token limitations

Browser storage is not guaranteed to contain a reusable payment credential.
Tokens may be short-lived, device-bound, IP-bound, or invalidated without
notice. The mandatory cloud dry run prevents initial arming when the captured
state is unusable. Later invalidation produces an attention-required stop.

The project does not reverse-engineer, mint, refresh, or replay private payment
API requests outside the browser.
