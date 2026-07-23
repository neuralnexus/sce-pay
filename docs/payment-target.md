# Payment target contract

The only supported top-level application is:

```text
origin: https://www.sce.com
path:   /mysce/billsnpayments/paybills
```

Query strings and child paths under that application are allowed. Other SCE
paths and all external top-level portals are rejected. The automation uses
Guest Pay with account number and mailing ZIP; it does not require an SCE
username, password, MFA session, or authenticated My Account profile.

SCE's public help content has historically lagged its live application. An
external processor name is therefore not a code contract or fallback.

## Calibration contract

Onboarding records:

- the single SCE top-level origin;
- external frame origins visible in the reviewed payment UI; and
- every HTTPS request origin used by the reviewed flow.

The runtime restores exactly that contract before navigation. Requests to new
origins are aborted; new frame origins, WebSockets, popups, dialogs, downloads,
and top-level routes stop the run. It never learns an origin while unattended.

## Semantic contract

The adapter uses accessible roles and labels rather than CSS class names, but
does not accept ambiguity. It requires:

- a recognizable Guest Pay account/ZIP flow;
- current amount due and due date;
- full-balance/card selection;
- one displayed card ending;
- labeled payment amount, fee, and total;
- one enabled final-payment action; and
- success text plus a confirmation/reference/receipt identifier.

Before the durable intent and again immediately before the final click, the
review must match. No raw card field is ever filled by the unattended adapter.

A target or origin change is a new human-reviewed onboarding event.
