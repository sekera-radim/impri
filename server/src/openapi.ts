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
    },
  };
}
