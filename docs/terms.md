# Terms of Service

_Last updated: 2026-07-12_

Plain-language terms for the hosted Impri cloud (`app.impri.dev` / `api.impri.dev`). The self-hosted server is separate — it is licensed under the [MIT License](https://gitlab.com/sekera.radim/impri/-/blob/main/LICENSE) and these terms do not apply to it. Impri is an early-stage product; this is a starting-point agreement, not exhaustive legal boilerplate.

## 1. Acceptance

By creating a project or using the hosted service, you agree to these terms. If you don't agree, don't use the hosted service (self-hosting is always an option).

## 2. The service

Impri is a human-in-the-loop approval gate for AI agents: an agent proposes an action, a human approves or rejects it, and the agent executes only after approval. The hosted service provides this as a managed instance.

## 3. Beta status — provided "as is"

The hosted service is in **early beta**. It is provided **as is**, without warranties of any kind. We do our best to keep it available and correct, but we do not guarantee uptime, and there is no SLA during beta. For anything critical, self-host — you keep full control and your data stays on your infrastructure.

## 4. Your account and API keys

- A project is identified by an **API key** — there is no email or password. **The key is your only credential; keep it secret.**
- You are responsible for all activity under your keys and for the content your agents push.
- We recommend creating a **second key as a backup** and storing keys in a password manager. Losing all of your keys for an anonymous project may mean the project cannot be recovered (see [Privacy](privacy.md) and [GDPR](gdpr.md)).

## 5. Acceptable use

Don't use the service to store or transmit illegal content, to abuse or overload the infrastructure, or to attempt to break project isolation or security. We may suspend or terminate accounts that do.

## 6. Approvals are your decision

Impri holds a proposed action until a human approves it, then hands the decision back to your agent. **Once you approve an action, the action and its consequences are yours.** Impri is a tool that surfaces and gates decisions; it does not make them for you and is not responsible for what an approved action does.

## 7. Billing

Paid tiers are processed by **Stripe**. You can cancel at any time; access continues until the end of the current billing period. Card data is handled by Stripe and never stored by us.

## 8. Limitation of liability

To the maximum extent permitted by law, Impri and its operator are not liable for any indirect, incidental, or consequential damages, or for loss of data, revenue, or profits. Total liability for any claim is limited to the fees you paid for the service in the three months before the claim.

## 9. Termination

You can stop using the service at any time and erase your data (`DELETE /v1/project/data`). We may suspend or terminate access for violations of these terms or to protect the service.

## 10. Changes

We may update these terms; material changes will be reflected here with a new date. Continued use after a change means you accept it.

## 11. Governing law

These terms are governed by the laws of the Czech Republic, where the operator is based.

## 12. Contact

Questions about these terms: [sekera.dev](https://sekera.dev).
