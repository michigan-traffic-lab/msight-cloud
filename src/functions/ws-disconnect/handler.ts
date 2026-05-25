import type {
  APIGatewayProxyWebsocketEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { sendValkeyArrayCommand } from '../../shared/valkey-client.js';

const ZONE_ID = 'zone01';

function buildClientKey(appId: string, clientId: string): string {
  return `msight:${ZONE_ID}:${appId}:client:${clientId}`;
}

function buildWsConnectionLookupKey(connectionId: string): string {
  return `msight:${ZONE_ID}:ws:connection:${connectionId}`;
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

export async function handler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const connectionId = event.requestContext.connectionId;

  if (!connectionId) {
    return jsonResponse(400, {
      error: 'invalid_request_context',
      message: 'Missing connectionId in websocket disconnect event.',
    });
  }

  const connectionLookupKey = buildWsConnectionLookupKey(connectionId);

  try {
    const mappingValue = await sendValkeyArrayCommand(['GET', connectionLookupKey]);

    if (mappingValue !== null) {
      const parsedMapping = JSON.parse(String(mappingValue)) as {
        app_id?: string;
        client_id?: string;
      };

      if (parsedMapping.app_id && parsedMapping.client_id) {
        const clientKey = buildClientKey(parsedMapping.app_id, parsedMapping.client_id);
        // Use a Lua script for an atomic check-and-delete so a reconnect that
        // writes a new ws_connection_id between HGET and HDEL cannot be wiped.
        await sendValkeyArrayCommand([
          'EVAL',
          `local cur = redis.call('HGET', KEYS[1], 'ws_connection_id')
 if cur == ARGV[1] then
   redis.call('HDEL', KEYS[1], 'ws_connection_id', 'ws_domain_name', 'ws_stage', 'ws_connected_at', 'ws_status')
   return 1
 end
 return 0`,
          1,
          clientKey,
          connectionId,
        ]);
      }
    }

    await sendValkeyArrayCommand(['DEL', connectionLookupKey]);

    return jsonResponse(200, {
      status: 'disconnected',
      connection_id: connectionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('ws disconnect handler failed', {
      connectionId,
      error,
    });

    return jsonResponse(500, {
      error: 'ws_disconnect_failed',
      message,
    });
  }
}
