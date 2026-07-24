# Contributing

Changes to the browser or payment boundary must preserve the fail-closed model:

- no raw card data, passwords, CAPTCHA solving, or access-control bypasses;
- exact SCE top-level route and reviewed network-origin enforcement;
- a durable intent before the one final-payment action;
- no automatic retry after an ambiguous result;
- full-balance, bill-ceiling, fee, method, freshness, and arithmetic checks; and
- a cloud dry run for the exact configuration and Worker release before arming.

Run the complete local gate:

```bash
npm ci
npm run validate
```

Tests must not use a real SCE account or payment instrument. Fixtures must be
synthetic and must not contain captured portal HTML, screenshots, tokens, or
network traces.
