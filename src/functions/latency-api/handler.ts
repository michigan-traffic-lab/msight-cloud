import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { LatencyProbeResponseSchema } from 'src/shared/schemas/latency';

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
  const serviceName = process.env.SERVICE_NAME ?? 'latency-api';
  const buildId = process.env.BUILD_ID ?? 'unknown';

  if (method !== 'GET' || path !== '/v1/client/latency') {
    return jsonResponse(404, {
      error: 'not_found',
      message: `No route for ${method} ${path} in latency-api`,
    });
  }

  const receiveEpochMs = Date.now();

  const clientSentAt = event.queryStringParameters?.client_sent_at;
  const clientSequence = event.queryStringParameters?.seq;

  const response = LatencyProbeResponseSchema.parse({
    status: 'ok',
    message: 'Latency probe response generated.',
    request_id: event.requestContext.requestId,
    service: serviceName,
    api_version: apiVersion,
    build_id: buildId,
    server_received_timestamp: new Date(receiveEpochMs).toISOString(),
    server_response_timestamp: new Date().toISOString(),
    connectivity: {
      source_ip: event.requestContext.http.sourceIp ?? 'unknown',
      user_agent: event.requestContext.http.userAgent ?? 'unknown',
      protocol: event.requestContext.http.protocol,
      stage: event.requestContext.stage,
      domain_name: event.requestContext.domainName,
    },
    echo: {
      client_sent_at: clientSentAt,
      seq: clientSequence,
    },
  });

  return jsonResponse(200, response);
}