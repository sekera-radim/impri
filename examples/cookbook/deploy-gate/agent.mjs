#!/usr/bin/env node
// deploy-gate.mjs — Impri cookbook recipe #3
// No dependencies. Node 18+.
//
// Pattern: a CI/CD or release agent proposes a production deployment.
// A human reviews the diff summary and approves before anything is deployed.
//
// Run:
//   IMPRI_API_KEY=im_xxx node agent.mjs
//   IMPRI_API_KEY=im_xxx IMPRI_BASE_URL=https://api.impri.dev node agent.mjs
//
// Optional env (to simulate reading from CI):
//   GIT_SHA=abc1234  GIT_BRANCH=main  DEPLOY_ENV=production
//
// Required scope: actions

const API_KEY = process.env.IMPRI_API_KEY;
const BASE = (process.env.IMPRI_BASE_URL ?? 'http://localhost:8484').replace(/\/+$/, '');

if (!API_KEY) {
  console.error('Set IMPRI_API_KEY (it starts with im_).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal API helper
// ---------------------------------------------------------------------------
async function api(path, method = 'GET', body) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} /v1${path} → ${res.status}: ${json.message ?? json.error ?? JSON.stringify(json)}`);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Simulate reading deploy metadata from environment / CI context.
// In production: read from process.env, your CI API, or a build manifest.
// ---------------------------------------------------------------------------
const deploy = {
  env: process.env.DEPLOY_ENV ?? 'production',
  service: 'api-server',
  sha: process.env.GIT_SHA ?? 'a3f8c91',
  branch: process.env.GIT_BRANCH ?? 'main',
  imageTag: `ghcr.io/yourorg/api-server:${process.env.GIT_SHA?.slice(0, 7) ?? 'a3f8c91'}`,
  compareUrl: `https://github.com/yourorg/api-server/compare/v2.3.1...${process.env.GIT_SHA ?? 'a3f8c91'}`,
  changesMarkdown:
    '- Fix: null pointer in payment webhook handler (#412)\n' +
    '- Feat: add `/v1/exports` endpoint for GDPR dump (#409)\n' +
    '- Chore: bump fastify 4.26 → 4.27 (CVE-2024-12345 patched)',
};

// ---------------------------------------------------------------------------
// Build the human-readable deploy summary for the inbox card.
// ---------------------------------------------------------------------------
function buildPreview(d) {
  return (
    `## Deploy to **${d.env}** — ${d.service}\n\n` +
    `**Image:** \`${d.imageTag}\`\n` +
    `**Branch:** ${d.branch} @ \`${d.sha}\`\n\n` +
    `### Changes\n${d.changesMarkdown}\n\n` +
    `[Full diff ↗](${d.compareUrl})`
  );
}

// ---------------------------------------------------------------------------
// Stub: replace with your actual deploy command.
// ---------------------------------------------------------------------------
async function runDeploy(d) {
  console.log(`   [stub] kubectl set image deployment/${d.service} ${d.service}=${d.imageTag}`);
  // In production:
  //   const result = await k8sClient.appsV1.patchNamespacedDeployment(...)
  //   return result.body.status;
  return { rollout: 'success', pods: 3 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nImpri deploy-gate → ${BASE}`);
  console.log(`  Service: ${deploy.service} → ${deploy.env}`);
  console.log(`  SHA: ${deploy.sha}\n`);

  // 1. Gate the deploy on human approval.
  //    idempotency_key = sha so multiple CI retries don't spam the inbox.
  //    target_url = diff link so the reviewer can inspect code changes.
  const action = await api('/actions', 'POST', {
    kind: `deploy.${deploy.env}`,
    title: `Deploy ${deploy.service} → ${deploy.env} (${deploy.sha.slice(0, 7)})`,
    preview: {
      format: 'markdown',
      body: buildPreview(deploy),
    },
    target_url: deploy.compareUrl,
    payload: {
      service: deploy.service,
      env: deploy.env,
      sha: deploy.sha,
      image: deploy.imageTag,
    },
    idempotency_key: `deploy-${deploy.service}-${deploy.sha}`,
    expires_in: 7200, // 2 h — stale deploys should not be approved hours later
  });

  console.log(`  Created action ${action.id} (status: ${action.status})`);
  console.log(`  Open your inbox to approve/reject: ${action.inbox_url ?? BASE.replace(':8484', ':8080')}\n`);

  // 2. Poll for decision.
  let current = action;
  while (current.status === 'pending') {
    await sleep(3000);
    current = await api(`/actions/${action.id}`);
    process.stdout.write(`  Waiting for approval... (${current.status})\r`);
  }
  console.log(`\n  Decision: ${current.status.toUpperCase()}`);

  if (current.status !== 'approved') {
    console.log('  Not approved — deploy was blocked. Nothing was deployed.');
    // In CI, exit with non-zero to fail the pipeline step.
    process.exit(1);
  }

  // 3. Run the deploy.
  try {
    const result = await runDeploy(deploy);
    await api(`/actions/${action.id}/result`, 'POST', {
      status: 'executed',
      detail: JSON.stringify(result),
    });
    console.log('  OK — deployed and reported to Impri.');
    console.log('  Result:', JSON.stringify(result));
  } catch (err) {
    await api(`/actions/${action.id}/result`, 'POST', {
      status: 'execute_failed',
      detail: String(err),
    });
    console.error('  Approved but deploy failed → execute_failed.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nAgent error:', e.message);
  process.exit(1);
});
