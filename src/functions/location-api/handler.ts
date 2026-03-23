import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  AckResponseSchema,
  HealthResponseSchema,
  LocationUpdateRequestSchema,
  type LocationUpdateRequest,
} from '../../shared/schemas/location';

const secretsClient = new SecretsManagerClient({});

let poolPromise: Promise<Pool> | null = null;

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

async function loadDbCredentials(): Promise<{
  username: string;
  password: string;
}> {
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) {
    throw new Error('DB_SECRET_ARN is not set');
  }

  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  if (!result.SecretString) {
    throw new Error('Database secret does not contain SecretString');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.SecretString);
  } catch {
    throw new Error('Database secret is not valid JSON');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('username' in parsed) ||
    !('password' in parsed) ||
    typeof parsed.username !== 'string' ||
    typeof parsed.password !== 'string'
  ) {
    throw new Error(
      'Database secret must contain string fields: username, password'
    );
  }

  return {
    username: parsed.username,
    password: parsed.password,
  };
}

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      try {
        const host = process.env.DB_HOST;
        const port = Number(process.env.DB_PORT ?? '5432');
        const database = process.env.DB_NAME;

        if (!host) throw new Error('DB_HOST is not set');
        if (!database) throw new Error('DB_NAME is not set');

        const { username, password } = await loadDbCredentials();

        const pool = new Pool({
          host,
          port,
          database,
          user: username,
          password,
          ssl: { rejectUnauthorized: false },
          max: 4,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });

        pool.on('error', (err) => {
          console.error('Unexpected PostgreSQL pool error:', err);
        });

        return pool;
      } catch (error) {
        poolPromise = null;
        throw error;
      }
    })();
  }

  return poolPromise;
}

function computeExpiresAt(eventTimestamp: Date): Date {
  const ttlSeconds = Number(process.env.LOCATION_TTL_SECONDS ?? '120');
  return new Date(eventTimestamp.getTime() + ttlSeconds * 1000);
}

async function upsertClientLocation(request: LocationUpdateRequest): Promise<void> {
  const pool = await getPool();
  const eventTimestamp = new Date(request.timestamp);
  const expiresAt = computeExpiresAt(eventTimestamp);

  console.log('DB write start', {
    host: process.env.DB_HOST,
    dbName: process.env.DB_NAME,
    secretArn: process.env.DB_SECRET_ARN,
    appId: request.app_id,
    clientId: request.client_id,
    timestamp: request.timestamp,
  });

  const result = await pool.query(
    `
    INSERT INTO client_locations (
      app_id,
      client_id,
      event_timestamp,
      expires_at,
      lat,
      lon,
      alt,
      horizontal_accuracy_m,
      vertical_accuracy_m,
      confidence,
      speed_mps,
      speed_accuracy_mps,
      heading_deg,
      heading_accuracy_deg,
      fix_type,
      satellites_visible,
      hdop,
      vdop,
      pdop,
      source,
      position,
      payload,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      ST_SetSRID(ST_MakePoint($21, $22), 4326)::geography,
      $23::jsonb,
      NOW()
    )
    ON CONFLICT (app_id, client_id)
    DO UPDATE SET
      event_timestamp = EXCLUDED.event_timestamp,
      expires_at = EXCLUDED.expires_at,
      lat = EXCLUDED.lat,
      lon = EXCLUDED.lon,
      alt = EXCLUDED.alt,
      horizontal_accuracy_m = EXCLUDED.horizontal_accuracy_m,
      vertical_accuracy_m = EXCLUDED.vertical_accuracy_m,
      confidence = EXCLUDED.confidence,
      speed_mps = EXCLUDED.speed_mps,
      speed_accuracy_mps = EXCLUDED.speed_accuracy_mps,
      heading_deg = EXCLUDED.heading_deg,
      heading_accuracy_deg = EXCLUDED.heading_accuracy_deg,
      fix_type = EXCLUDED.fix_type,
      satellites_visible = EXCLUDED.satellites_visible,
      hdop = EXCLUDED.hdop,
      vdop = EXCLUDED.vdop,
      pdop = EXCLUDED.pdop,
      source = EXCLUDED.source,
      position = EXCLUDED.position,
      payload = EXCLUDED.payload,
      updated_at = NOW()
    `,
    [
      request.app_id,
      request.client_id,
      request.timestamp,
      expiresAt.toISOString(),
      request.location.lat,
      request.location.lon,
      request.location.alt ?? null,
      request.location.horizontal_accuracy_m ?? null,
      request.location.vertical_accuracy_m ?? null,
      request.location.confidence ?? null,
      request.location.speed_mps ?? null,
      request.location.speed_accuracy_mps ?? null,
      request.location.heading_deg ?? null,
      request.location.heading_accuracy_deg ?? null,
      request.location.fix_type ?? null,
      request.location.satellites_visible ?? null,
      request.location.hdop ?? null,
      request.location.vdop ?? null,
      request.location.pdop ?? null,
      request.location.source ?? null,
      request.location.lon,
      request.location.lat,
      JSON.stringify(request),
    ]
  );

  console.log('DB write finished', {
    rowCount: result.rowCount,
    command: result.command,
  });
}

function mapDatabaseError(error: unknown): {
  statusCode: number;
  body: Record<string, unknown>;
} {
  const err = error as {
    code?: string;
    message?: string;
    name?: string;
  };

  console.error('Database error:', error);

  if (err.code === 'ETIMEDOUT') {
    return {
      statusCode: 503,
      body: {
        error: 'database_timeout',
        message: 'Database connection timed out.',
      },
    };
  }

  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return {
      statusCode: 503,
      body: {
        error: 'database_unavailable',
        message: 'Database is currently unavailable.',
      },
    };
  }

  if (err.code === '28P01') {
    return {
      statusCode: 500,
      body: {
        error: 'database_auth_failed',
        message: 'Database authentication failed.',
      },
    };
  }

  if (err.code === '3D000') {
    return {
      statusCode: 500,
      body: {
        error: 'database_not_found',
        message: 'Configured database does not exist.',
      },
    };
  }

  if (err.code === '23514') {
    return {
      statusCode: 400,
      body: {
        error: 'database_constraint_violation',
        message:
          'Request data violates a database check constraint.',
      },
    };
  }

  if (err.code === '22P02') {
    return {
      statusCode: 400,
      body: {
        error: 'database_invalid_text_representation',
        message: 'Request data has an invalid database value format.',
      },
    };
  }

  if (err.code === '23502') {
    return {
      statusCode: 500,
      body: {
        error: 'database_not_null_violation',
        message: 'Database rejected a required field as null.',
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: 'database_write_failed',
      message: 'Failed to persist location update.',
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
      const mapped = mapDatabaseError(error);
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