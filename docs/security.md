# Security and threat model

## Protected assets

- SCE authenticated session
- Saved payment-method authorization
- SCE account identity and bill data
- Payment intent and confirmation history
- The user's ability to prevent duplicate or excessive charges

## Trust boundaries

The user manually enters all credentials, MFA, CAPTCHA responses, and raw card
data directly into SCE or JP Morgan Chase pages. `sce-pay` controls a dedicated
local browser profile after that manual setup. SCE and Chase remain the payment
systems of record.

The project does not operate a server, receive payment credentials, proxy
traffic, or send telemetry. Desktop notifications contain only a short status
message.

## Controls

| Threat | Control |
|---|---|
| Repository or log leaks a card | Raw card fields are never accepted or filled; local data is ignored by Git and created with private permissions |
| Wrong saved card | Last four must match on selection and review pages |
| Wrong SCE account | Optional visible account label plus hashed account reference |
| Unexpected large bill | Explicit `maxBillCents`; full amount must remain identical across inspection and review |
| Changed or hidden fee | Exact fee equality and independent total arithmetic |
| Duplicate charge | Durable bill fingerprint and confirmed-intent suppression |
| Crash after final click | Pre-click intent, `unknown` status, global retry block, manual reconciliation |
| Redirect or phishing page | HTTPS plus explicit host allowlist |
| UI drift causes wrong click | Named semantic controls, review validation, and fail-closed missing/ambiguous selectors |
| Concurrent scheduler/manual run | Exclusive local process lock |
| Expired session or anti-bot challenge | Manual reauthentication; no CAPTCHA/MFA bypass |
| Excessive automated traffic | One daily run, one browser context, no parallel scraping |

## Data handling

The browser profile is the most sensitive local artifact because it may contain
authenticated cookies and payment-portal state. Protect the operating-system
account with disk encryption and a screen lock. Do not put `SCE_PAY_HOME` in a
shared folder or cloud-synced directory.

State stores the saved card's last four digits, bill and fee amounts, due date,
hashed account reference, and confirmation number. Audit events redact long
numeric sequences and do not include DOM snapshots or screenshots.

No screenshot is captured by default. This is intentional: billing pages can
display names, addresses, account numbers, usage data, and payment details.

## Recovery

For `AUTH_REQUIRED` or `CAPTCHA_REQUIRED`, run `sce-pay login` and handle the
request manually.

For `PAYMENT_UNCERTAIN`:

1. Do not rerun or delete state.
2. Check SCE payment history.
3. Check pending/posted card activity if SCE is inconclusive.
4. Reconcile the exact intent as `paid` or `not-paid`, recording how it was
   verified.

For an unexpected host, do not broadly add `*` or a parent domain. Verify the
destination through SCE's documented flow and add only the exact hostname.

## Non-goals

- Storing or tokenizing cards
- Password-manager integration
- CAPTCHA, MFA, rate-limit, or fraud-control bypass
- Reverse engineering private payment APIs
- Commercial percentage-fee support in the initial policy
- Guaranteeing payment completion or replacing the user's responsibility to
  monitor utility service and statements
