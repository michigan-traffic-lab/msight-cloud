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
import { debugLog } from '../../shared/debug-log';

// ---- direct Lambda invocation (Lambda-to-Lambda, no API GW wrapper) ------
//
// When invoked directly (e.g. from spat-sns-consumer) the event is just the
// RadiusBroadcastRequest payload.  We detect this by the absence of
// requestContext.http and return the result object directly instead of an
// HTTP response envelope.

type DirectInvocationResult = {
  status: 'ok';
  app_id: string;
  event_id: string;
  radius_m: number;
  nearby_client_count: number;
  websocket_candidate_count: number;
  delivered_count: number;
  failed_count: number;
  server_timestamp: string;
};

function isDirectInvocation(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    !('requestContext' in event)
  );
}

// ---- HTTP helpers --------------------------------------------------------

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

// ---- Lambda entry point --------------------------------------------------

export async function handler(
  event: APIGatewayProxyEventV2 | Record<string, unknown>
): Promise<APIGatewayProxyStructuredResultV2 | DirectInvocationResult> {
  const apiVersion = process.env.API_VERSION ?? 'v1';
  const serviceName = process.env.SERVICE_NAME ?? 'radius-broadcast-api';

  // ---- direct invocation path ------------------------------------------
  if (isDirectInvocation(event)) {
    const parsedRequest = RadiusBroadcastRequestSchema.safeParse(event);
    if (!parsedRequest.success) {
      throw new Error(
        `radius-broadcast-api direct invocation: invalid payload — ${JSON.stringify(parsedRequest.error.flatten())}`
      );
    }
    const { app_id, origin, radius_m, message, limit, event_id } = parsedRequest.data;
    const eventId = event_id ?? randomUUID();
    const result = await radiusBroadcaster.broadcast({
      appId: app_id,
      eventId,
      message,
      lat: origin.lat,
      lon: origin.lon,
      radiusM: radius_m,
      limit,
    });
    return {
      status: 'ok',
      app_id,
      event_id: eventId,
      radius_m,
      nearby_client_count: result.nearbyClientCount,
      websocket_candidate_count: result.websocketCandidateCount,
      delivered_count: result.deliveredCount,
      failed_count: result.failedCount,
      server_timestamp: new Date().toISOString(),
    };
  }

  // ---- HTTP API Gateway path -------------------------------------------
  const httpEvent = event as APIGatewayProxyEventV2;
  const method = httpEvent.requestContext.http.method;
  const path = httpEvent.rawPath;

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
      return JSON.parse(httpEvent.body ?? '{}');
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

  debugLog('radius broadcast request', {
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

    debugLog('radius broadcast complete', {
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
