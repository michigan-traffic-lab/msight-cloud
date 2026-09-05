import { sendValkeyArrayCommand, type ValkeyResponse } from '../../../shared/valkey-client';
import {
  LiveClientsQueryResponseSchema,
  LiveClientsSummaryResponseSchema,
} from '../../../shared/schemas/admin';
import { HttpError } from '../../../shared/admin-api/http';

/**
 * Key layout, mirroring location-api and radius-broadcaster. Kept in sync by
 * hand because those functions own the write path; a mismatch shows up as an
 * empty console rather than a crash, so the shapes are asserted in tests.
 */
const ZONE_ID = 'zone01';

const geoKey = (appId: string) => `msight:${ZONE_ID}:${appId}:geo:clients`;
const clientKey = (appId: string, clientId: string) =>
  `msight:${ZONE_ID}:${appId}:client:${clientId}`;
const expiryKey = (appId: string) => `msight:${ZONE_ID}:${appId}:expires:clients`;

/**
 * Hard ceiling on anything that returns a list.
 *
 * The console shares this Valkey with the SPaT broadcast path, which is
 * latency-sensitive and single-threaded. No console request may issue an
 * unbounded command — no KEYS, no uncapped SCAN, no uncapped GEOSEARCH.
 */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function clampLimit(raw?: string): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function asNumber(value: ValkeyResponse): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function requireAppId(appId?: string): string {
  if (!appId || !/^[A-Za-z0-9._:-]{1,128}$/.test(appId)) {
    throw new HttpError(
      400,
      'invalid_app_id',
      'A valid app_id is required. Get the list from the summary endpoint.'
    );
  }
  return appId;
}

