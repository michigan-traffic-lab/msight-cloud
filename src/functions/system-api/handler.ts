import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { HealthResponseSchema } from '../../shared/schemas/location';
import { buildOpenApiDocument } from '../../shared/openapi';
import {
  VersionResponseSchema,
  WebSocketUrlResponseSchema,
} from '../../shared/schemas/system';

function jsonResponse(
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

// Pinned to the swagger-ui-dist version this was built against, since the CDN
// serves whatever tag is asked for rather than a range.
const SWAGGER_UI_VERSION = '5.32.1';

function swaggerUiHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MSight Cloud API docs</title>
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css"
    />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = () => {
        window.ui = SwaggerUIBundle({
          url: '/system/openapi.json',
          dom_id: '#swagger-ui',
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: 'StandaloneLayout',
        });
      };
    </script>
  </body>
</html>
`;
}

function htmlResponse(
  statusCode: number,
  body: string,
  extraHeaders?: Record<string, string>
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...extraHeaders,
    },
    body,
  };
}

// The spec and its rendered page only change when new code is deployed, so a
// short cache spares a repeat reader (or a CDN in front) from paying for the
// same recomputation — without letting a stale copy survive past one deploy's
// worth of curiosity.
const DOCS_CACHE_HEADERS = { 'cache-control': 'public, max-age=300' };

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
    return jsonResponse(200, buildOpenApiDocument(baseUrl), DOCS_CACHE_HEADERS);
  }

  if (method === 'GET' && path === '/system/docs') {
    return htmlResponse(200, swaggerUiHtml(), DOCS_CACHE_HEADERS);
  }

  if (method === 'GET' && path === '/system/version') {
    const response = VersionResponseSchema.parse({
      service: serviceName,
      api_version: apiVersion,
      build_id: process.env.BUILD_ID ?? 'unknown',
      server_timestamp: new Date().toISOString(),
    });

    return jsonResponse(200, response);
  }

  if (method === 'GET' && path === '/system/websocket-url') {
    const wsApiUrl = process.env.WS_API_URL ?? '';

    if (!wsApiUrl) {
      return jsonResponse(503, {
        error: 'websocket_unavailable',
        message: 'WebSocket URL is not configured.',
      });
    }

    const response = WebSocketUrlResponseSchema.parse({
      websocket_url: wsApiUrl,
      api_version: apiVersion,
      server_timestamp: new Date().toISOString(),
    });

    return jsonResponse(200, response);
  }

  return jsonResponse(404, {
    error: 'not_found',
    message: `No route for ${method} ${path} in system-api`,
  });
}