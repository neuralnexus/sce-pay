# Operations runbook

## Normal state

```bash
npm run sce-pay -- status
```

Healthy production state has:

- `configured: true`;
- `armed: true`;
- no `blockingIntent`;
- a current `releaseId`;
- a recent successful run or an expected `nextCheckAt`; and
- `armBlockReason` absent.

`GET /health` proves only Worker liveness. Authenticated `GET /api/ready`
returns 200 only for an armed, unblocked current release.

## Disable and re-enable

```bash
npm run sce-pay -- disarm
npm run sce-pay -- arm
```

`arm` first runs the complete cloud dry run. The API refuses to arm an old
attestation, a different configuration, or a different Worker release.

## Unknown payment

Do not rerun. The Durable Object already blocks automation.

1. Check SCE payment history.
2. Check the card issuer for a pending or posted charge.
3. Compare timing and amount independently; do not rely on a notification.
4. Reconcile only after the result is conclusive:

```bash
npm run sce-pay -- reconcile INTENT_ID paid "Verified in SCE and issuer history"
npm run sce-pay -- reconcile INTENT_ID not-paid "Verified absent in SCE and issuer history"
```

`paid` creates the confirmed fingerprint. `not-paid` clears the blocker so a
later, newly inspected run can submit.

## Site or token change

`SITE_CHANGED`, `CONFIGURATION_REQUIRED`, `CAPTCHA_REQUIRED`, or
`AUTHENTICATION_REQUIRED` never widens the adapter. Open the current flow
yourself and rerun:

```bash
npm run setup
```

Review the complete new origin set. Do not add legacy provider domains as
fallbacks.

## Release change

Any deployment changes Worker version metadata and reports:

```text
armed: false
armBlockReason: release-changed
```

Run `npm run sce-pay -- arm` to cloud-dry-run and authorize the new release.

## Lost or exposed control file

Losing `.sce-pay/control.json` does not stop Cron. Re-running setup rotates the
administrator token and encryption key, deploys a new disarmed release, and
creates a new control file.

If an unresolved payment exists, configuration replacement is rejected. The
wizard saves the new control token immediately after deployment, so it remains
available to inspect and reconcile the Durable Object before retrying setup.

## Notification verification

Reject duplicate event IDs and stale timestamps. Compute:

```text
BASE64URL(HMAC_SHA256(secret, X-SCE-Pay-Timestamp + "." + raw_request_body))
```

and compare it in constant time to the value after `v1=` in
`X-SCE-Pay-Signature`.
