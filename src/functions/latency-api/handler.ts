import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { performance } from 'node:perf_hooks';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { Pool } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  LatencyProbeResponseSchema,
  type LatencyProbeResponse,
} from '../../shared/schemas/latency';

const secretsClient = new SecretsManagerClient({});

let poolPromise: Promise<Pool> | null = null;
let valkeyConnectionPromise: Promise<ValkeyConnection> | null = null;
let valkeyCommandQueue: Promise<unknown> = Promise.resolve();

type ProbeResult = LatencyProbeResponse['probes']['valkey'];
type ValkeySocket = tls.TLSSocket | net.Socket;

type ValkeyInFlightCommand = {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
};

type ValkeyConnection = {
  socket: ValkeySocket;
  responseBuffer: string;
  inFlightCommand: ValkeyInFlightCommand | null;
};

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

function resetValkeyConnection(): void {
  valkeyConnectionPromise = null;
}

function settleValkeyInFlightCommand(
  connection: ValkeyConnection,
  outcome: { response?: string; error?: Error }
): void {
  const inFlightCommand = connection.inFlightCommand;
  if (!inFlightCommand) {
    return;
  }

  connection.inFlightCommand = null;
  clearTimeout(inFlightCommand.timeoutHandle);

  if (outcome.error) {
    inFlightCommand.reject(outcome.error);
    return;
  }

  inFlightCommand.resolve(outcome.response ?? '');
}

function processValkeyResponseBuffer(connection: ValkeyConnection): void {
  if (!connection.inFlightCommand) {
    return;
  }

  const lineTerminatorIndex = connection.responseBuffer.indexOf('\r\n');
  if (lineTerminatorIndex === -1) {
    return;
  }

  const line = connection.responseBuffer.slice(0, lineTerminatorIndex);
  connection.responseBuffer = connection.responseBuffer.slice(lineTerminatorIndex + 2);

  if (line.startsWith('+')) {
    settleValkeyInFlightCommand(connection, {
      response: line.slice(1),
    });
    return;
  }

  if (line.startsWith('-')) {
    settleValkeyInFlightCommand(connection, {
      error: new Error(line.slice(1)),
    });
    return;
  }

  settleValkeyInFlightCommand(connection, {
    error: new Error(`Unsupported Valkey response: ${line}`),
  });
}

async function createValkeyConnection(): Promise<ValkeyConnection> {
  const host = process.env.CACHE_HOST;
  const port = Number(process.env.CACHE_PORT ?? '6379');
  const useTls = (process.env.CACHE_TLS_ENABLED ?? 'true').toLowerCase() !== 'false';
  const connectTimeoutMs = Number(process.env.CACHE_CONNECT_TIMEOUT_MS ?? '5000');

  if (!host) {
    throw new Error('CACHE_HOST is not set');
  }

  return new Promise<ValkeyConnection>((resolve, reject) => {
    const socket = useTls
      ? tls.connect({ host, port, rejectUnauthorized: false })
      : net.connect({ host, port });

    const connection: ValkeyConnection = {
      socket,
      responseBuffer: '',
      inFlightCommand: null,
    };

    let settled = false;

    const connectTimeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resetValkeyConnection();
      reject(new Error(`Valkey connection timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    const finishConnection = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(connectTimeoutHandle);
      callback();
    };

    socket.on('data', (chunk) => {
      connection.responseBuffer += chunk.toString('utf8');
      processValkeyResponseBuffer(connection);
    });

    socket.on('error', (error) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));

      finishConnection(() => {
        resetValkeyConnection();
        reject(normalizedError);
      });

      settleValkeyInFlightCommand(connection, { error: normalizedError });
      resetValkeyConnection();
    });

    socket.on('close', () => {
      const closeError = new Error('Valkey connection closed');

      finishConnection(() => {
        resetValkeyConnection();
        reject(closeError);
      });

      settleValkeyInFlightCommand(connection, { error: closeError });
      resetValkeyConnection();
    });

    socket.once(useTls ? 'secureConnect' : 'connect', () => {
      finishConnection(() => resolve(connection));
    });
  });
}

async function getValkeyConnection(): Promise<ValkeyConnection> {
  if (!valkeyConnectionPromise) {
    valkeyConnectionPromise = createValkeyConnection().catch((error) => {
      resetValkeyConnection();
      throw error;
    });
  }

  return valkeyConnectionPromise;
}

async function enqueueValkeyCommand<T>(operation: () => Promise<T>): Promise<T> {
  const queuedOperation = valkeyCommandQueue.then(operation, operation);
  valkeyCommandQueue = queuedOperation.then(
    () => undefined,
    () => undefined
  );
  return queuedOperation;
}

async function sendValkeyCommand(command: string, timeoutMs: number): Promise<string> {
  return enqueueValkeyCommand(async () => {
    const connection = await getValkeyConnection();

    return new Promise<string>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        connection.socket.destroy();
        settleValkeyInFlightCommand(connection, {
          error: new Error(`Timed out after ${timeoutMs}ms`),
        });
        resetValkeyConnection();
      }, timeoutMs);

      connection.inFlightCommand = {
        resolve,
        reject,
        timeoutHandle,
      };

      connection.socket.write(command, (error) => {
        if (!error) {
          return;
        }

        settleValkeyInFlightCommand(connection, {
          error: error instanceof Error ? error : new Error(String(error)),
        });
        connection.socket.destroy();
        resetValkeyConnection();
      });
    });
  });
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
    const response = await sendValkeyCommand('*1\r\n$4\r\nPING\r\n', timeoutMs);
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