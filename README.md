# SCE Pay

`sce-pay` is a local, fail-closed browser agent for the annoying gap in Southern
California Edison's payment options: SCE accepts credit cards, but its Auto Pay
feature only supports a checking account.

The agent checks the current bill once a day and, when explicitly armed, pays
the **entire current amount due** with a card available in SCE's current
payment experience. It does not ask for, store, or type an SCE password, card
number, CVV, MFA code, or CAPTCHA response.

> **Project status:** early and deliberately conservative. SCE can change its
> pages without notice. Always complete a headed dry run after setup or an SCE
> page change. This project is independent of and not endorsed by Southern
> California Edison.

## What is automated

The default run:

1. Opens a dedicated local Chrome profile.
2. Reads the current amount due and due date.
3. Stops if the account, amount, due date, destination host, or saved card
   cannot be verified.
4. Waits until the bill is within the configured payment window (21 days by
   default).
5. Opens **Pay by Card**, verifies the saved card's last four digits, and moves
   to the review page.
6. Verifies `payment amount + exact convenience fee = total`.
7. Writes a durable payment intent immediately before activating the final
   submission control.
8. Captures the confirmation number and suppresses duplicate payment attempts.

A new residential configuration starts with a **$1.65 expected fee**. That is
only a safety constraint, not a trusted fact: the live SCE review page is
authoritative. If the displayed fee differs, the agent stops until the user
reviews and explicitly re-authorizes the new exact amount.

Official references:

- [Current SCE payment route](https://www.sce.com/mysce/billsnpayments/paybills)
- [SCE electronic payment options](https://www.sce.com/factsheet/paymentoptions)
- [SCE website terms of use](https://www.sce.com/terms-conditions/website-terms-of-use)

## Safety model

- **Local only.** The browser profile, configuration, state, and audit log live
  on the user's machine with private filesystem permissions.
- **Saved method only.** Raw card fields are never filled. The authorized last
  four digits must be visible on the payment and review pages.
- **Explicit limits.** The user authorizes a maximum bill, exact fee, card last
  four, and optionally a visible account label.
- **No blind retries.** If the final control may have been activated but a
  confirmation was not observed, the intent becomes `unknown`. Every future
  payment run stops until the user checks SCE payment history and reconciles it.
- **Bill-cycle idempotency.** A hash of the account reference, due date, and
  full amount prevents a confirmed bill from being paid twice.
- **Current SCE route only.** Until final submission, the top-level page must
  remain under `https://www.sce.com/mysce/billsnpayments/paybills`. Any
  external redirect or unrelated SCE route stops the run and requires a
  reviewed adapter update.
- **No challenge bypass.** Expired login sessions, MFA, CAPTCHA, maintenance,
  changed labels, missing values, or mismatched arithmetic all require attention.
- **Low frequency.** The scheduler checks once daily, with no scraping loop or
  parallel traffic.

See [Security and threat model](docs/security.md) for the detailed boundaries.

## Requirements

- Node.js 22 or newer
- Google Chrome, Microsoft Edge, or Playwright Chromium
- macOS or Linux for built-in scheduler installation
- An eligible SCE account with online card payments

The default browser channel is `chrome`. If Chrome is not installed, edit
`browser.channel` to `msedge`, or run `npx playwright install chromium` and set
it to `chromium`.

## Install

```bash
git clone https://github.com/neuralnexus/sce-pay.git
cd sce-pay
npm ci
npm run build
npm link
```

## Set up

Create a disabled configuration:

```bash
sce-pay init
```

Open the dedicated browser profile:

```bash
sce-pay login
```

In that browser window:

1. Sign in to SCE yourself.
2. Open **Make a Payment → Pay by Card**.
3. Add or select the desired card directly in the SCE UI.
4. Stop before submitting a real payment.
5. Return to the terminal and press Enter.

Authorize a residential account with a $750 bill ceiling, a $1.65 exact fee,
and card ending 4242:

```bash
sce-pay arm --last4 4242 --max 750.00 --fee 1.65
```

If multiple accounts are present, bind the run to text visibly identifying the
intended one:

```bash
sce-pay arm --last4 4242 --max 750.00 --fee 1.65 --account "Primary home"
```

Run a visible end-to-end check. It selects the saved method and validates the
review, but never activates the final payment control:

```bash
sce-pay run --dry-run --headed
```

Only after that succeeds, install the daily 9:00 a.m. user-level schedule:

```bash
sce-pay schedule install
```

The timer is persistent. If the computer is asleep at 9:00 a.m., the operating
system runs the missed check after the user session resumes.

## Operations

```bash
# Inspect local state; does not open SCE
sce-pay status

# Show a real browser during a manual run
sce-pay run --headed

# Disable submission immediately
sce-pay disarm

# Remove the scheduled task
sce-pay schedule remove
```

If a final submission has an ambiguous result, first check SCE's payment
history. Then resolve the exact intent shown by `sce-pay status`:

```bash
sce-pay reconcile INTENT_ID \
  --as paid \
  --confirmation CONFIRMATION_NUMBER \
  --note "Verified in SCE payment history"
```

Or, only after verifying that no payment posted:

```bash
sce-pay reconcile INTENT_ID \
  --as not-paid \
  --note "No payment in SCE history or card activity"
```

The next scheduled run may retry a reconciled `not-paid` bill. A reconciled
`paid` bill remains duplicate-protected.

## Configuration and local data

Set `SCE_PAY_HOME` to override the platform-specific application directory.
Otherwise:

- macOS: `~/Library/Application Support/sce-pay`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/sce-pay`
- Windows: `%APPDATA%\sce-pay` (manual scheduling only)

Important files:

- `config.json` — authorization limits and non-secret settings
- `state.json` — runs, durable intents, and confirmations
- `audit.jsonl` — append-only operational events with long numbers redacted
- `browser-profile/` — the local SCE browser session

Back up or sync these files only to a location you trust. Never commit them.

Useful configuration fields:

| Field | Default | Meaning |
|---|---:|---|
| `automation.maxBillCents` | `75000` | Maximum bill amount, excluding the accepted fee |
| `automation.expectedFeeCents` | `165` | Exact allowed convenience fee |
| `automation.payWhenDueWithinDays` | `21` | Earliest point at which a bill can be paid |
| `automation.accountLabel` | `null` | Optional visible text binding a specific SCE account |
| `browser.channel` | `chrome` | `chrome`, `msedge`, or installed `chromium` |
| `allowedHosts` | Current SCE route only | HTTPS destinations accepted during the flow |

## Development

```bash
npm run check
npm test
npm run test:coverage
npm run build
npm pack --dry-run
```

Tests cover amount parsing, host restrictions, due dates, scheduler definitions,
state transitions, duplicate suppression, amount and fee stops, pre-submission
failures, post-submission ambiguity, and mandatory reconciliation.

Read [Architecture](docs/architecture.md) before modifying the submission
boundary or portal selectors.

## Important limitations

- Browser automation cannot make a third-party payment page as stable as a
  supported SCE API. There is no public SCE card-autopay API used here.
- The first release targets the current residential card flow and exact flat
  fee. Commercial percentage fees require a separate reviewed policy.
- A persisted web session can expire at any time. `sce-pay login` is the
  supported recovery path.
- The tool does not guarantee timely payment. The customer remains responsible
  for checking their bill, payment status, card availability, and due date.
- Users are responsible for confirming that their use complies with SCE, card-issuer, and applicable terms. The implementation intentionally
  avoids high-frequency access and prohibited challenge bypass.
