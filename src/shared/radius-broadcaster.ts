import { debugLog } from './debug-log';
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

// Find nearby clients and resolve their WebSocket connections in ONE round trip.
//
// This used to be a GEOSEARCH followed by one HMGET per client returned. The
// HMGETs were issued through Promise.all, which reads as though they run in
// parallel — but valkey-client.ts keeps a single command in flight and queues
// the rest, so they were strictly sequential. Fifty nearby clients meant
// fifty-one serial round trips, on a path invoked once per SPaT message per
// app, at roughly 10 Hz per sensor.
//
// Both lookups belong to one logical read anyway, so doing them server-side
// also makes the result self-consistent: no client can connect or drop between
// the geo search and the field fetch.
//
// The derived client keys are not declared in KEYS[]. That is safe on the
// single-node replication group this deploys against, but it is the one thing
// that would have to change first if the cache ever moved to cluster mode,
// where every key a script touches must hash to the same slot.
const NEARBY_WS_CLIENTS_LUA = `
local ids = redis.call('GEOSEARCH', KEYS[1],
  'FROMLONLAT', ARGV[1], ARGV[2],
  'BYRADIUS', ARGV[3], 'm',
  'COUNT', ARGV[4], 'ASC')

local connected = {}
for i = 1, #ids do
  local fields = redis.call('HMGET', ARGV[5] .. ids[i],
    'ws_connection_id', 'ws_domain_name', 'ws_stage')
  if fields[1] and fields[2] and fields[3] then
    connected[#connected + 1] = ids[i]
    connected[#connected + 1] = fields[1]
    connected[#connected + 1] = fields[2]
    connected[#connected + 1] = fields[3]
  end
end

-- Returns the total found alongside the connected subset, so the caller can
-- still report how many clients were nearby but had no live socket.
return { #ids, connected }
`;

export class RadiusBroadcaster {
  private async findNearbyWsClients(
    appId: string,
    lat: number,
    lon: number,
    radiusM: number,
    limit: number
  ): Promise<{ nearbyClientCount: number; wsInfos: WsInfo[] }> {
    const response = await sendValkeyArrayCommand([
      'EVAL',
      NEARBY_WS_CLIENTS_LUA,
      1,
      buildGeoClientsKey(appId),
      lon,
      lat,
      radiusM,
      limit,
      `msight:${ZONE_ID}:${appId}:client:`,
    ]);

    if (!Array.isArray(response) || response.length < 2) {
      return { nearbyClientCount: 0, wsInfos: [] };
    }

    const nearbyClientCount = Number(response[0]) || 0;
    const flat = Array.isArray(response[1]) ? response[1] : [];

    const wsInfos: WsInfo[] = [];
    for (let index = 0; index + 3 < flat.length; index += 4) {
      const [clientId, connectionId, domainName, stage] = flat.slice(index, index + 4);
      if (
        typeof clientId === 'string' &&
        typeof connectionId === 'string' &&
        typeof domainName === 'string' &&
        typeof stage === 'string'
      ) {
        wsInfos.push({ clientId, connectionId, domainName, stage });
      }
    }

    return { nearbyClientCount, wsInfos };
  }

  private async clearWsInfoIfSameConnection(
    appId: string,
    clientId: string,
    connectionId: string
  ): Promise<void> {
    const clientKey = buildClientKey(appId, clientId);
    // Atomic check-and-delete via Lua script — prevents a reconnect that writes
    // a new ws_connection_id between HGET and HDEL from being silently wiped.
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

  async broadcast(params: RadiusBroadcastParams): Promise<RadiusBroadcastResult> {
    const { appId, eventId, message, lat, lon, radiusM, limit = DEFAULT_LIMIT } = params;

    debugLog('radius broadcast start', {
      appId,
      eventId,
      lat,
      lon,
      radiusM,
      limit,
      geoClientsKey: buildGeoClientsKey(appId),
    });

    // 1. Find nearby clients and their live sockets — a single round trip.
    const { nearbyClientCount, wsInfos } = await this.findNearbyWsClients(
      appId,
      lat,
      lon,
      radiusM,
      limit
    );

    debugLog('radius broadcast lookup result', {
      appId,
      nearbyClientCount,
      candidateCount: wsInfos.length,
      skippedCount: nearbyClientCount - wsInfos.length,
      candidates: wsInfos.map((info) => ({
        clientId: info.clientId,
        connectionId: info.connectionId,
        domainName: info.domainName,
        stage: info.stage,
      })),
    });

    // 2. Send to all connections in parallel via wsSender
    const sendResult: WsSendResult = await wsSender.send(appId, eventId, message, wsInfos);

    debugLog('radius broadcast send result', {
      appId,
      deliveredCount: sendResult.deliveredCount,
      failedCount: sendResult.failedCount,
      goneConnectionIds: sendResult.goneConnectionIds,
    });

    // 3. Clean up stale Valkey entries for gone connections
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
      nearbyClientCount,
      websocketCandidateCount: wsInfos.length,
      deliveredCount: sendResult.deliveredCount,
      failedCount: sendResult.failedCount,
    };
  }
}

// Module-level singleton — reused across warm Lambda invocations.
export const radiusBroadcaster = new RadiusBroadcaster();
