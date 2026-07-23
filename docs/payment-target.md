# Payment target contract

The entry URL is:

```text
https://www.sce.com/mysce/billsnpayments/paybills
```

The automation uses the Guest Pay path reached from this page. It does not use
the retired legacy external card portal and does not require an SCE username,
password, MFA session, or authenticated My Account profile.

Because SCE's public help pages have historically lagged the live application,
the adapter does not hard-code an external processor name. Onboarding records
the exact HTTPS origins that the user personally reviews during the current
guest flow.

Runtime rules:

1. Start at the configured SCE URL.
2. Permit only top-level origins approved during onboarding.
3. Permit embedded payment frames only from approved origins.
4. Reject popups.
5. Stop on CAPTCHA, login requests, maintenance, missing labels, missing saved
   method, changed review arithmetic, or an unknown confirmation.
6. Never learn a new origin during an unattended run.
7. Never fill raw card fields.

A payment-origin change is a new onboarding event, not an automatic allowlist
update.
