import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

export type WsSendItem = {
  clientId: string;
  connectionId: string;
  domainName: string;
  stage: string;
};

export type WsSendResult = {
  deliveredCount: number;
  failedCount: number;
  goneConnectionIds: string[];
};

export class WsSender {
  // Cached per endpoint — persists across warm Lambda invocations.
  private readonly apiClientsByEndpoint = new Map<string, ApiGatewayManagementApiClient>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = 10_000) {
    this.timeoutMs = timeoutMs;
  }

  private getApiClient(endpoint: string): ApiGatewayManagementApiClient {
    let client = this.apiClientsByEndpoint.get(endpoint);
    if (!client) {
      client = new ApiGatewayManagementApiClient({ endpoint });
      this.apiClientsByEndpoint.set(endpoint, client);
    }
    return client;
  }

  private getFreshApiClient(endpoint: string): ApiGatewayManagementApiClient {
    // Creates a new client instance with an empty connection pool, replacing the
    // stale cached one. The first request on this client opens a fresh TCP connection.
    const client = new ApiGatewayManagementApiClient({ endpoint });
    this.apiClientsByEndpoint.set(endpoint, client);
    return client;
  }

  async send(appId: string, eventId: string, message: unknown, items: WsSendItem[]): Promise<WsSendResult> {
    if (items.length === 0) {
      return { deliveredCount: 0, failedCount: 0, goneConnectionIds: [] };
    }

    const payloadBytes = Buffer.from(
      JSON.stringify({
        app_id: appId,
        event_id: eventId,
        message,
        server_timestamp: new Date().toISOString(),
      }),
      'utf8'
    );

    const payloadSizeBytes = payloadBytes.length;
    const cachedEndpoints = [...this.apiClientsByEndpoint.keys()];

    console.log('ws send start', {
      appId,
      eventId,
      itemCount: items.length,
      payloadSizeBytes,
      timeoutMs: this.timeoutMs,
      cachedEndpoints,
    });

    const results = await Promise.all(
      items.map(async (item) => {
        const endpoint = `https://${item.domainName}/${item.stage}`;
        const isNewClient = !this.apiClientsByEndpoint.has(endpoint);
        const startedAt = Date.now();

        console.log('ws send attempt', {
          appId,
          eventId,
          clientId: item.clientId,
          connectionId: item.connectionId,
          endpoint,
          isNewClient,
        });

        const doSend = async (client: ApiGatewayManagementApiClient): Promise<void> => {
          const abortController = new AbortController();
          const abortTimer = setTimeout(() => abortController.abort(), this.timeoutMs);
          try {
            await client.send(
              new PostToConnectionCommand({
                ConnectionId: item.connectionId,
                Data: payloadBytes,
              }),
              { abortSignal: abortController.signal }
            );
          } finally {
            clearTimeout(abortTimer);
          }
        };

        try {
          await doSend(this.getApiClient(endpoint));

          const durationMs = Date.now() - startedAt;
          console.log('ws delivered', {
            appId,
            eventId,
            clientId: item.clientId,
            connectionId: item.connectionId,
            endpoint,
            durationMs,
          });

          return { delivered: true, goneConnectionId: null as string | null };
        } catch (firstError) {
          const firstDurationMs = Date.now() - startedAt;
          const isAbort =
            firstError instanceof Error &&
            (firstError.name === 'AbortError' || firstError.message.toLowerCase().includes('abort'));

          // If the first attempt timed out, the cached keep-alive connection is likely stale.
          // Retry once with a fresh connection before giving up.
          if (isAbort && !isNewClient) {
            console.warn('ws send stale connection detected, retrying with fresh connection', {
              appId,
              eventId,
              clientId: item.clientId,
              connectionId: item.connectionId,
              firstDurationMs,
            });

            const retryStartedAt = Date.now();
            try {
              await doSend(this.getFreshApiClient(endpoint));

              const retryDurationMs = Date.now() - retryStartedAt;
              console.log('ws delivered on retry', {
                appId,
                eventId,
                clientId: item.clientId,
                connectionId: item.connectionId,
                endpoint,
                firstDurationMs,
                retryDurationMs,
              });

              return { delivered: true, goneConnectionId: null as string | null };
            } catch (retryError) {
              const retryDurationMs = Date.now() - retryStartedAt;
              const isRetryGone = retryError instanceof GoneException;
              const isRetryAbort =
                retryError instanceof Error &&
                (retryError.name === 'AbortError' || retryError.message.toLowerCase().includes('abort'));
              const httpStatusCode =
                retryError != null && typeof retryError === 'object' && '$metadata' in retryError
                  ? (retryError as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
                  : undefined;

              console.error('ws send failed after retry', {
                appId,
                eventId,
                clientId: item.clientId,
                connectionId: item.connectionId,
                endpoint,
                isGone: isRetryGone,
                isAbort: isRetryAbort,
                httpStatusCode,
                firstDurationMs,
                retryDurationMs,
                errorName: retryError instanceof Error ? retryError.name : undefined,
                errorMessage: retryError instanceof Error ? retryError.message : String(retryError),
              });

              return { delivered: false, goneConnectionId: isRetryGone ? item.connectionId : null };
            }
          }

          // Not retryable (GoneException, or new client that already failed, or other error).
          const isGone = firstError instanceof GoneException;
          const isTimeout = isAbort && firstDurationMs >= this.timeoutMs - 50;
          const httpStatusCode =
            firstError != null && typeof firstError === 'object' && '$metadata' in firstError
              ? (firstError as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
              : undefined;

          console.error('ws send failed', {
            appId,
            eventId,
            clientId: item.clientId,
            connectionId: item.connectionId,
            endpoint,
            isGone,
            isAbort,
            isTimeout,
            httpStatusCode,
            durationMs: firstDurationMs,
            errorName: firstError instanceof Error ? firstError.name : undefined,
            errorMessage: firstError instanceof Error ? firstError.message : String(firstError),
            errorStack: firstError instanceof Error ? firstError.stack?.split('\n').slice(0, 4).join(' | ') : undefined,
          });

          return { delivered: false, goneConnectionId: isGone ? item.connectionId : null };
        }
      })
    );

    const deliveredCount = results.filter((r) => r.delivered).length;
    const failedCount = results.filter((r) => !r.delivered).length;
    const goneConnectionIds = results
      .map((r) => r.goneConnectionId)
      .filter((id): id is string => id !== null);

    console.log('ws send complete', {
      appId,
      eventId,
      itemCount: items.length,
      deliveredCount,
      failedCount,
      goneCount: goneConnectionIds.length,
    });

    return { deliveredCount, failedCount, goneConnectionIds };
  }
}

// Module-level singleton — reused across warm Lambda invocations.
export const wsSender = new WsSender(
  Number(process.env.WS_SEND_TIMEOUT_MS ?? '10000')
);
