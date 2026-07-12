# Privacy Policy

_Last updated: 2026-07-12_

Impri is built to be privacy-friendly by default: **self-hosting sends no telemetry and nothing phones home**, and the hosted cloud collects no account email, no password, and runs no analytics or tracking. This policy explains what the hosted cloud (`app.impri.dev` / `api.impri.dev`) does with data. If you self-host, you are the data controller and this policy is for reference only.

## Who we are

The data controller for the hosted cloud is **Radim Sekera**. Contact: [sekera.dev](https://sekera.dev). Data is stored in the EU (Fly.io, Frankfurt).

## What we collect and why

| Data | Why | Erasable |
|------|-----|----------|
| Project name (optional, you provide it) | Label your project | Preserved with the account |
| Content you send — action titles, previews, payloads, and your decisions | To provide the approval service (the core function) | Yes |
| Notification channel config — e.g. Slack/Discord/Telegram bot tokens, channel IDs | To deliver approvals to your chat | Yes (masked in API responses, never logged) |
| Request IP addresses | Security and abuse prevention | Yes (stored in a separate `pii_log`, erased on request) |
| API key hashes (argon2) and prefixes | Authentication | Preserved for account continuity |
| Stripe customer / subscription IDs | Billing | Preserved while the account exists |

We only ever receive the content your agents choose to push. We do not scan, sell, or share it.

## What we do **not** collect

- **No email or password** at sign-up (a project is created anonymously and identified by an API key).
- **No analytics, tracking pixels, or telemetry.** The self-hosted server makes no outbound calls home.
- **No card data.** Payments are processed by Stripe; card numbers never touch our servers — we store only Stripe's customer and subscription identifiers.

## Cookies and local storage

The web app stores your API key in the browser's **localStorage** so you stay signed in. This is functional, not tracking, and never leaves your browser except as the `Authorization` header on API calls. We set no third-party or advertising cookies.

## Subprocessors

The hosted cloud relies on:

- **Fly.io** — application hosting (EU, Frankfurt)
- **Tigris** — encrypted off-site database backups (continuous replication)
- **Cloudflare** — static delivery of the web app and marketing site (Pages)
- **Stripe** — payment processing

## Retention

Your content is kept until you erase it (`DELETE /v1/project/data`) or the account is deleted. Audit rows are kept indefinitely by default; operators can enable automatic purging after N days. See [GDPR & Data Management](gdpr.md) for the export and erasure endpoints.

## Your rights

You can access, export, rectify, or erase your data at any time using the self-service `GET /v1/project/export` and `DELETE /v1/project/data` endpoints, or by contacting us at [sekera.dev](https://sekera.dev). We aim to respond within 30 days.

## Changes

Material changes to this policy will be reflected here with an updated date.

## Contact

Questions about privacy or your data: [sekera.dev](https://sekera.dev).
