import type { Context, ScheduledEvent } from 'aws-lambda';
import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { sendValkeyArrayCommand } from '../../shared/valkey-client.js';

const ZONE_ID = 'zone01';
const DEFAULT_SCAN_BATCH = 100;

// ---- key builders --------------------------------------------------------

function buildExpiresClientsPattern(): string {
  // Matches keys like msight:zone01:<app_id>:expires:clients
  return `msight:${ZONE_ID}:*:expires:clients`;
}

function buildClientKey(appId: string, clientId: string): string {
  return `msight:${ZONE_ID}:${appId}:client:${clientId}`;
}

function buildGeoClientsKey(appId: string): string {
  return `msight:${ZONE_ID}:${appId}:geo:clients`;
}

function buildExpirationKey(appId: string): string {
  return `msight:${ZONE_ID}:${appId}:expires:clients`;
}

function buildWsConnectionLookupKey(connectionId: string): string {
  return `msight:${ZONE_ID}:ws:connection:${connectionId}`;
}

type ExpirationEntry = {
  clientId: string;
  expiresAtMs: number;
};

// ---- helpers -------------------------------------------------------------

/**
 * Extract app_id from a key of the form `msight:{zone}:{app_id}:expires:clients`.
 */
function parseAppIdFromExpiresKey(key: string): string | null {
  const zone = ZONE_ID;
  const prefix = `msight:${zone}:`;
  const suffix = ':expires:clients';
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) {
    return null;
  }
  return key.slice(prefix.length, key.length - suffix.length) || null;
}

/**
 * SCAN all keys matching a pattern. Returns every matching key.
 */
async function scanKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';

  do {
    const response = await sendValkeyArrayCommand([
      'SCAN',
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      DEFAULT_SCAN_BATCH,
    ]);

    if (!Array.isArray(response) || response.length < 2) {
      break;
    }

    cursor = String(response[0]);
    const batch = response[1];

    if (Array.isArray(batch)) {
      for (const k of batch) {
        if (typeof k === 'string') {
          keys.push(k);
        }
      }
    }
  } while (cursor !== '0');

  return keys;
}

function parseZRangeWithScoresResponse(response: unknown): ExpirationEntry[] {
  if (!Array.isArray(response)) {
    return [];
  }

  const parsed: ExpirationEntry[] = [];

  for (let i = 0; i < response.length - 1; i += 2) {
    const member = response[i];
    const score = response[i + 1];

    if (typeof member !== 'string') {
      continue;
    }

    const expiresAtMs = Number(score);
    if (!Number.isFinite(expiresAtMs)) {
      continue;
    }

    parsed.push({
      clientId: member,
      expiresAtMs,
    });
  }

  return parsed;
}

/**
 * Close an active WebSocket connection gracefully via API Gateway Management API.
 * Swallows GoneException (already closed) and logs other errors without throwing.
 */
async function closeWsConnection(
  connectionId: string,
  domainName: string,
  stage: string
): Promise<void> {
  const endpoint = `https://${domainName}/${stage}`;
  const client = new ApiGatewayManagementApiClient({ endpoint });

  try {
    await client.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
    console.log('expiration-cleanup: closed WS connection', { connectionId, endpoint });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes('GoneException') ||
      msg.includes('410') ||
      msg.includes('ForbiddenException') ||
      msg.includes('404')
    ) {
      // Already gone — fine
      return;
    }
    console.warn('expiration-cleanup: failed to close WS connection', {
      connectionId,
      endpoint,
      error: msg,
    });
  }
}

/**
 * Clean up a single expired client:
 *   0. Re-check ZSCORE — skip if the client sent a fresh location update since
 *      we read the expired list (race condition guard).
 *   1. Read client hash for WS info
 *   2. Close WS connection if present
 *   3. DEL the connection lookup key
 *   4. DEL the client hash
 *   5. ZREM from geo:clients and expires:clients
 */
