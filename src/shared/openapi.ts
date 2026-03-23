import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import {
  AckResponseSchema,
  HealthResponseSchema,
  LocationUpdateRequestSchema,
} from './schemas/location';

const registry = new OpenAPIRegistry();

registry.registerPath({
  method: 'post',
  path: '/v1/clients/location/update',
  summary: 'Update client location',
  description:
    'Accepts a client location update and returns an acknowledgment. This initial version validates input and returns success without persistence.',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: LocationUpdateRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Location update accepted.',
      content: {
        'application/json': {
          schema: AckResponseSchema,
        },
      },
    },
    400: {
      description: 'Invalid request payload.',
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/v1/clients/location/health',
  summary: 'Location API health check',
  responses: {
    200: {
      description: 'Location API is healthy.',
      content: {
        'application/json': {
          schema: HealthResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/system/health',
  summary: 'System API health check',
  responses: {
    200: {
      description: 'System API is healthy.',
      content: {
        'application/json': {
          schema: HealthResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/system/openapi.json',
  summary: 'OpenAPI document',
  responses: {
    200: {
      description: 'OpenAPI specification in JSON format.',
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/system/version',
  summary: 'System API build/version marker',
  responses: {
    200: {
      description: 'Current deployed build identifier and metadata.',
    },
  },
});

export function buildOpenApiDocument(baseUrl?: string) {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'MSight Cloud API',
      version: '1.0.0',
      description: 'Initial MSight Cloud HTTP API.',
    },
    servers: baseUrl ? [{ url: baseUrl }] : [],
  });
}