/** Apps the console knows about, from configuration rather than a key scan. */
export function configuredApps(): string[] {
  return (process.env.CLIENT_APP_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * Fleet counts per app. ZCARD is constant time and ZCOUNT is logarithmic, so
 * this endpoint's cost does not grow with the number of connected clients —
 * which is the whole reason the page leads with counts rather than a list.
 */
export async function getSummary() {
  const apps = configuredApps();
  const now = Math.floor(Date.now() / 1000);

  const rows = await Promise.all(
    apps.map(async (appId) => {
      const [connected, expiringSoon, overdue] = await Promise.all([
        sendValkeyArrayCommand(['ZCARD', geoKey(appId)]),
        sendValkeyArrayCommand(['ZCOUNT', expiryKey(appId), String(now), String(now + 60)]),
        sendValkeyArrayCommand(['ZCOUNT', expiryKey(appId), '-inf', String(now)]),
      ]);

      return {
        app_id: appId,
        connected: asNumber(connected),
        expiring_within_60s: asNumber(expiringSoon),
        expired_not_yet_reaped: asNumber(overdue),
      };
    })
  );

  return LiveClientsSummaryResponseSchema.parse({
    zone_id: ZONE_ID,
    apps: rows,
    total_connected: rows.reduce((sum, row) => sum + row.connected, 0),
    fetched_at: new Date().toISOString(),
  });
}

/** Flat Valkey hash reply (field, value, field, value, …) to an object. */
function hashToObject(reply: ValkeyResponse): Record<string, string> {
  if (!Array.isArray(reply)) return {};
  const result: Record<string, string> = {};
  for (let i = 0; i + 1 < reply.length; i += 2) {
    result[String(reply[i])] = String(reply[i + 1]);
  }
  return result;
}

async function hydrate(appId: string, ids: string[]) {
  return Promise.all(
    ids.map(async (clientId) => {
      const fields = hashToObject(
        await sendValkeyArrayCommand(['HGETALL', clientKey(appId, clientId)])
      );
      const lat = fields.lat !== undefined ? Number.parseFloat(fields.lat) : NaN;
      const lon = fields.lon !== undefined ? Number.parseFloat(fields.lon) : NaN;

      return {
        client_id: clientId,
        app_id: appId,
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
        distance_m: null as number | null,
        fields,
      };
    })
  );
}

/**
 * Clients within a radius, using the same GEOSEARCH the broadcast path uses.
 * Always sent with COUNT so Valkey bounds the work, not the caller.
 */
export async function searchRadius(params: {
  appId?: string;
  lat?: string;
  lon?: string;
  radiusM?: string;
  limit?: string;
}) {
  const appId = requireAppId(params.appId);
  const lat = Number.parseFloat(params.lat ?? '');
  const lon = Number.parseFloat(params.lon ?? '');
  const radius = Number.parseFloat(params.radiusM ?? '500');

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new HttpError(400, 'invalid_position', 'lat and lon must be numbers.');
  }
  if (!Number.isFinite(radius) || radius <= 0 || radius > 50_000) {
    throw new HttpError(400, 'invalid_radius', 'radius_m must be between 1 and 50000.');
  }

  const limit = clampLimit(params.limit);

  const reply = await sendValkeyArrayCommand([
    'GEOSEARCH',
    geoKey(appId),
    'FROMLONLAT',
    String(lon),
    String(lat),
    'BYRADIUS',
    String(radius),
    'm',
    'ASC',
    'COUNT',
    String(limit),
    'WITHDIST',
  ]);

  const entries = Array.isArray(reply) ? reply : [];
  const ids: string[] = [];
  const distances = new Map<string, number>();

  for (const entry of entries) {
    if (Array.isArray(entry)) {
      const id = String(entry[0]);
      ids.push(id);
      distances.set(id, asNumber(entry[1]));
    } else {
      ids.push(String(entry));
    }
  }

  const clients = (await hydrate(appId, ids)).map((client) => ({
    ...client,
    distance_m: distances.get(client.client_id) ?? null,
  }));

  return LiveClientsQueryResponseSchema.parse({
    app_id: appId,
    mode: 'radius',
    limit,
    capped: ids.length >= limit,
    clients,
    next_cursor: null,
    fetched_at: new Date().toISOString(),
  });
}

/**
 * A bounded page of clients, for eyeballing rather than enumerating. Uses ZSCAN
 * on the geo set so iteration is incremental and never blocks the server, and
 * returns a cursor so the caller can continue if it genuinely needs to.
 */
export async function sampleClients(params: {
  appId?: string;
  cursor?: string;
  limit?: string;
}) {
  const appId = requireAppId(params.appId);
  const limit = clampLimit(params.limit);
  const cursor = /^\d+$/.test(params.cursor ?? '') ? (params.cursor as string) : '0';

  const reply = await sendValkeyArrayCommand([
    'ZSCAN',
    geoKey(appId),
    cursor,
    'COUNT',
    String(limit),
  ]);

  const nextCursor = Array.isArray(reply) ? String(reply[0]) : '0';
  const flat = Array.isArray(reply) && Array.isArray(reply[1]) ? reply[1] : [];

  // ZSCAN returns member, score, member, score — scores are geohashes, not
  // coordinates, so positions come from the client hash instead.
  const ids: string[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    ids.push(String(flat[i]));
  }

  return LiveClientsQueryResponseSchema.parse({
    app_id: appId,
    mode: 'sample',
    limit,
    capped: nextCursor !== '0',
    clients: await hydrate(appId, ids.slice(0, limit)),
    next_cursor: nextCursor === '0' ? null : nextCursor,
    fetched_at: new Date().toISOString(),
  });
}

/** One client by id. O(1) — the right path when you already know the device. */
export async function lookupClient(params: { appId?: string; clientId?: string }) {
  const appId = requireAppId(params.appId);
  const clientId = params.clientId ?? '';

  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) {
    throw new HttpError(400, 'invalid_client_id', 'A valid client_id is required.');
  }

  const clients = (await hydrate(appId, [clientId])).filter(
    (client) => Object.keys(client.fields).length > 0
  );

  return LiveClientsQueryResponseSchema.parse({
    app_id: appId,
    mode: 'lookup',
    limit: 1,
    capped: false,
    clients,
    next_cursor: null,
    fetched_at: new Date().toISOString(),
  });
}
