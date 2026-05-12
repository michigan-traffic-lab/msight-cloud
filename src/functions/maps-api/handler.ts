import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { Pool } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  MapsByNameResponseSchema,
  MapsSearchQuerySchema,
  MapsSearchResponseSchema,
  type MapRecord,
} from '../../shared/schemas/maps';

const secretsClient = new SecretsManagerClient({});

let poolPromise: Promise<Pool> | null = null;

function jsonResponse(
  statusCode: number,
  body: unknown
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function loadDbCredentials(): Promise<{ username: string; password: string }> {
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) throw new Error('DB_SECRET_ARN is not set');

  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  if (!result.SecretString) {
    throw new Error('Database secret does not contain SecretString');
  }

  const parsed = JSON.parse(result.SecretString) as {
    username?: unknown;
    password?: unknown;
  };

  if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
    throw new Error('Database secret must contain string fields: username, password');
  }

  return { username: parsed.username, password: parsed.password };
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
          max: 2,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });

        pool.on('error', (error) => {
          console.error('Unexpected PostgreSQL pool error:', error);
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

// Selects columns shared between both query types.
const SELECT_MAP_COLUMNS = `
  id,
  name,
  data,
  ST_Y(center::geometry) AS center_lat,
  ST_X(center::geometry) AS center_lon,
  created_at,
  updated_at
`;

function rowToMapRecord(row: Record<string, unknown>): MapRecord {
  return {
    id: Number(row.id),
    name: row.name as string,
    data: row.data,
    center_lat: Number(row.center_lat),
    center_lon: Number(row.center_lon),
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

async function getMapByName(name: string): Promise<MapRecord | null> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT ${SELECT_MAP_COLUMNS} FROM maps WHERE name = $1 LIMIT 1`,
    [name]
  );
  if (result.rows.length === 0) return null;
  return rowToMapRecord(result.rows[0]);
}

async function searchMapsByRadius(
  lat: number,
  lon: number,
  radiusM: number
): Promise<MapRecord[]> {
  const pool = await getPool();
  // ST_MakePoint(lon, lat) — PostGIS uses (x=lon, y=lat)
  const result = await pool.query(
    `SELECT ${SELECT_MAP_COLUMNS}
     FROM maps
     WHERE ST_DWithin(center, ST_MakePoint($2, $1)::geography, $3)
     ORDER BY ST_Distance(center, ST_MakePoint($2, $1)::geography)`,
    [lat, lon, radiusM]
  );
  return result.rows.map(rowToMapRecord);
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  // GET /v1/maps/search?lat=&lon=&radius=
  if (method === 'GET' && path === '/v1/maps/search') {
    const qs = event.queryStringParameters ?? {};
    const parsed = MapsSearchQuerySchema.safeParse(qs);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'validation_error',
        message: 'Query parameters failed validation.',
        details: parsed.error.flatten(),
      });
    }

    const { lat, lon, radius } = parsed.data;

    try {
      const maps = await searchMapsByRadius(lat, lon, radius);
      const response = MapsSearchResponseSchema.parse({
        status: 'ok',
        count: maps.length,
        maps,
        query: { lat, lon, radius_m: radius },
        server_timestamp: new Date().toISOString(),
      });
      return jsonResponse(200, response);
    } catch (error) {
      console.error('maps search error', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        lat, lon, radius,
      });
      return jsonResponse(500, {
        error: 'db_error',
        message: 'Failed to query maps from database.',
      });
    }
  }

  // GET /v1/maps/{name}
  if (method === 'GET' && path.startsWith('/v1/maps/')) {
    const name = decodeURIComponent(event.pathParameters?.name ?? '');

    if (!name) {
      return jsonResponse(400, {
        error: 'missing_param',
        message: 'Map name is required.',
      });
    }

    try {
      const map = await getMapByName(name);
      if (!map) {
        return jsonResponse(404, {
          error: 'not_found',
          message: `No map found with name: ${name}`,
        });
      }

      const response = MapsByNameResponseSchema.parse({
        status: 'ok',
        map,
        server_timestamp: new Date().toISOString(),
      });
      return jsonResponse(200, response);
    } catch (error) {
      console.error('maps get-by-name error', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name,
      });
      return jsonResponse(500, {
        error: 'db_error',
        message: 'Failed to query map from database.',
      });
    }
  }

  return jsonResponse(404, {
    error: 'not_found',
    message: `No route for ${method} ${path} in maps-api`,
  });
}
