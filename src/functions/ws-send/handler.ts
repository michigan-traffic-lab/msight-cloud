import type { Context } from 'aws-lambda';
import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

const DEFAULT_WS_SEND_TIMEOUT_MS = 10000;

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

function getWsSendTimeoutMs(): number {
  const value = Number(process.env.WS_SEND_TIMEOUT_MS ?? DEFAULT_WS_SEND_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_WS_SEND_TIMEOUT_MS;
  }
  return Math.floor(value);
}

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
  const wsSendTimeoutMs = getWsSendTimeoutMs();

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
    const sendStartedAt = Date.now();

    try {
      const abortController = new AbortController();
      const abortTimer = setTimeout(() => abortController.abort(), wsSendTimeoutMs);

      try {
        await apiClient.send(
          new PostToConnectionCommand({
            ConnectionId: item.connectionId,
            Data: payloadBytes,
          }),
          {
            abortSignal: abortController.signal,
          }
        );
      } finally {
        clearTimeout(abortTimer);
      }

      console.log('ws-send delivered', {
        appId: event?.app_id,
        clientId: item.clientId,
        connectionId: item.connectionId,
        endpoint,
        wsSendTimeoutMs,
        sendDurationMs: Date.now() - sendStartedAt,
      });

      deliveredCount += 1;
    } catch (error) {
      failedCount += 1;

      const isGone = error instanceof GoneException;
      if (isGone) {
        goneConnectionIds.push(item.connectionId);
      }

      const isTimeoutAbort =
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.toLowerCase().includes('abort'));

      const metadata =
        error && typeof error === 'object' && '$metadata' in error
          ? (error as { $metadata?: unknown }).$metadata
          : undefined;

      console.error('ws-send failed', {
        appId: event?.app_id,
        clientId: item.clientId,
        connectionId: item.connectionId,
        endpoint,
        wsSendTimeoutMs,
        sendDurationMs: Date.now() - sendStartedAt,
        isGone,
        isTimeoutAbort,
        metadata,
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
