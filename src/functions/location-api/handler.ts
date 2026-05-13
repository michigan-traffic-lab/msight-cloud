import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { randomUUID } from 'crypto';
import {
  AckResponseSchema,
  HealthResponseSchema,
  LocationUpdateRequestSchema,
  type LocationUpdateRequest,
} from '../../shared/schemas/location';
import { sendValkeyArrayCommand } from '../../shared/valkey-client.js';

const ZONE_ID = 'zone01';
const DEFAULT_LOCATION_TTL_SECONDS = 30 * 60;

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

function getLocationTtlSeconds(): number {
  return Number(process.env.LOCATION_TTL_SECONDS ?? String(DEFAULT_LOCATION_TTL_SECONDS));
}

function buildGeoClientsKey(appId: string): string {
  return `msight:${ZONE_ID}:${appId}:geo:clients`;
}

function buildClientKey(appId: string, clientId: string): string {
  return `msight:${ZONE_ID}:${appId}:client:${clientId}`;
}

function buildExpirationKey(appId: string): string {
  return `msight:${ZONE_ID}:${appId}:expires:clients`;
}

function buildClientHashFields(
  request: LocationUpdateRequest,
  expiresAtIso: string,
  expiresAtEpochMs: number
): Array<string | number> {
  const location = request.location;

  return [
    'app_id', request.app_id,
    'client_id', request.client_id,
    'zone_id', ZONE_ID,
    'timestamp', request.timestamp,
    'expires_at', expiresAtIso,
    'expires_at_epoch_ms', expiresAtEpochMs,
    'lat', location.lat,
    'lon', location.lon,
    'payload', JSON.stringify(request),
    'updated_at', new Date().toISOString(),
    'alt', location.alt ?? '',
    'horizontal_accuracy_m', location.horizontal_accuracy_m ?? '',
    'vertical_accuracy_m', location.vertical_accuracy_m ?? '',
    'confidence', location.confidence ?? '',
    'speed_mps', location.speed_mps ?? '',
    'speed_accuracy_mps', location.speed_accuracy_mps ?? '',
    'heading_deg', location.heading_deg ?? '',
    'heading_accuracy_deg', location.heading_accuracy_deg ?? '',
    'fix_type', location.fix_type ?? '',
    'satellites_visible', location.satellites_visible ?? '',
    'hdop', location.hdop ?? '',
    'vdop', location.vdop ?? '',
    'pdop', location.pdop ?? '',
    'source', location.source ?? '',
  ];
}

async function upsertClientLocation(request: LocationUpdateRequest): Promise<void> {
  const ttlSeconds = getLocationTtlSeconds();
  const expiresAtEpochMs = Date.now() + ttlSeconds * 1000;
  const expiresAtIso = new Date(expiresAtEpochMs).toISOString();
  const geoClientsKey = buildGeoClientsKey(request.app_id);
  const clientKey = buildClientKey(request.app_id, request.client_id);
  const expirationKey = buildExpirationKey(request.app_id);

  console.log('Valkey write start', {
    cacheHost: process.env.CACHE_HOST,
    appId: request.app_id,
    clientId: request.client_id,
    zoneId: ZONE_ID,
    geoClientsKey,
    clientKey,
    expirationKey,
  });

  await sendValkeyArrayCommand([
    'GEOADD',
    geoClientsKey,
    request.location.lon,
    request.location.lat,
    request.client_id,
  ]);

  await sendValkeyArrayCommand([
    'HSET',
    clientKey,
    ...buildClientHashFields(request, expiresAtIso, expiresAtEpochMs),
  ]);

  await sendValkeyArrayCommand([
    'ZADD',
    expirationKey,
    expiresAtEpochMs,
    request.client_id,
  ]);

  console.log('Valkey write finished', {
    appId: request.app_id,
    clientId: request.client_id,
    expiresAt: expiresAtIso,
  });
}

function mapCacheError(error: unknown): {
  statusCode: number;
  body: Record<string, unknown>;
} {
  const message = error instanceof Error ? error.message : 'Unknown cache failure';

  console.error('Valkey error:', error);

  if (message.includes('Timed out')) {
    return {
      statusCode: 503,
      body: {
        error: 'cache_timeout',
        message: 'Valkey connection timed out.',
      },
    };
  }

  if (
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND') ||
    message.includes('closed') ||
    message.includes('CACHE_HOST is not set')
  ) {
    return {
      statusCode: 503,
      body: {
        error: 'cache_unavailable',
        message: 'Valkey is currently unavailable.',
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: 'cache_write_failed',
      message: 'Failed to persist location update in Valkey.',
    },
  };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const apiVersion = process.env.API_VERSION ?? 'v1.0';
  const serviceName = process.env.SERVICE_NAME ?? 'location-api';

  if (method === 'GET' && path === '/v1/clients/location/health') {
    const response = HealthResponseSchema.parse({
      status: 'ok',
      message: 'Location API is healthy.',
      service: serviceName,
      api_version: apiVersion,
      server_timestamp: new Date().toISOString(),
    });

    return jsonResponse(200, response);
  }

  if (method === 'POST' && path === '/v1/clients/location/update') {
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

    const parsed = LocationUpdateRequestSchema.safeParse(parsedJson);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'validation_error',
        message: 'Request body failed schema validation.',
        details: parsed.error.flatten(),
      });
    }

    try {
      await upsertClientLocation(parsed.data);
    } catch (error) {
      const mapped = mapCacheError(error);
      return jsonResponse(mapped.statusCode, {
        ...mapped.body,
        server_timestamp: new Date().toISOString(),
        api_version: apiVersion,
      });
    }

    const response = AckResponseSchema.parse({
      status: 'accepted',
      message: 'Location update accepted.',
      request_id: randomUUID(),
      server_timestamp: new Date().toISOString(),
      api_version: apiVersion,
    });

    return jsonResponse(200, response);
  }

  return jsonResponse(404, {
    error: 'not_found',
    message: `No route for ${method} ${path} in location-api`,
  });
}