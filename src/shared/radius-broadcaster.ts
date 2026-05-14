import { sendValkeyArrayCommand } from './valkey-client.js';
import { wsSender, type WsSendResult } from './ws-sender.js';

const ZONE_ID = 'zone01';
const DEFAULT_LIMIT = 500;

// ---- key builders --------------------------------------------------------

function buildGeoClientsKey(appId: string): string {
  return `msight:${ZONE_ID}:${appId}:geo:clients`;
}

function buildClientKey(appId: string, clientId: string): string {
  return `msight:${ZONE_ID}:${appId}:client:${clientId}`;
}

// ---- types ---------------------------------------------------------------

export type WsInfo = {
  clientId: string;
  connectionId: string;
  domainName: string;
  stage: string;
};

export type RadiusBroadcastParams = {
  appId: string;
  eventId: string;
  message: unknown;
  lat: number;
  lon: number;
  radiusM: number;
  limit?: number;
};

export type RadiusBroadcastResult = {
  nearbyClientCount: number;
  websocketCandidateCount: number;
  deliveredCount: number;
  failedCount: number;
};

// ---- RadiusBroadcaster ---------------------------------------------------

export class RadiusBroadcaster {
  private async getClientWsInfo(appId: string, clientId: string): Promise<WsInfo | null> {
    const clientKey = buildClientKey(appId, clientId);
    const wsFields = await sendValkeyArrayCommand([
      'HMGET',
      clientKey,
      'ws_connection_id',
      'ws_domain_name',
      'ws_stage',
    ]);

    if (!Array.isArray(wsFields) || wsFields.length < 3) return null;

    const connectionId = typeof wsFields[0] === 'string' ? wsFields[0] : '';
    const domainName = typeof wsFields[1] === 'string' ? wsFields[1] : '';
    const stage = typeof wsFields[2] === 'string' ? wsFields[2] : '';

    if (!connectionId || !domainName || !stage) return null;

    return { clientId, connectionId, domainName, stage };
  }

  private async clearWsInfoIfSameConnection(
    appId: string,
    clientId: string,
    connectionId: string
  ): Promise<void> {
    const clientKey = buildClientKey(appId, clientId);
    const activeValue = await sendValkeyArrayCommand(['HGET', clientKey, 'ws_connection_id']);
    const activeId = activeValue === null ? '' : String(activeValue);

    if (activeId !== connectionId) return;

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

  async broadcast(params: RadiusBroadcastParams): Promise<RadiusBroadcastResult> {
    const { appId, eventId, message, lat, lon, radiusM, limit = DEFAULT_LIMIT } = params;
    const geoClientsKey = buildGeoClientsKey(appId);

    console.log('radius broadcast start', { appId, eventId, lat, lon, radiusM, limit, geoClientsKey });

    // 1. Find nearby clients via Valkey GEOSEARCH
    const nearbyResponse = await sendValkeyArrayCommand([
      'GEOSEARCH',
      geoClientsKey,
      'FROMLONLAT',
      lon,
      lat,
      'BYRADIUS',
      radiusM,
      'm',
      'COUNT',
      limit,
      'ASC',
    ]);

    const nearbyClientIds = Array.isArray(nearbyResponse)
      ? nearbyResponse.filter((v): v is string => typeof v === 'string')
      : [];

    console.log('radius broadcast geosearch result', {
      appId,
      nearbyClientCount: nearbyClientIds.length,
      nearbyClientIds,
      rawResponse: nearbyResponse,
    });

    // 2. Resolve active WebSocket connection info for each client
    const wsInfosRaw = await Promise.all(
      nearbyClientIds.map((clientId) => this.getClientWsInfo(appId, clientId))
    );
    const wsInfos = wsInfosRaw.filter((item): item is WsInfo => item !== null);

    console.log('radius broadcast ws info resolved', {
      appId,
      candidateCount: wsInfos.length,
      skippedCount: nearbyClientIds.length - wsInfos.length,
      candidates: wsInfos.map((i) => ({
        clientId: i.clientId,
        connectionId: i.connectionId,
        domainName: i.domainName,
        stage: i.stage,
      })),
    });

    // 3. Send to all connections in parallel via wsSender
    const sendResult: WsSendResult = await wsSender.send(appId, eventId, message, wsInfos);

    console.log('radius broadcast send result', {
      appId,
      deliveredCount: sendResult.deliveredCount,
      failedCount: sendResult.failedCount,
      goneConnectionIds: sendResult.goneConnectionIds,
    });

    // 4. Clean up stale Valkey entries for gone connections
    if (sendResult.goneConnectionIds.length > 0) {
      const wsInfoByConnectionId = new Map(wsInfos.map((info) => [info.connectionId, info]));

      await Promise.all(
        sendResult.goneConnectionIds.map(async (connectionId) => {
          const info = wsInfoByConnectionId.get(connectionId);
          if (info) {
            await this.clearWsInfoIfSameConnection(appId, info.clientId, connectionId);
          }
        })
      );
    }

    return {
      nearbyClientCount: nearbyClientIds.length,
      websocketCandidateCount: wsInfos.length,
      deliveredCount: sendResult.deliveredCount,
      failedCount: sendResult.failedCount,
    };
  }
}

// Module-level singleton — reused across warm Lambda invocations.
export const radiusBroadcaster = new RadiusBroadcaster();
