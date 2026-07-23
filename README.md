# SCE Pay

`sce-pay` pays the entire current Southern California Edison bill through SCE
Guest Pay from a Cloudflare Worker. After one guided setup, Cloudflare Cron and
Browser Run perform the monthly payment check; your computer can be off.

This project exists because SCE accepts cards but does not offer card Auto Pay.
It is independent of and not endorsed by Southern California Edison or
Cloudflare.

> **Early release:** SCE does not provide a public card-payment API for this
> project. The browser adapter must fail closed when SCE changes the guest flow,
> rejects a cloud browser, requests a CAPTCHA, or invalidates the tokenized
> payment state. You remain responsible for confirming bills and payments.

## The short version

```bash
git clone https://github.com/neuralnexus/sce-pay.git
cd sce-pay
npm ci
npx wrangler login
npm run setup
```

The setup wizard:

1. Opens SCE Guest Pay in Chrome.
2. Asks you to reach the final payment review without submitting.
3. Captures tokenized browser state and the exact HTTPS origins you approve.
4. Asks for the SCE account number, mailing ZIP, card last four, bill ceiling,
   and due-window policy.
5. Encrypts that bundle locally and deploys a disarmed Cloudflare Worker.
6. Runs a real Cloudflare Browser Run dry run.
7. Arms the daily Cron only if the cloud dry run reaches a valid review.

Card number, expiration, and security code are entered only into SCE's page.
`sce-pay` does not read, prompt for, persist, or log raw card fields.

## What runs in Cloudflare

- A Worker receives Cron and authenticated control requests.
- Browser Run executes the current SCE Guest Pay flow with Cloudflare's
  Playwright runtime.
- A single Durable Object serializes every run and stores payment intents.
- The onboarding bundle is AES-256-GCM encrypted before upload. The Durable
  Object stores ciphertext; the encryption key is a Worker secret.
- Cron checks once daily. Idempotency permits at most one confirmed payment for
  an exact account, due date, and amount.

Cloudflare currently documents Browser Run on Free and Paid Workers plans. The
Free plan includes ten browser minutes per day, which is normally enough for
this single low-frequency workflow. Review Cloudflare's current
[Browser Run limits](https://developers.cloudflare.com/browser-run/limits/) and
[pricing](https://developers.cloudflare.com/browser-run/pricing/) for your
account.

## Payment policy

Every real submission requires all of these checks to pass:

- the bill is the entire current amount due;
- the amount is at or below the user-authorized bill ceiling;
- the bill is inside the configured due window;
- the review still shows the authorized card's last four digits;
- the convenience fee is **strictly less than $4.00**;
- `bill amount + fee = displayed total`;
- the top-level and embedded payment origins exactly match the origins approved
  during onboarding;
- no prior confirmed payment exists for that exact bill cycle; and
- no earlier submission has an unresolved result.

The `$1.65` exact-fee assumption has been removed.

Immediately before the final click, the Durable Object writes a `submitting`
intent. If SCE does not return a recognizable confirmation, that intent becomes
`unknown` and every later run stops. There is no blind retry.

## Operations

The wizard creates `.sce-pay/control.json` with a private administrator token.
That local file is only for status and manual control; deleting it or turning
off the computer does not stop the deployed Cron.

```bash
# Sanitized status
npm run sce-pay -- status

# Cloud dry run; never submits
npm run sce-pay -- dry-run

# Temporarily disable or re-enable submission
npm run sce-pay -- disarm
npm run sce-pay -- arm

# Deliberate manual real run
npm run sce-pay -- run --yes
```

After checking SCE and the card account, reconcile an uncertain intent:

```bash
npm run sce-pay -- reconcile INTENT_ID paid "Verified in SCE payment history"
npm run sce-pay -- reconcile INTENT_ID not-paid "Verified absent from SCE and card activity"
```

Re-running `npm run setup` replaces the encrypted guest bundle and starts
disarmed until a new cloud dry run succeeds. Use that when SCE changes the flow
or the tokenized payment method expires.

## Notifications

The wizard optionally accepts an HTTPS webhook. The Worker sends a small JSON
success or attention-required event after each eligible run. It never includes
the SCE account number, mailing ZIP, card token, card last four, bill amount, or
confirmation number.

## Development

```bash
npm run check
npm run build
npx wrangler deploy --dry-run
npm audit --omit=dev
```

The deterministic suite covers the strict sub-$4 fee rule, bill ceiling and due
window, review arithmetic, exact-origin restrictions, encryption, duplicate
suppression, dry runs, and uncertain-submission blocking.

Read [Architecture](docs/architecture.md),
[Onboarding](docs/onboarding.md), [Payment target](docs/payment-target.md), and
[Security](docs/security.md) before changing the browser or submission boundary.

## Current limitations

- A token available at guest review may expire or may not be reusable from
  Cloudflare. The mandatory cloud dry run proves the captured state before the
  Worker can be armed, but it cannot guarantee that SCE will keep it valid.
- SCE may block Browser Run by IP reputation or bot defenses. The project does
  not bypass CAPTCHA, MFA, access controls, or other challenges.
- A browser adapter is less stable than a supported payment API. Changed
  labels, origins, amount semantics, or confirmation behavior stop the run.
- The 17:00 UTC Cron is 9 a.m. Pacific Standard Time and 10 a.m. Pacific
  Daylight Time. It evaluates the due window rather than assuming a fixed bill
  day.
- This tool does not guarantee timely payment. Check SCE after onboarding and
  periodically thereafter.
- Users are responsible for confirming that their use complies with SCE,
  Cloudflare, their card issuer, and applicable terms.
