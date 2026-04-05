import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { sendValkeyArrayCommand } from '../../shared/valkey-client.js';
import {
  RadiusBroadcastRequestSchema,
  RadiusBroadcastResponseSchema,
  type RadiusBroadcastRequest,
} from '../../shared/schemas/radius-broadcast';

const DEFAULT_ZONE_ID = 'zone01';
const DEFAULT_LIMIT = 500;
const DEFAULT_WS_SEND_TIMEOUT_MS = 3000;

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

function getZoneId(): string {
  return process.env.LOCATION_ZONE_ID ?? DEFAULT_ZONE_ID;
}

function buildGeoClientsKey(appId: string): string {
  return `msight:${getZoneId()}:${appId}:geo:clients`;
}

function buildClientKey(appId: string, clientId: string): string {
  return `msight:${getZoneId()}:${appId}:client:${clientId}`;
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

function getWsEndpoint(domainName: string, stage: string): string {
  if (domainName && stage) {
    return `https://${domainName}/${stage}`;
  }

  const configuredEndpoint = process.env.WS_MANAGEMENT_ENDPOINT?.trim();
  if (configuredEndpoint) {
    return configuredEndpoint;
  }

  throw new Error('No websocket management endpoint available for connection.');
}

function getWsSendTimeoutMs(): number {
  const value = Number(process.env.WS_SEND_TIMEOUT_MS ?? DEFAULT_WS_SEND_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_WS_SEND_TIMEOUT_MS;
  }
  return Math.floor(value);
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

  const payloadBuffer = Buffer.from(
    JSON.stringify({
      app_id: request.app_id,
      message: request.message,
      server_timestamp: new Date().toISOString(),
    }),
    'utf8'
  );

  const clientByEndpoint = new Map<string, ApiGatewayManagementApiClient>();
  let deliveredCount = 0;
  let failedCount = 0;
  const goneConnectionIds: string[] = [];
  const wsSendTimeoutMs = getWsSendTimeoutMs();

  for (const wsInfo of wsInfos) {
    const endpoint = getWsEndpoint(wsInfo.domainName, wsInfo.stage);
    let wsClient = clientByEndpoint.get(endpoint);
    if (!wsClient) {
      wsClient = new ApiGatewayManagementApiClient({ endpoint });
      clientByEndpoint.set(endpoint, wsClient);
    }

    try {
      const abortController = new AbortController();
      const abortTimer = setTimeout(() => abortController.abort(), wsSendTimeoutMs);

      try {
        await wsClient.send(
          new PostToConnectionCommand({
            ConnectionId: wsInfo.connectionId,
            Data: payloadBuffer,
          }),
          {
            abortSignal: abortController.signal,
          }
        );

        deliveredCount += 1;
      } finally {
        clearTimeout(abortTimer);
      }
    } catch (error) {
      failedCount += 1;

      if (error instanceof GoneException) {
        goneConnectionIds.push(wsInfo.connectionId);
      }

      const isTimeoutAbort =
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.toLowerCase().includes('abort'));

      console.error('broadcast send failed', {
        appId: request.app_id,
        clientId: wsInfo.clientId,
        connectionId: wsInfo.connectionId,
        endpoint,
        wsSendTimeoutMs,
        isTimeoutAbort,
        error,
      });
    }
  }

  if (goneConnectionIds.length > 0) {
    const wsInfoByConnectionId = new Map(wsInfos.map((item) => [item.connectionId, item]));

    for (const connectionId of goneConnectionIds) {
      const wsInfo = wsInfoByConnectionId.get(connectionId);
      if (!wsInfo) {
        continue;
      }

      await clearWsInfoIfSameConnection(request.app_id, wsInfo.clientId, connectionId);
    }
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
