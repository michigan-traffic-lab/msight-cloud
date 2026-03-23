import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { HealthResponseSchema } from '../../shared/schemas/location';
import { buildOpenApiDocument } from '../../shared/openapi';

function jsonResponse(
  statusCode: number,
  body: unknown
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const apiVersion = process.env.API_VERSION ?? 'v1';
  const serviceName = process.env.SERVICE_NAME ?? 'system-api';

  if (method === 'GET' && path === '/system/health') {
    const response = HealthResponseSchema.parse({
      status: 'ok',
      message: 'System API is healthy.',
      service: serviceName,
      api_version: apiVersion,
      server_timestamp: new Date().toISOString(),
    });

    return jsonResponse(200, response);
  }

  if (method === 'GET' && path === '/system/openapi.json') {
    const domainName = event.requestContext.domainName;
    const baseUrl = domainName ? `https://${domainName}` : undefined;
    return jsonResponse(200, buildOpenApiDocument(baseUrl));
  }

  if (method === 'GET' && path === '/system/version') {
    return jsonResponse(200, {
      service: serviceName,
      api_version: apiVersion,
      build_id: process.env.BUILD_ID ?? 'unknown',
      server_timestamp: new Date().toISOString(),
    });
  }

  return jsonResponse(404, {
    error: 'not_found',
    message: `No route for ${method} ${path} in system-api`,
  });
}