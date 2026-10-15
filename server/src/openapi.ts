import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  CreateActionBody,
  DecisionBody,
  ResultBody,
  ListActionsQuery,
  CreateKeyBody,
  ActionStatus,
  CreateWatcherBody,
  UpdateWatcherBody,
  ListWatchersQuery,
  CreateChannelBody,
  UpdateChannelBody,
} from './schemas.js';

export function buildOpenApiDocument(baseUrl = 'http://localhost:8484'): unknown {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Impri API',
      version: 'v1',
      description:
        'Human-in-the-loop approval API for AI agents. POST an action, get a decision back via webhook or polling. The imprimatur for your AI agents.',
    },
    servers: [{ url: `${baseUrl}/v1`, description: 'API v1' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'im_<key>',
        },
      },
      schemas: {
        CreateActionBody: zodToJsonSchema(CreateActionBody, { name: 'CreateActionBody' }),
        DecisionBody: zodToJsonSchema(DecisionBody, { name: 'DecisionBody' }),
        ResultBody: zodToJsonSchema(ResultBody, { name: 'ResultBody' }),
        ListActionsQuery: zodToJsonSchema(ListActionsQuery, { name: 'ListActionsQuery' }),
        CreateKeyBody: zodToJsonSchema(CreateKeyBody, { name: 'CreateKeyBody' }),
        ActionStatus: zodToJsonSchema(ActionStatus, { name: 'ActionStatus' }),
        CreateWatcherBody: zodToJsonSchema(CreateWatcherBody, { name: 'CreateWatcherBody' }),
        UpdateWatcherBody: zodToJsonSchema(UpdateWatcherBody, { name: 'UpdateWatcherBody' }),
        ListWatchersQuery: zodToJsonSchema(ListWatchersQuery, { name: 'ListWatchersQuery' }),
        CreateChannelBody: zodToJsonSchema(CreateChannelBody, { name: 'CreateChannelBody' }),
        UpdateChannelBody: zodToJsonSchema(UpdateChannelBody, { name: 'UpdateChannelBody' }),
      },
    },
    paths: {
      '/actions': {
        post: {
          operationId: 'createAction',
          summary: 'Submit an action for human approval',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateActionBody' } } },
          },
          responses: {
            201: { description: 'Action created' },
            200: { description: 'Idempotent match or soft duplicate' },
            400: { description: 'Validation error' },
            429: { description: 'Rate limit exceeded' },
          },
        },
        get: {
          operationId: 'listActions',
          summary: 'List actions with optional filters',
          parameters: [
            { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/ActionStatus' } },
            { name: 'since', in: 'query', schema: { type: 'integer' } },
            { name: 'kind', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Paginated list of actions' } },
        },
      },
      '/actions/{id}': {
        get: {
          operationId: 'getAction',
          summary: 'Get a single action by ID',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Action with decision and webhook delivery status' },
            404: { description: 'Not found' },
          },
        },
      },
      '/actions/{id}/decision': {
        post: {
          operationId: 'submitDecision',
          summary: 'Approve or reject an action',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DecisionBody' } } },
          },
          responses: {
            200: { description: 'Decision recorded' },
            409: { description: 'Already decided' },
          },
        },
      },
      '/actions/{id}/result': {
        post: {
          operationId: 'reportResult',
          summary: 'Report execution result after approval',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ResultBody' } } },
          },
          responses: {
            200: { description: 'Result recorded' },
            409: { description: 'Action not in approved state' },
          },
        },
      },
      '/keys': {
        post: {
          operationId: 'createKey',
          summary: 'Create a new API key (admin scope)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateKeyBody' } } },
          },
          responses: { 201: { description: 'Key created — key value returned once' } },
        },
        get: {
          operationId: 'listKeys',
          summary: 'List API keys (admin scope)',
          responses: { 200: { description: 'List of keys' } },
        },
      },
      '/keys/{id}': {
        delete: {
          operationId: 'revokeKey',
          summary: 'Revoke an API key (admin scope)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 204: { description: 'Revoked' }, 404: { description: 'Not found' } },
        },
      },
      '/watchers': {
        post: {
          operationId: 'createWatcher',
          summary: 'Create a watcher (watch scope)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateWatcherBody' } } },
          },
          responses: {
            201: { description: 'Watcher created' },
            400: { description: 'Validation error' },
            429: { description: 'Rate limit exceeded' },
          },
        },
        get: {
          operationId: 'listWatchers',
          summary: 'List watchers with optional filters',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'paused', 'degraded'] } },
            { name: 'kind', in: 'query', schema: { type: 'string', enum: ['rss', 'reddit_search', 'url_diff'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Paginated list of watchers' } },
        },
      },
      '/watchers/{id}': {
        get: {
          operationId: 'getWatcher',
          summary: 'Get a single watcher with item count',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Watcher' }, 404: { description: 'Not found' } },
        },
        patch: {
          operationId: 'updateWatcher',
          summary: 'Update a watcher (name/config/schedule/status)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateWatcherBody' } } },
          },
          responses: { 200: { description: 'Updated watcher' }, 404: { description: 'Not found' } },
        },
        delete: {
          operationId: 'deleteWatcher',
          summary: 'Delete a watcher and its dedup items',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 204: { description: 'Deleted' }, 404: { description: 'Not found' } },
        },
      },
      '/project': {
        get: {
          operationId: 'getProject',
          summary: 'Project info incl. webhook_secret (admin scope)',
          responses: { 200: { description: 'Project' }, 404: { description: 'Not found' } },
        },
        patch: {
          operationId: 'updateProject',
          summary: 'Update project name / timezone (admin scope)',
          responses: { 200: { description: 'Updated project' }, 400: { description: 'Invalid timezone' } },
        },
      },
      '/project/rotate-webhook-secret': {
        post: {
          operationId: 'rotateWebhookSecret',
          summary: 'Rotate the project webhook signing secret (admin scope)',
          responses: { 200: { description: 'New webhook secret' } },
        },
      },
      '/project/export': {
        get: {
          operationId: 'exportProject',
          summary: 'GDPR export of all project-scoped data (admin scope)',
          responses: { 200: { description: 'Project data dump' } },
        },
      },
      '/project/data': {
        delete: {
          operationId: 'eraseProjectData',
          summary: 'GDPR erasure — wipe content + PII, keep project & keys (admin scope)',
          responses: { 200: { description: 'Erased with counts' } },
        },
      },
      '/billing': {
        get: {
          operationId: 'getBilling',
          summary: 'Current tier, subscription status and usage (admin scope)',
          responses: { 200: { description: 'Billing state incl. usage and billing_enabled flag' } },
        },
      },
      '/billing/checkout': {
        post: {
          operationId: 'createCheckout',
          summary: 'Create a Stripe Checkout session for a plan (admin scope; billing must be enabled)',
          responses: {
            200: { description: 'Checkout URL' },
            400: { description: 'Billing disabled or plan not configured' },
          },
        },
      },
      '/billing/portal': {
        post: {
          operationId: 'createBillingPortal',
          summary: 'Create a Stripe customer portal session (admin scope)',
          responses: { 200: { description: 'Portal URL' }, 400: { description: 'No customer / billing disabled' } },
        },
      },
      '/billing/webhook': {
        post: {
          operationId: 'stripeWebhook',
          summary: 'Stripe webhook (public; verified by Stripe signature, not API key)',
          responses: { 200: { description: 'Event processed' }, 400: { description: 'Bad signature' } },
        },
      },
      '/notification-channels': {
        get: {
          operationId: 'listNotificationChannels',
          summary: 'List notification channels with masked config (admin scope)',
          responses: { 200: { description: '{ items } — each channel has `verified` (false only for an unconfirmed email channel)' } },
        },
        post: {
          operationId: 'createNotificationChannel',
          summary: 'Create a notification channel (admin scope). Email: sends a confirmation email; nothing else is delivered until the address is confirmed',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateChannelBody' } } },
          },
          responses: {
            201: { description: 'Channel created. Email channels add `verification_queued` (the confirmation email is sent right after the response) and, when false, `verification_error`' },
            400: { description: 'Invalid config, or email delivery not configured on the server' },
          },
        },
      },
      '/notification-channels/{id}': {
        get: {
          operationId: 'getNotificationChannel',
          summary: 'Get a notification channel with masked config (admin scope)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Channel' }, 404: { description: 'Not found' } },
        },
        patch: {
          operationId: 'updateNotificationChannel',
          summary: 'Update a channel; config is merged (admin scope). A new email address must be confirmed again',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateChannelBody' } } },
          },
          responses: { 200: { description: 'Updated channel. A new email address adds `verification_queued` and, when false, `verification_error`' }, 400: { description: 'Invalid config' }, 404: { description: 'Not found' } },
        },
        delete: {
          operationId: 'deleteNotificationChannel',
          summary: 'Delete a notification channel (admin scope)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 204: { description: 'Deleted' }, 404: { description: 'Not found' } },
        },
      },
      '/notification-channels/{id}/test': {
        post: {
          operationId: 'testNotificationChannel',
          summary: 'Send a test message now (admin scope; 5/min)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: '{ ok } or { ok: false, error }' },
            404: { description: 'Not found' },
            409: { description: 'Email channel whose address is not confirmed yet' },
          },
        },
      },
      '/notification-channels/{id}/resend-verification': {
        post: {
          operationId: 'resendChannelVerification',
          summary: 'Send a new confirmation email for an unconfirmed email channel (admin scope)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: '{ ok: true, channel }' },
            400: { description: 'Not an email channel, or email delivery not configured' },
            404: { description: 'Not found' },
            409: { description: 'Address already confirmed' },
            429: { description: 'Limit reached: 10 min per channel, 3 per address / 5 per project per 24 h' },
            502: { description: 'The email could not be sent' },
          },
        },
      },
      '/notification-channels/verify': {
        get: {
          operationId: 'channelVerificationPage',
          summary: 'Confirmation page linked from the email (public; shows a button, never confirms on GET)',
          security: [],
          parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'HTML page with a confirm button' },
            404: { description: 'HTML: invalid or already used link' },
            410: { description: 'HTML: expired link (7 days)' },
          },
        },
        post: {
          operationId: 'confirmChannelVerification',
          summary: 'Confirm the email address (public; form field or JSON `token`; single use)',
          security: [],
          responses: {
            200: { description: 'HTML: confirmed' },
            404: { description: 'HTML: invalid or already used link' },
            410: { description: 'HTML: expired link (7 days)' },
          },
        },
      },
      '/push/vapid-public-key': {
        get: {
          operationId: 'getVapidPublicKey',
          summary: 'VAPID public key for browser push subscription (public)',
          responses: { 200: { description: '{ enabled, public_key }' } },
        },
      },
      '/push/subscribe': {
        post: {
          operationId: 'pushSubscribe',
          summary: 'Register a browser push subscription (actions scope)',
          responses: { 201: { description: 'Subscribed' }, 400: { description: 'Push disabled / invalid' } },
        },
        delete: {
          operationId: 'pushUnsubscribe',
          summary: 'Remove a browser push subscription (actions scope)',
          responses: { 204: { description: 'Removed' } },
        },
      },
    },
  };
}
