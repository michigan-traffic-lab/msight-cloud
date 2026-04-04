import type { Context } from 'aws-lambda';
import { pingValkey, sendValkeyArrayCommand } from '../../shared/valkey-client';

type DebugAction =
  | 'ping'
  | 'get'
  | 'set'
  | 'ttl'
  | 'type'
  | 'exists'
  | 'del'
  | 'scan'
  | 'dump';

type DebugEvent = {
  action?: string;
  key?: string;
  value?: string;
  ttlSeconds?: number;
  pattern?: string;
  count?: number;
  maxKeys?: number;
};

type DebugResult = {
  ok: boolean;
  action?: DebugAction;
  result?: unknown;
  timestamp: string;
  requestId: string;
  error?: string;
};

function normalizeAction(action: string | undefined): DebugAction | null {
  if (!action) {
    return null;
  }

  const normalized = action.toLowerCase();
  if (
    normalized !== 'ping' &&
    normalized !== 'get' &&
    normalized !== 'set' &&
    normalized !== 'ttl' &&
    normalized !== 'type' &&
    normalized !== 'exists' &&
    normalized !== 'del' &&
    normalized !== 'scan' &&
    normalized !== 'dump'
  ) {
    return null;
  }

  return normalized;
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return null;
  }

  return value;
}

function success(
  requestId: string,
  action: DebugAction,
  result: unknown
): DebugResult {
  return {
    ok: true,
    action,
    result,
    timestamp: new Date().toISOString(),
    requestId,
  };
}

function failure(requestId: string, message: string): DebugResult {
  return {
    ok: false,
    error: message,
    timestamp: new Date().toISOString(),
    requestId,
  };
}

async function scanKeysByPattern(event: DebugEvent): Promise<{
  pattern: string;
  count: number;
  cursor: string;
  truncated: boolean;
  keys: string[];
}> {
  const pattern =
    typeof event?.pattern === 'string' && event.pattern.length > 0
      ? event.pattern
      : typeof event?.key === 'string' && event.key.length > 0
        ? event.key
        : '*';
  const count = asPositiveInteger(event?.count) ?? 200;
  const maxKeys = asPositiveInteger(event?.maxKeys) ?? 2000;

  let cursor = '0';
  const keys: string[] = [];

  do {
    const scanResponse = await sendValkeyArrayCommand([
      'SCAN',
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      count,
    ]);

    if (!Array.isArray(scanResponse) || scanResponse.length < 2) {
      throw new Error('Unexpected SCAN response shape from Valkey');
    }

    const nextCursorValue = scanResponse[0];
    const keyListValue = scanResponse[1];
    if (!Array.isArray(keyListValue)) {
      throw new Error('Unexpected SCAN key list shape from Valkey');
    }

    for (const keyValue of keyListValue) {
      if (typeof keyValue === 'string') {
        keys.push(keyValue);
      }

      if (keys.length >= maxKeys) {
        break;
      }
    }

    cursor = String(nextCursorValue ?? '0');
  } while (cursor !== '0' && keys.length < maxKeys);

  return {
    pattern,
    count: keys.length,
    cursor,
    truncated: cursor !== '0',
    keys,
  };
}

export async function handler(event: DebugEvent, context: Context): Promise<DebugResult> {
  const requestId = context.awsRequestId;
  const action = normalizeAction(event?.action);

  if (!action) {
    return failure(
      requestId,
      'Invalid or missing action. Use one of: ping, get, set, ttl, type, exists, del, scan, dump.'
    );
  }

  try {
    if (action === 'ping') {
      const pong = await pingValkey();
      return success(requestId, action, pong);
    }

    if (action === 'scan') {
      return success(requestId, action, await scanKeysByPattern(event));
    }

    if (action === 'dump') {
      const scanResult = await scanKeysByPattern(event);
      const entries: Array<{
        key: string;
        type: string;
        ttl: number;
        value: string | null;
        note?: string;
      }> = [];

      for (const key of scanResult.keys) {
        const keyTypeResponse = await sendValkeyArrayCommand(['TYPE', key]);
        const ttlResponse = await sendValkeyArrayCommand(['TTL', key]);
        const keyType = keyTypeResponse === null ? 'none' : String(keyTypeResponse);
        const ttl = Number(ttlResponse ?? -2);

        if (keyType === 'string') {
          const valueResponse = await sendValkeyArrayCommand(['GET', key]);
          entries.push({
            key,
            type: keyType,
            ttl,
            value: valueResponse === null ? null : String(valueResponse),
          });
          continue;
        }

        entries.push({
          key,
          type: keyType,
          ttl,
          value: null,
          note: 'non-string type; value omitted',
        });
      }

      return success(requestId, action, {
        pattern: scanResult.pattern,
        count: entries.length,
        cursor: scanResult.cursor,
        truncated: scanResult.truncated,
        entries,
      });
    }

    if (!event?.key || event.key.length === 0) {
      return failure(requestId, `Action "${action}" requires a non-empty key.`);
    }

    if (action === 'get') {
      const value = await sendValkeyArrayCommand(['GET', event.key]);
      return success(requestId, action, value === null ? null : String(value));
    }

    if (action === 'ttl') {
      const ttl = await sendValkeyArrayCommand(['TTL', event.key]);
      return success(requestId, action, Number(ttl ?? -2));
    }

    if (action === 'type') {
      const typeValue = await sendValkeyArrayCommand(['TYPE', event.key]);
      return success(requestId, action, typeValue === null ? 'none' : String(typeValue));
    }

    if (action === 'exists') {
      const existsValue = await sendValkeyArrayCommand(['EXISTS', event.key]);
      return success(requestId, action, Number(existsValue ?? 0));
    }

    if (action === 'del') {
      const deletedCount = await sendValkeyArrayCommand(['DEL', event.key]);
      return success(requestId, action, Number(deletedCount ?? 0));
    }

    if (typeof event?.value !== 'string') {
      return failure(requestId, 'Action "set" requires a string value.');
    }

    const ttlSeconds = asPositiveInteger(event.ttlSeconds);
    const setArgs = ttlSeconds
      ? ['SET', event.key, event.value, 'EX', ttlSeconds]
      : ['SET', event.key, event.value];
    const setResult = await sendValkeyArrayCommand(setArgs);
    return success(requestId, action, setResult === null ? '' : String(setResult));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(requestId, message);
  }
}