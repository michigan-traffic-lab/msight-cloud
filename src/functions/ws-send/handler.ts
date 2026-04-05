import type { Context } from 'aws-lambda';
import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

type WsSendItem = {
  clientId: string;
  connectionId: string;
  domainName: string;
  stage: string;
};

type WsSendEvent = {
  app_id: string;
  message: unknown;
  items: WsSendItem[];
};

type WsSendResult = {
  deliveredCount: number;
  failedCount: number;
  goneConnectionIds: string[];
};

function getApiClient(
  endpoint: string,
  clientsByEndpoint: Map<string, ApiGatewayManagementApiClient>
): ApiGatewayManagementApiClient {
  const existing = clientsByEndpoint.get(endpoint);
  if (existing) {
    return existing;
  }

  const created = new ApiGatewayManagementApiClient({ endpoint });
  clientsByEndpoint.set(endpoint, created);
  return created;
}

export async function handler(event: WsSendEvent, _context: Context): Promise<WsSendResult> {
  const items = Array.isArray(event?.items) ? event.items : [];

  const payloadBytes = Buffer.from(
    JSON.stringify({
      app_id: event?.app_id,
      message: event?.message,
      server_timestamp: new Date().toISOString(),
    }),
    'utf8'
  );

  const apiClientsByEndpoint = new Map<string, ApiGatewayManagementApiClient>();

  let deliveredCount = 0;
  let failedCount = 0;
  const goneConnectionIds: string[] = [];

  for (const item of items) {
    const endpoint = `https://${item.domainName}/${item.stage}`;
    const apiClient = getApiClient(endpoint, apiClientsByEndpoint);

    try {
      await apiClient.send(
        new PostToConnectionCommand({
          ConnectionId: item.connectionId,
          Data: payloadBytes,
        })
      );
      deliveredCount += 1;
    } catch (error) {
      failedCount += 1;

      if (error instanceof GoneException) {
        goneConnectionIds.push(item.connectionId);
      }

      console.error('ws-send failed', {
        appId: event?.app_id,
        clientId: item.clientId,
        connectionId: item.connectionId,
        endpoint,
        error,
      });
    }
  }

  return {
    deliveredCount,
    failedCount,
    goneConnectionIds,
  };
}
