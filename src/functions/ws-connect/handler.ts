import type {
  APIGatewayProxyWebsocketEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { DeleteConnectionCommand, ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import { sendValkeyArrayCommand } from '../../shared/valkey-client.js';

const ZONE_ID = 'zone01';

function buildClientKey(appId: string, clientId: string): string {
  return `msight:${ZONE_ID}:${appId}:client:${clientId}`;
}

function buildWsConnectionLookupKey(connectionId: string): string {
  return `msight:${ZONE_ID}:ws:connection:${connectionId}`;
}

type ExistingWsConnection = {
  connectionId: string;
  domainName: string;
  stage: string;
};

function isValidIdentityPart(value: string): boolean {
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(value);
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

async function closeExistingConnectionIfAny(
  existingConnection: ExistingWsConnection | null,
  newConnectionId: string
): Promise<void> {
  if (!existingConnection || existingConnection.connectionId === newConnectionId) {
    return;
  }

  const endpoint = `https://${existingConnection.domainName}/${existingConnection.stage}`;
  const client = new ApiGatewayManagementApiClient({ endpoint });

  try {
    await client.send(
      new DeleteConnectionCommand({
        ConnectionId: existingConnection.connectionId,
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('GoneException') ||
      message.includes('status code 410') ||
      message.includes('status code 404') ||
      message.includes('No method found matching route') ||
      message.includes('ForbiddenException')
    ) {
      return;
    }

    console.warn('best-effort cleanup of old websocket connection failed', {
      oldConnectionId: existingConnection.connectionId,
      endpoint,
      error,
    });
  }
}

async function getExistingWsConnection(clientKey: string): Promise<ExistingWsConnection | null> {
  const existingWsFields = await sendValkeyArrayCommand([
    'HMGET',
    clientKey,
    'ws_connection_id',
    'ws_domain_name',
    'ws_stage',
  ]);

  if (!Array.isArray(existingWsFields) || existingWsFields.length < 3) {
    return null;
  }

  const connectionId =
    typeof existingWsFields[0] === 'string' ? existingWsFields[0] : '';
  const domainName = typeof existingWsFields[1] === 'string' ? existingWsFields[1] : '';
  const stage = typeof existingWsFields[2] === 'string' ? existingWsFields[2] : '';

  if (!connectionId || !domainName || !stage) {
    return null;
  }

  return {
    connectionId,
    domainName,
    stage,
  };
}

export async function handler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const connectionId = event.requestContext.connectionId;
  const domainName = event.requestContext.domainName;
  const stage = event.requestContext.stage;
  const rawQueryString =
    (event as unknown as { rawQueryString?: string }).rawQueryString ?? '';
  const rawQueryParams = new URLSearchParams(rawQueryString);
  const fallbackQueryParams =
    (event as unknown as { queryStringParameters?: Record<string, string> })
      .queryStringParameters ?? {};

  const appId = rawQueryParams.get('app_id') ?? fallbackQueryParams.app_id;
  const clientId = rawQueryParams.get('client_id') ?? fallbackQueryParams.client_id;

  if (!connectionId || !domainName || !stage) {
    return jsonResponse(400, {
      error: 'invalid_request_context',
      message: 'Missing required request context for websocket connect.',
    });
  }

  if (!appId || !clientId) {
    return jsonResponse(400, {
      error: 'missing_query_params',
      message: 'app_id and client_id query params are required.',
    });
  }

  if (!isValidIdentityPart(appId) || !isValidIdentityPart(clientId)) {
    return jsonResponse(400, {
      error: 'invalid_query_params',
      message: 'app_id or client_id format is invalid.',
    });
  }

  const clientKey = buildClientKey(appId, clientId);
  const connectionLookupKey = buildWsConnectionLookupKey(connectionId);

  try {
    const existingConnection = await getExistingWsConnection(clientKey);

    await closeExistingConnectionIfAny(existingConnection, connectionId);

    await sendValkeyArrayCommand([
      'HSET',
      clientKey,
      'ws_connection_id',
      connectionId,
      'ws_domain_name',
      domainName,
      'ws_stage',
      stage,
      'ws_connected_at',
      new Date().toISOString(),
      'ws_status',
      'connected',
    ]);

    await sendValkeyArrayCommand([
      'SET',
      connectionLookupKey,
      JSON.stringify({ app_id: appId, client_id: clientId }),
      'EX',
      86400,
    ]);

    return jsonResponse(200, {
      status: 'connected',
      app_id: appId,
      client_id: clientId,
      connection_id: connectionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('ws connect handler failed', {
      appId,
      clientId,
      connectionId,
      error,
    });

    return jsonResponse(500, {
      error: 'ws_connect_failed',
      message,
    });
  }
}
