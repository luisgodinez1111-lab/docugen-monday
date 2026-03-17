'use strict';

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'DocuGen Monday API',
    version: require('../../package.json').version,
    description: 'Document generation and e-signature platform integrated with Monday.com',
    contact: { name: 'DocuGen Support' },
  },
  servers: [
    { url: process.env.APP_URL || 'http://localhost:3000', description: 'Current server' },
  ],
  components: {
    securitySchemes: {
      accountId: {
        type: 'apiKey',
        in: 'header',
        name: 'x-account-id',
        description: 'Monday.com account ID',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          pages: { type: 'integer' },
        },
      },
      Document: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          account_id: { type: 'string' },
          filename: { type: 'string' },
          template_name: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          deleted_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      Template: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          size: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  security: [{ accountId: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        security: [],
        responses: {
          '200': {
            description: 'Service healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok', 'degraded', 'down'] },
                    version: { type: 'string' },
                    uptime: { type: 'number' },
                    responseTimeMs: { type: 'number' },
                    checks: { type: 'object' },
                  },
                },
              },
            },
          },
          '503': { description: 'Service down' },
        },
      },
    },
    '/auth/check': {
      get: {
        tags: ['OAuth'],
        summary: 'Check if account has an active OAuth session',
        parameters: [
          { name: 'x-account-id', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Auth status', content: { 'application/json': { schema: { type: 'object', properties: { authenticated: { type: 'boolean' } } } } } },
        },
      },
    },
    '/oauth/start': {
      get: {
        tags: ['OAuth'],
        summary: 'Start OAuth authorization flow',
        security: [],
        parameters: [
          { name: 'accountId', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '302': { description: 'Redirect to Monday.com OAuth' },
        },
      },
    },
    '/documents': {
      get: {
        tags: ['Documents'],
        summary: 'List documents',
        parameters: [
          { name: 'x-account-id', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'include_deleted', in: 'query', schema: { type: 'boolean', default: false } },
        ],
        responses: {
          '200': {
            description: 'List of documents',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    documents: { type: 'array', items: { '$ref': '#/components/schemas/Document' } },
                    pagination: { '$ref': '#/components/schemas/Pagination' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/documents/{id}': {
      delete: {
        tags: ['Documents'],
        summary: 'Soft-delete a document',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'x-account-id', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Document deleted' },
          '404': { description: 'Not found', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
        },
      },
    },
    '/documents/{id}/events': {
      get: {
        tags: ['Documents'],
        summary: 'Get audit log for a document',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'x-account-id', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Audit events', content: { 'application/json': { schema: { type: 'object', properties: { events: { type: 'array', items: { type: 'object' } } } } } } },
          '404': { description: 'Not found' },
        },
      },
    },
    '/generate-from-monday': {
      post: {
        tags: ['Documents'],
        summary: 'Generate document from Monday.com board item',
        parameters: [
          { name: 'x-account-id', in: 'header', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['board_id', 'item_id', 'template_name'],
                properties: {
                  board_id: { type: 'string' },
                  item_id: { type: 'string' },
                  template_name: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Document generated successfully' },
          '401': { description: 'Unauthorized' },
          '404': { description: 'Template not found' },
        },
      },
    },
    '/templates': {
      get: {
        tags: ['Templates'],
        summary: 'List templates',
        parameters: [
          { name: 'x-account-id', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: {
          '200': {
            description: 'List of templates',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    templates: { type: 'array', items: { '$ref': '#/components/schemas/Template' } },
                    pagination: { '$ref': '#/components/schemas/Pagination' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/sign-document': {
      post: {
        tags: ['Signatures'],
        summary: 'Initiate a signature request',
        parameters: [
          { name: 'x-account-id', in: 'header', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['document_id', 'signer_email'],
                properties: {
                  document_id: { type: 'integer' },
                  signer_email: { type: 'string', format: 'email' },
                  signer_name: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Signature request created' },
          '404': { description: 'Document not found' },
        },
      },
    },
    '/sign/{token}': {
      get: {
        tags: ['Signatures'],
        summary: 'Get signing page (HTML)',
        security: [],
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Signing page HTML' }, '404': { description: 'Invalid token' } },
      },
      post: {
        tags: ['Signatures'],
        summary: 'Submit a signature',
        security: [],
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['signature_data'],
                properties: {
                  signature_data: { type: 'string', description: 'Base64 signature image' },
                  signer_name: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Signature submitted', content: { 'application/json': { schema: { type: 'object', properties: { download_url: { type: 'string' } } } } } },
          '400': { description: 'Invalid or expired token' },
        },
      },
    },
    '/signatures': {
      get: {
        tags: ['Signatures'],
        summary: 'List signature requests',
        parameters: [
          { name: 'x-account-id', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'List of signatures' } },
      },
    },
    '/webhooks/monday': {
      post: {
        tags: ['Automations'],
        summary: 'Monday.com webhook receiver',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Accepted' }, '401': { description: 'Invalid HMAC signature' } },
      },
    },
    '/webhooks/triggers': {
      get: {
        tags: ['Automations'],
        summary: 'List webhook triggers',
        parameters: [
          { name: 'x-account-id', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'List of triggers' } },
      },
      post: {
        tags: ['Automations'],
        summary: 'Create a webhook trigger',
        parameters: [
          { name: 'x-account-id', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: { '201': { description: 'Trigger created' } },
      },
    },
    '/subscription': {
      get: {
        tags: ['Subscription'],
        summary: 'Get current subscription plan',
        parameters: [
          { name: 'x-account-id', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Subscription info' } },
      },
    },
  },
};
