import { sendValkeyArrayCommand, type ValkeyResponse } from '../../../shared/valkey-client';
import {
  ValkeyKeyResponseSchema,
  ValkeyOverviewResponseSchema,
} from '../../../shared/schemas/admin';
import { listSensors } from './sensor-registry';
import { HttpError } from '../../../shared/admin-api/http';

const ZONE_ID = 'zone01';

/**
 * Every operation on this page is confined to the application's own namespace.
 * A console that can touch arbitrary keys in a shared cache is a much bigger
 * blast radius than anything the debugging use case needs.
 */
const KEY_PREFIX = 'msight:';

/** Bounded reads only — a collection key could hold a great many members. */
const MAX_MEMBERS = 50;
const MAX_VALUE_BYTES = 64 * 1024;

function asString(value: ValkeyResponse): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

function asNumber(value: ValkeyResponse): number {
  if (typeof value === 'number') return value;
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function requireKey(key?: string): string {
  if (!key || !key.startsWith(KEY_PREFIX)) {
    throw new HttpError(
      400,
      'key_out_of_scope',
      `Keys must start with "${KEY_PREFIX}". The console cannot reach outside this application's namespace.`
    );
  }
  if (key.length > 512) {
    throw new HttpError(400, 'key_too_long', 'Key exceeds 512 characters.');
  }
  // Newlines would let a key smuggle extra protocol lines.
  if (/[\r\n]/.test(key)) {
    throw new HttpError(400, 'invalid_key', 'Key contains a line break.');
  }
  return key;
}

function configuredApps(): string[] {
  return (process.env.CLIENT_APP_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Sensor names come from the registry, which is the same table the reconciler
 * builds infrastructure from. Reading them from deploy config instead would
 * make this page silently blind to any sensor added from the console.
 */
async function registeredSensors(): Promise<string[]> {
  return (await listSensors()).map((row) => row.name);
}

/** Parses the flat `field:value` text that INFO returns. */
function parseInfo(raw: string | null): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of (raw ?? '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf(':');
    if (index > 0) parsed[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return parsed;
}

/**
 * The values worth putting on a dashboard, assembled from keys we can name
 * without scanning: app IDs come from configuration and sensor names from the
 * registry, so every key below is constructed rather than discovered.
 */
export async function getOverview() {
  const [infoRaw, dbSize] = await Promise.all([
    sendValkeyArrayCommand(['INFO']),
    sendValkeyArrayCommand(['DBSIZE']),
  ]);

  const info = parseInfo(asString(infoRaw));
  const hits = Number(info.keyspace_hits ?? 0);
  const misses = Number(info.keyspace_misses ?? 0);

  const apps = configuredApps();
  const sensors = await registeredSensors();
  const now = Math.floor(Date.now() / 1000);

  const appRows = await Promise.all(
    apps.map(async (appId) => {
      const geoKey = `msight:${ZONE_ID}:${appId}:geo:clients`;
      const expiryKey = `msight:${ZONE_ID}:${appId}:expires:clients`;
      const [connected, overdue] = await Promise.all([
        sendValkeyArrayCommand(['ZCARD', geoKey]),
        sendValkeyArrayCommand(['ZCOUNT', expiryKey, '-inf', String(now)]),
      ]);
      return {
        app_id: appId,
        geo_key: geoKey,
        connected: asNumber(connected),
        expired_not_reaped: asNumber(overdue),
      };
    })
  );

  // The rate-limiter key doubles as a last-seen timestamp per sensor, which is
  // the clearest answer to "is this sensor actually delivering SPaT right now".
  const sensorRows = await Promise.all(
    sensors.map(async (sensor) => {
      const key = `msight:spat:last_ts:${sensor}`;
      const [value, ttl] = await Promise.all([
        sendValkeyArrayCommand(['GET', key]),
        sendValkeyArrayCommand(['TTL', key]),
      ]);
      const raw = asString(value);
      const lastTs = raw === null ? null : Number.parseFloat(raw);
      return {
        sensor,
        key,
        last_seen_epoch: lastTs !== null && Number.isFinite(lastTs) ? lastTs : null,
        seconds_ago:
          lastTs !== null && Number.isFinite(lastTs)
            ? Math.max(0, Math.round(Date.now() / 1000 - lastTs))
            : null,
        ttl_seconds: asNumber(ttl),
      };
    })
  );

  const accounted =
    appRows.reduce((sum, row) => sum + row.connected * 2, 0) + sensorRows.filter((r) => r.last_seen_epoch !== null).length;

  return ValkeyOverviewResponseSchema.parse({
    cluster: {
      used_memory: info.used_memory_human ?? 'unknown',
      connected_clients: Number(info.connected_clients ?? 0),
      evicted_keys: Number(info.evicted_keys ?? 0),
      keyspace_hits: hits,
      keyspace_misses: misses,
      hit_rate: hits + misses > 0 ? hits / (hits + misses) : null,
      total_keys: asNumber(dbSize),
    },
    apps: appRows,
    sensors: sensorRows,
    // Rough: counts the keys the known families imply. A large gap means keys
    // exist that this page knows nothing about.
    approx_accounted_keys: accounted,
    fetched_at: new Date().toISOString(),
  });
}

/** Flat hash reply (field, value, …) to an object. */
function hashToObject(reply: ValkeyResponse): Record<string, string> {
  if (!Array.isArray(reply)) return {};
  const result: Record<string, string> = {};
  for (let i = 0; i + 1 < reply.length; i += 2) {
    result[String(reply[i])] = String(reply[i + 1]);
  }
  return result;
}

/**
 * Reads one key, choosing the right command from its actual type. Collection
 * reads are always bounded, so inspecting a large set cannot stall the server
 * that the SPaT broadcast path shares.
 */
export async function inspectKey(keyRaw?: string) {
  const key = requireKey(keyRaw);

  const [typeReply, ttlReply] = await Promise.all([
    sendValkeyArrayCommand(['TYPE', key]),
    sendValkeyArrayCommand(['TTL', key]),
  ]);

  const type = asString(typeReply) ?? 'none';
  const ttl = asNumber(ttlReply);

  if (type === 'none') {
    return ValkeyKeyResponseSchema.parse({
      key,
      type: 'none',
      exists: false,
      ttl_seconds: -2,
      string_value: null,
      entries: [],
      truncated: false,
      fetched_at: new Date().toISOString(),
    });
  }

  let stringValue: string | null = null;
  let entries: Array<{ member: string; value: string | null }> = [];
  let truncated = false;

  if (type === 'string') {
    stringValue = asString(await sendValkeyArrayCommand(['GET', key]));
  } else if (type === 'hash') {
    const fields = hashToObject(await sendValkeyArrayCommand(['HGETALL', key]));
    entries = Object.entries(fields)
      .slice(0, MAX_MEMBERS)
      .map(([member, value]) => ({ member, value }));
    truncated = Object.keys(fields).length > MAX_MEMBERS;
  } else if (type === 'zset') {
    const reply = await sendValkeyArrayCommand([
      'ZRANGE',
      key,
      '0',
      String(MAX_MEMBERS - 1),
      'WITHSCORES',
    ]);
    const flat = Array.isArray(reply) ? reply : [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      entries.push({ member: String(flat[i]), value: String(flat[i + 1]) });
    }
    truncated = asNumber(await sendValkeyArrayCommand(['ZCARD', key])) > MAX_MEMBERS;
  } else if (type === 'set') {
    const reply = await sendValkeyArrayCommand(['SSCAN', key, '0', 'COUNT', String(MAX_MEMBERS)]);
    const members = Array.isArray(reply) && Array.isArray(reply[1]) ? reply[1] : [];
    entries = members.slice(0, MAX_MEMBERS).map((member) => ({
      member: String(member),
      value: null,
    }));
    truncated = asNumber(await sendValkeyArrayCommand(['SCARD', key])) > MAX_MEMBERS;
  } else if (type === 'list') {
    const reply = await sendValkeyArrayCommand(['LRANGE', key, '0', String(MAX_MEMBERS - 1)]);
    const members = Array.isArray(reply) ? reply : [];
    entries = members.map((member) => ({ member: String(member), value: null }));
    truncated = asNumber(await sendValkeyArrayCommand(['LLEN', key])) > MAX_MEMBERS;
  }

  return ValkeyKeyResponseSchema.parse({
    key,
    type,
    exists: true,
    ttl_seconds: ttl,
    string_value: stringValue,
    entries,
    truncated,
    fetched_at: new Date().toISOString(),
  });
}

function auditWrite(operation: string, key: string, actor: string, detail?: unknown) {
  console.log(
    JSON.stringify({ event: 'admin_valkey_write', operation, key, actor, detail: detail ?? null })
  );
}

export async function setStringValue(input: {
  key?: string;
  value: string;
  ttlSeconds?: number | null;
  actor: string;
}) {
  const key = requireKey(input.key);

  if (Buffer.byteLength(input.value, 'utf8') > MAX_VALUE_BYTES) {
    throw new HttpError(400, 'value_too_large', 'Value exceeds 64 KB.');
  }

  const command = ['SET', key, input.value];
  if (input.ttlSeconds && input.ttlSeconds > 0) {
    command.push('EX', String(Math.floor(input.ttlSeconds)));
  }

  await sendValkeyArrayCommand(command);
  auditWrite('set', key, input.actor, { ttl_seconds: input.ttlSeconds ?? null });
  return { key, applied: 'set' as const };
}

export async function setHashField(input: {
  key?: string;
  field: string;
  value: string;
  actor: string;
}) {
  const key = requireKey(input.key);
  if (!input.field || /[\r\n]/.test(input.field)) {
    throw new HttpError(400, 'invalid_field', 'A hash field name is required.');
  }

  await sendValkeyArrayCommand(['HSET', key, input.field, input.value]);
  auditWrite('hset', key, input.actor, { field: input.field });
  return { key, applied: 'hset' as const };
}

/** Sets an expiry, or removes one when `seconds` is null. */
export async function setExpiry(input: {
  key?: string;
  seconds: number | null;
  actor: string;
}) {
  const key = requireKey(input.key);

  if (input.seconds === null) {
    await sendValkeyArrayCommand(['PERSIST', key]);
    auditWrite('persist', key, input.actor);
    return { key, applied: 'persist' as const };
  }

  if (!Number.isFinite(input.seconds) || input.seconds <= 0) {
    throw new HttpError(400, 'invalid_ttl', 'TTL must be a positive number of seconds.');
  }

  await sendValkeyArrayCommand(['EXPIRE', key, String(Math.floor(input.seconds))]);
  auditWrite('expire', key, input.actor, { seconds: input.seconds });
  return { key, applied: 'expire' as const };
}

/**
 * Deletes exactly one key. There is deliberately no pattern delete: the only
 * safe unit here is a single named key an operator has just inspected.
 */
export async function deleteKey(input: { key?: string; actor: string }) {
  const key = requireKey(input.key);

  // Capture what is about to disappear, so the audit line is a recovery path.
  const before = await inspectKey(key).catch(() => null);
  const removed = asNumber(await sendValkeyArrayCommand(['DEL', key]));

  if (removed === 0) {
    throw new HttpError(404, 'key_not_found', 'That key does not exist.');
  }

  auditWrite('del', key, input.actor, {
    type: before?.type ?? 'unknown',
    string_value: before?.string_value ?? null,
    entries: before?.entries ?? [],
  });

  return { key, applied: 'del' as const };
}