async function cleanupExpiredClient(appId: string, clientId: string, nowMs: number): Promise<void> {
  const clientKey = buildClientKey(appId, clientId);
  const geoClientsKey = buildGeoClientsKey(appId);
  const expirationKey = buildExpirationKey(appId);

  // Guard against race condition: client may have sent a fresh location update
  // (which advances their ZADD score) between the ZRANGEBYSCORE scan and now.
  // If their score is now > nowMs, they are no longer expired — skip all
  // destructive operations so we do not wipe valid WS fields or remove them
  // from the geo index.
  const currentScore = await sendValkeyArrayCommand(['ZSCORE', expirationKey, clientId]);
  if (currentScore === null || Number(currentScore) > nowMs) {
    return;
  }

  const wsFields = await sendValkeyArrayCommand([
    'HMGET',
    clientKey,
    'ws_connection_id',
    'ws_domain_name',
    'ws_stage',
  ]);

  const connectionId =
    Array.isArray(wsFields) && typeof wsFields[0] === 'string' ? wsFields[0] : null;
  const domainName =
    Array.isArray(wsFields) && typeof wsFields[1] === 'string' ? wsFields[1] : null;
  const stage =
    Array.isArray(wsFields) && typeof wsFields[2] === 'string' ? wsFields[2] : null;

  if (connectionId && domainName && stage) {
    await closeWsConnection(connectionId, domainName, stage);
    await sendValkeyArrayCommand(['DEL', buildWsConnectionLookupKey(connectionId)]);
  }

  await sendValkeyArrayCommand(['DEL', clientKey]);
  await sendValkeyArrayCommand(['ZREM', geoClientsKey, clientId]);
  await sendValkeyArrayCommand(['ZREM', expirationKey, clientId]);
}

// ---- Lambda entry point --------------------------------------------------

export async function handler(_event: ScheduledEvent, _context: Context): Promise<void> {
  const nowMs = Date.now();
  const pattern = buildExpiresClientsPattern();

  let expiresKeys: string[];
  try {
    expiresKeys = await scanKeys(pattern);
  } catch (error) {
    console.error('expiration-cleanup: failed to scan expiration keys', { error });
    return;
  }

  if (expiresKeys.length === 0) {
    return;
  }

  let totalActive = 0;
  let totalExpired = 0;

  for (const expiresKey of expiresKeys) {
    const appId = parseAppIdFromExpiresKey(expiresKey);
    if (!appId) {
      console.warn('expiration-cleanup: could not parse app_id from key', { expiresKey });
      continue;
    }

    // ZRANGEBYSCORE returns client_ids with score (expiresAtMs) <= nowMs
    let expiredEntries: ExpirationEntry[];
    try {
      const response = await sendValkeyArrayCommand([
        'ZRANGEBYSCORE',
        expiresKey,
        '-inf',
        nowMs,
        'WITHSCORES',
      ]);
      expiredEntries = parseZRangeWithScoresResponse(response);
    } catch (error) {
      console.error('expiration-cleanup: failed to query expiration key', { expiresKey, error });
      continue;
    }

    let activeEntries: ExpirationEntry[];
    try {
      const response = await sendValkeyArrayCommand([
        'ZRANGEBYSCORE',
        expiresKey,
        `(${nowMs}`,
        '+inf',
        'WITHSCORES',
      ]);
      activeEntries = parseZRangeWithScoresResponse(response);
    } catch (error) {
      console.error('expiration-cleanup: failed to query active clients from expiration key', {
        expiresKey,
        error,
      });
      activeEntries = [];
    }

    totalActive += activeEntries.length;
    console.log('expiration-cleanup: app expiration scan counts', {
      appId,
      activeClientCount: activeEntries.length,
      expiredClientCount: expiredEntries.length,
    });

    for (const expiredEntry of expiredEntries) {
      try {
        await cleanupExpiredClient(appId, expiredEntry.clientId, nowMs);
        totalExpired++;
      } catch (error) {
        console.error('expiration-cleanup: failed to clean up client', {
          appId,
          clientId: expiredEntry.clientId,
          error,
        });
      }
    }
  }

  console.log('expiration-cleanup: run summary', {
    totalActiveClientCount: totalActive,
    totalExpiredClientCount: totalExpired,
  });
}
