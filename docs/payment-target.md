# Payment target contract

As of July 2026, `sce-pay` targets SCE's own authenticated payment route:

```text
https://www.sce.com/mysce/billsnpayments/paybills
```

The former external card portal is not an accepted target and no external
processor domains are allowlisted by default.

## Runtime rules

1. Start at the exact HTTPS URL above.
2. Permit query strings, fragments, and subroutes under that payment path.
3. Require the top-level page to remain on `www.sce.com` through review and
   immediately before the final payment action.
4. Stop on popups, external redirects, unrelated SCE routes, login challenges,
   CAPTCHA, missing labels, ambiguous controls, or changed payment arithmetic.
5. Never learn or persist a new host from a redirect. A target change is a code
   change and must be reviewed.

Raw card fields remain outside the automation boundary. The user enters or
updates card data directly in SCE's interface; the automated run selects only a
previously available method whose last four digits match the authorization.

## Verification after an SCE change

Run:

```bash
sce-pay login
sce-pay run --dry-run --headed
```

Confirm that the browser remains on the SCE payment route, the intended account
and saved card are visible, the full amount due is unchanged on review, and the
fee plus amount equals the displayed total. A dry run never activates the final
payment control.
