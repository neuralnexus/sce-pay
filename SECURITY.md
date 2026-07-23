# Security policy

## Reporting

Do not open a public issue for a vulnerability that could expose an SCE account,
payment instrument, browser token, administrator token, confirmation, or payment
workflow bypass. Use GitHub's private vulnerability-reporting feature for this
repository.

Include the affected commit, a minimal reproduction without real account or card
data, impact, and any known mitigation. Do not perform a real payment while
testing a report.

## Supported version

Only the latest commit on the default branch is supported after its release has
passed the documented cloud dry-run and arming gate. Deploying a new Worker
version automatically invalidates the prior arm state.

## Secrets

Never attach `.sce-pay/`, browser state, screenshots, traces, HTML, account
numbers, ZIP codes, card data, Worker secrets, or webhook URLs to an issue or
pull request. Rotate `ADMIN_TOKEN` and rerun onboarding if local control data may
have been exposed.
