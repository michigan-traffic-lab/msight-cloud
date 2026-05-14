import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import {
  RadiusBroadcastRequestSchema,
  RadiusBroadcastResponseSchema,
} from '../../shared/schemas/radius-broadcast';
import { HealthResponseSchema } from '../../shared/schemas/location';
import { radiusBroadcaster } from '../../shared/radius-broadcaster.js';

function jsonResponse(
  statusCode: number,
  body: unknown
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const apiVersion = process.env.API_VERSION ?? 'v1';
  const serviceName = process.env.SERVICE_NAME ?? 'radius-broadcast-api';

  if (method === 'GET' && path === '/v1/clients/notify/radius/health') {
    return jsonResponse(200, HealthResponseSchema.parse({
      status: 'ok',
      message: 'Radius broadcast API is healthy.',
      service: serviceName,
      api_version: apiVersion,
      server_timestamp: new Date().toISOString(),
    }));
  }

  if (method !== 'POST' || path !== '/v1/clients/notify/radius') {
    return jsonResponse(404, {
      error: 'not_found',
      message: `No route for ${method} ${path} in radius-broadcast-api`,
    });
  }

  const parsedJson = (() => {
    try {
      return JSON.parse(event.body ?? '{}');
    } catch {
      return null;
    }
  })();

  if (!parsedJson) {
    return jsonResponse(400, {
      error: 'invalid_json',
      message: 'Request body must be valid JSON.',
    });
  }

  const parsedRequest = RadiusBroadcastRequestSchema.safeParse(parsedJson);
  if (!parsedRequest.success) {
    return jsonResponse(400, {
      error: 'validation_error',
      message: 'Request body failed schema validation.',
      details: parsedRequest.error.flatten(),
    });
  }

  const { app_id, origin, radius_m, message, limit, event_id } = parsedRequest.data;
  const eventId = event_id ?? randomUUID();

  console.log('radius broadcast request', {
    appId: app_id,
    eventId,
    lat: origin.lat,
    lon: origin.lon,
    radiusM: radius_m,
    limit,
    messageType: typeof message === 'object' && message !== null && 'message_type' in message
      ? (message as Record<string, unknown>).message_type
      : undefined,
  });

  try {
    const result = await radiusBroadcaster.broadcast({
      appId: app_id,
      eventId,
      message,
      lat: origin.lat,
      lon: origin.lon,
      radiusM: radius_m,
      limit,
    });

    console.log('radius broadcast complete', {
      appId: app_id,
      eventId,
      nearbyClientCount: result.nearbyClientCount,
      websocketCandidateCount: result.websocketCandidateCount,
      deliveredCount: result.deliveredCount,
      failedCount: result.failedCount,
    });

    return jsonResponse(200, RadiusBroadcastResponseSchema.parse({
      status: 'ok',
      app_id,
      event_id: eventId,
      radius_m,
      nearby_client_count: result.nearbyClientCount,
      websocket_candidate_count: result.websocketCandidateCount,
      delivered_count: result.deliveredCount,
      failed_count: result.failedCount,
      server_timestamp: new Date().toISOString(),
      api_version: apiVersion,
    }));
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    console.error('radius broadcast failed', {
      message: errMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return jsonResponse(500, {
      error: 'radius_broadcast_failed',
      message: errMessage,
      server_timestamp: new Date().toISOString(),
      api_version: apiVersion,
    });
  }
}
