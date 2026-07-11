# Recipe 3 — Deploy Gate

A CI/CD agent proposes a production deployment, shows the reviewer a summary
of what will change, and only deploys after human approval.

## Why this matters

Fully autonomous deploys to production are dangerous. A deploy gate ensures
a human sees the diff summary and explicitly OKs each release — without
slowing down the pipeline for low-risk changes (auto-approve those in your CI).

## How it works

```
CI pipeline builds + pushes image
    → agent collects: image tag, git SHA, branch, change summary
    → POST /v1/actions  (kind: deploy.production, target_url = diff URL)
    → reviewer sees changes in inbox, clicks diff link for details
    → agent polls GET /v1/actions/:id
    → if approved: kubectl set image ... (or equivalent)
    → POST /v1/actions/:id/result
    → CI step exits 0 (success) or 1 (rejected/failed)
```

## Requirements

- Node 18+ (no npm install)
- Impri API key with `actions` scope
- Running Impri instance

## Quick start

```bash
# Simulate a deploy
IMPRI_API_KEY=im_your_key node agent.mjs

# With real CI context
IMPRI_API_KEY=im_your_key \
  GIT_SHA=a3f8c91d \
  GIT_BRANCH=main \
  DEPLOY_ENV=production \
  node agent.mjs
```

## Integrating into a GitHub Actions / GitLab CI pipeline

```yaml
# .github/workflows/deploy.yml (GitHub Actions)
- name: Gate production deploy
  env:
    IMPRI_API_KEY: ${{ secrets.IMPRI_API_KEY }}
    GIT_SHA: ${{ github.sha }}
    GIT_BRANCH: ${{ github.ref_name }}
    DEPLOY_ENV: production
  run: node deploy-gate/agent.mjs
  # The step fails the pipeline if the reviewer rejects or the action expires
```

## Idempotency and retries

`idempotency_key: "deploy-api-server-<sha>"` means a flaky pipeline that
retries the step will not create duplicate inbox cards. The reviewer sees
exactly one card per SHA.

## Auto-approving safe deploys

You can skip the gate for non-production environments by checking the env:

```js
if (deploy.env !== 'production') {
  // Non-production: deploy without a gate
  await runDeploy(deploy);
  process.exit(0);
}
// Production: gate via Impri
```
