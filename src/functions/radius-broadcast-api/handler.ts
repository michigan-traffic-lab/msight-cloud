import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { sendValkeyArrayCommand } from '../../shared/valkey-client.js';
import {
  RadiusBroadcastRequestSchema,
  RadiusBroadcastResponseSchema,
  type RadiusBroadcastRequest,
} from '../../shared/schemas/radius-broadcast';
import { HealthResponseSchema } from '../../shared/schemas/location';

const ZONE_ID = 'zone01';
const DEFAULT_LIMIT = 500;
const lambdaClient = new LambdaClient({});

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

function buildGeoClientsKey(appId: string): string {
  return `msight:${ZONE_ID}:${appId}:geo:clients`;
}

function buildClientKey(appId: string, clientId: string): string {
  return `msight:${ZONE_ID}:${appId}:client:${clientId}`;
}

function parseClientIds(response: unknown): string[] {
  if (!Array.isArray(response)) {
    return [];
  }

  return response.filter((value): value is string => typeof value === 'string');
}

type WsInfo = {
  clientId: string;
  connectionId: string;
  domainName: string;
  stage: string;
};

type WsSendEvent = {
  app_id: string;
  message: unknown;
  items: WsInfo[];
};

type WsSendResult = {
  deliveredCount: number;
  failedCount: number;
  goneConnectionIds: string[];
};

async function getClientWsInfo(appId: string, clientId: string): Promise<WsInfo | null> {
  const clientKey = buildClientKey(appId, clientId);
  const wsFields = await sendValkeyArrayCommand([
    'HMGET',
    clientKey,
    'ws_connection_id',
    'ws_domain_name',
    'ws_stage',
  ]);

  if (!Array.isArray(wsFields) || wsFields.length < 3) {
    return null;
  }

  const connectionId = typeof wsFields[0] === 'string' ? wsFields[0] : '';
  const domainName = typeof wsFields[1] === 'string' ? wsFields[1] : '';
  const stage = typeof wsFields[2] === 'string' ? wsFields[2] : '';

  if (!connectionId || !domainName || !stage) {
    return null;
  }

  return {
    clientId,
    connectionId,
    domainName,
    stage,
  };
}

async function clearWsInfoIfSameConnection(
  appId: string,
  clientId: string,
  connectionId: string
): Promise<void> {
  const clientKey = buildClientKey(appId, clientId);
  const activeConnectionValue = await sendValkeyArrayCommand([
    'HGET',
    clientKey,
    'ws_connection_id',
  ]);
  const activeConnectionId = activeConnectionValue === null ? '' : String(activeConnectionValue);

  if (activeConnectionId !== connectionId) {
    return;
  }

  await sendValkeyArrayCommand([
    'HDEL',
    clientKey,
    'ws_connection_id',
    'ws_domain_name',
    'ws_stage',
    'ws_connected_at',
    'ws_status',
  ]);
}

async function invokeWsSender(event: WsSendEvent): Promise<WsSendResult> {
  const functionName = process.env.WS_SEND_LAMBDA_NAME?.trim();
  if (!functionName) {
    throw new Error('WS_SEND_LAMBDA_NAME is not configured.');
  }

  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(event), 'utf8'),
    })
  );

  if (response.FunctionError) {
    const errorPayload = response.Payload
      ? Buffer.from(response.Payload).toString('utf8')
      : '';
    throw new Error(`ws-send invocation failed: ${response.FunctionError} ${errorPayload}`.trim());
  }

  if (!response.Payload) {
    throw new Error('ws-send invocation returned no payload.');
  }

  const payloadText = Buffer.from(response.Payload).toString('utf8');
  const parsed = JSON.parse(payloadText) as Partial<WsSendResult>;

  return {
    deliveredCount: Number(parsed.deliveredCount ?? 0),
    failedCount: Number(parsed.failedCount ?? 0),
    goneConnectionIds: Array.isArray(parsed.goneConnectionIds)
      ? parsed.goneConnectionIds.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

async function broadcastToRadius(request: RadiusBroadcastRequest): Promise<{
  nearbyClientCount: number;
  websocketCandidateCount: number;
  deliveredCount: number;
  failedCount: number;
}> {
  const geoClientsKey = buildGeoClientsKey(request.app_id);
  const limit = request.limit ?? DEFAULT_LIMIT;

  const nearbyClientsResponse = await sendValkeyArrayCommand([
    'GEOSEARCH',
    geoClientsKey,
    'FROMLONLAT',
    request.origin.lon,
    request.origin.lat,
    'BYRADIUS',
    request.radius_m,
    'm',
    'COUNT',
    limit,
    'ASC',
  ]);

  const nearbyClientIds = parseClientIds(nearbyClientsResponse);

  const wsInfosRaw = await Promise.all(
    nearbyClientIds.map((clientId) => getClientWsInfo(request.app_id, clientId))
  );
  const wsInfos = wsInfosRaw.filter((item): item is WsInfo => item !== null);

  const sendResult = await invokeWsSender({
    app_id: request.app_id,
    message: request.message,
    items: wsInfos,
  });

  const deliveredCount = sendResult.deliveredCount;
  const failedCount = sendResult.failedCount;
  const goneConnectionIds = sendResult.goneConnectionIds;

  if (goneConnectionIds.length > 0) {
    const wsInfoByConnectionId = new Map(wsInfos.map((item) => [item.connectionId, item]));

    await Promise.all(
      goneConnectionIds.map(async (connectionId) => {
        const wsInfo = wsInfoByConnectionId.get(connectionId);
        if (!wsInfo) {
          return;
        }

        await clearWsInfoIfSameConnection(request.app_id, wsInfo.clientId, connectionId);
      })
    );
  }

  return {
    nearbyClientCount: nearbyClientIds.length,
    websocketCandidateCount: wsInfos.length,
    deliveredCount,
    failedCount,
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
    const response = HealthResponseSchema.parse({
      status: 'ok',
      message: 'Radius broadcast API is healthy.',
      service: serviceName,
      api_version: apiVersion,
      server_timestamp: new Date().toISOString(),
    });

    return jsonResponse(200, response);
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

  try {
    const result = await broadcastToRadius(parsedRequest.data);

    const response = RadiusBroadcastResponseSchema.parse({
      status: 'ok',
      app_id: parsedRequest.data.app_id,
      radius_m: parsedRequest.data.radius_m,
      nearby_client_count: result.nearbyClientCount,
      websocket_candidate_count: result.websocketCandidateCount,
      delivered_count: result.deliveredCount,
      failed_count: result.failedCount,
      server_timestamp: new Date().toISOString(),
      api_version: apiVersion,
    });

    return jsonResponse(200, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('radius broadcast failed', { error });

    return jsonResponse(500, {
      error: 'radius_broadcast_failed',
      message,
      server_timestamp: new Date().toISOString(),
      api_version: apiVersion,
    });
  }
}
