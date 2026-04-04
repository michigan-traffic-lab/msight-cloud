import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  LatencyProbeResponseSchema,
  type LatencyProbeResponse,
} from '../../shared/schemas/latency';
import { pingValkey } from '../../shared/valkey-client.js';

const secretsClient = new SecretsManagerClient({});

let poolPromise: Promise<Pool> | null = null;

type ProbeResult = LatencyProbeResponse['probes']['valkey'];

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

  const parsed = JSON.parse(result.SecretString) as {
    username?: unknown;
    password?: unknown;
  };

  if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
    throw new Error('Database secret must contain string fields: username, password');
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

function formatProbeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown probe failure';
}

async function probePostgreSql(): Promise<ProbeResult> {
  const startedAt = performance.now();
  try {
    const pool = await getPool();
    await pool.query('SELECT 1');

    return {
      status: 'ok',
      latency_ms: Number((performance.now() - startedAt).toFixed(3)),
    };
  } catch (error) {
    return {
      status: 'error',
      latency_ms: null,
      error: formatProbeError(error),
    };
  }
}

async function probeValkey(): Promise<ProbeResult> {
  const timeoutMs = Number(process.env.CACHE_TIMEOUT_MS ?? '5000');

  const startedAt = performance.now();
  try {
    const response = await pingValkey(timeoutMs);
    if (response !== 'PONG') {
      throw new Error(`Unexpected Valkey PING response: ${response}`);
    }

    return {
      status: 'ok',
      latency_ms: Number((performance.now() - startedAt).toFixed(3)),
    };
  } catch (error) {
    return {
      status: 'error',
      latency_ms: null,
      error: formatProbeError(error),
    };
  }
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const apiVersion = process.env.API_VERSION ?? 'v1';
  const serviceName = process.env.SERVICE_NAME ?? 'latency-api';
  const buildId = process.env.BUILD_ID ?? 'unknown';

  if (method !== 'GET' || path !== '/v1/client/latency') {
    return jsonResponse(404, {
      error: 'not_found',
      message: `No route for ${method} ${path} in latency-api`,
    });
  }

  const receiveEpochMs = Date.now();

  const clientSentAt = event.queryStringParameters?.client_sent_at;
  const clientSequence = event.queryStringParameters?.seq;

  const [valkeyProbe, postgreSqlProbe] = await Promise.all([
    probeValkey(),
    probePostgreSql(),
  ]);

  const hasProbeFailure =
    valkeyProbe.status === 'error' || postgreSqlProbe.status === 'error';

  const response = LatencyProbeResponseSchema.parse({
    status: hasProbeFailure ? 'degraded' : 'ok',
    message: hasProbeFailure
      ? 'Latency probe completed with one or more backend failures.'
      : 'Latency probe response generated.',
    request_id: event.requestContext.requestId,
    service: serviceName,
    api_version: apiVersion,
    build_id: buildId,
    server_received_timestamp: new Date(receiveEpochMs).toISOString(),
    server_response_timestamp: new Date().toISOString(),
    connectivity: {
      source_ip: event.requestContext.http.sourceIp ?? 'unknown',
      user_agent: event.requestContext.http.userAgent ?? 'unknown',
      protocol: event.requestContext.http.protocol,
      stage: event.requestContext.stage,
      domain_name: event.requestContext.domainName,
    },
    echo: {
      client_sent_at: clientSentAt,
      seq: clientSequence,
    },
    probes: {
      valkey: valkeyProbe,
      postgresql: postgreSqlProbe,
    },
  });

  return jsonResponse(200, response);
}