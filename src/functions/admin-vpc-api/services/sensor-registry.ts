import { Pool } from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  converge,
  listClusterServices,
  queueDepths,
  ROUTING_ATTRIBUTE,
  type ConvergeResult,
  type SensorInfraConfig,
} from '../../../shared/sensor-infrastructure';
import { sensorQueueName, sensorServiceName } from '../../../shared/deployment-naming';
import { HttpError } from '../../../shared/admin-api/http';

const secretsClient = new SecretsManagerClient({});

let poolPromise: Promise<Pool> | null = null;

/** Sensor names double as SQS name components, so keep them conservative. */
const SENSOR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

/**
 * Resolved once per invocation rather than at module load, so a missing
 * variable surfaces as a 500 on the sensor routes instead of killing every
 * other route in this function at cold start.
 */
function infraConfig(): SensorInfraConfig {
  const required = (key: string) => {
    const value = process.env[key];
    if (!value) {
      throw new HttpError(500, 'not_configured', `${key} is not set on the in-VPC admin function.`);
    }
    return value;
  };

  return {
    deployment: required('DEPLOYMENT_NAME'),
    prefix: required('SENSOR_RESOURCE_PREFIX'),
    topicArn: required('SENSOR_TOPIC_ARN'),
    cluster: required('SENSOR_CLUSTER_NAME'),
    templateTaskDefinition: required('SENSOR_TASK_DEFINITION'),
    subnetIds: required('SENSOR_SUBNET_IDS').split(',').filter(Boolean),
    securityGroupIds: required('SENSOR_SECURITY_GROUP_IDS').split(',').filter(Boolean),
  };
}

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      try {
        const secret = await secretsClient.send(
          new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
        );
        const parsed = JSON.parse(secret.SecretString ?? '{}') as {
          username?: string;
          password?: string;
        };
        const pool = new Pool({
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT ?? '5432'),
          database: process.env.DB_NAME,
          user: parsed.username,
          password: parsed.password,
          ssl: { rejectUnauthorized: false },
          max: 2,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });
        pool.on('error', (error) => console.error('sensor-registry pg pool error', error));
        return pool;
      } catch (error) {
        poolPromise = null;
        throw error;
      }
    })();
  }
  return poolPromise;
}

/**
 * The registry table is the desired state, and it is the only source of it.
 *
 * Created on demand so a fresh deployment needs no separate migration step, and
 * created EMPTY: sensors are added from the console, never from deploy config.
 * A deploy therefore cannot resurrect a sensor an operator deleted, and cannot
 * quietly disagree with what the console shows.
 */
async function ensureTable(): Promise<void> {
  const pool = await getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sensors (
      name         TEXT PRIMARY KEY,
      display_name TEXT NULL,
      enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export interface SensorRow {
  name: string;
  display_name: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function listSensors(): Promise<SensorRow[]> {
  await ensureTable();
  const pool = await getPool();
  const { rows } = await pool.query(
    'SELECT name, display_name, enabled, created_at, updated_at FROM sensors ORDER BY name'
  );
  return rows.map((row) => ({
    name: String(row.name),
    display_name: row.display_name === null ? null : String(row.display_name),
    enabled: Boolean(row.enabled),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  }));
}

export async function addSensor(input: {
  name: string;
  displayName?: string | null;
  actor: string;
}): Promise<SensorRow> {
  if (!SENSOR_NAME_PATTERN.test(input.name)) {
    throw new HttpError(
      400,
      'invalid_sensor_name',
      'Sensor names must be 2-64 characters of letters, digits, underscore or hyphen, ' +
        'starting with a letter or digit. The name becomes part of an SQS queue name.'
    );
  }

  await ensureTable();
  const pool = await getPool();

  const existing = await pool.query('SELECT 1 FROM sensors WHERE name = $1', [input.name]);
  if (existing.rowCount && existing.rowCount > 0) {
    throw new HttpError(409, 'sensor_exists', `A sensor named "${input.name}" already exists.`);
  }

  await pool.query('INSERT INTO sensors (name, display_name) VALUES ($1, $2)', [
    input.name,
    input.displayName ?? null,
  ]);

  console.log(
    JSON.stringify({ event: 'sensor_added', actor: input.actor, sensor: input.name })
  );

  const rows = await listSensors();
  return rows.find((row) => row.name === input.name)!;
}

export async function setSensorEnabled(input: {
  name: string;
  enabled: boolean;
  actor: string;
}): Promise<void> {
  await ensureTable();
  const pool = await getPool();
  const result = await pool.query(
    'UPDATE sensors SET enabled = $1, updated_at = NOW() WHERE name = $2',
    [input.enabled, input.name]
  );
  if (result.rowCount === 0) {
    throw new HttpError(404, 'sensor_not_found', `No sensor named "${input.name}".`);
  }
  console.log(
    JSON.stringify({
      event: 'sensor_enabled_changed',
      actor: input.actor,
      sensor: input.name,
      enabled: input.enabled,
    })
  );
}

export async function removeSensor(input: { name: string; actor: string }): Promise<void> {
  await ensureTable();
  const pool = await getPool();
  const result = await pool.query('DELETE FROM sensors WHERE name = $1', [input.name]);
  if (result.rowCount === 0) {
    throw new HttpError(404, 'sensor_not_found', `No sensor named "${input.name}".`);
  }
  console.log(
    JSON.stringify({ event: 'sensor_removed', actor: input.actor, sensor: input.name })
  );
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** Converges AWS to the enabled rows in the registry. */
export async function reconcile(): Promise<ConvergeResult> {
  const config = infraConfig();
  const desired = (await listSensors()).filter((row) => row.enabled).map((row) => row.name);
  return converge(config, desired);
}

/** Actual infrastructure state per sensor, for the console to show drift. */
export async function inventory() {
  const config = infraConfig();
  const rows = await listSensors();
  const depths = await queueDepths(config);
  const services = await listClusterServices(config);

  return {
    sensors: rows.map((row) => {
      const queueName = sensorQueueName(config.prefix, row.name);
      const depth = depths.get(queueName);
      return {
        ...row,
        queue_name: queueName,
        queue_exists: depth !== undefined,
        service_exists: services.has(sensorServiceName(config.prefix, row.name)),
        messages_available: depth?.available ?? null,
        messages_in_flight: depth?.in_flight ?? null,
      };
    }),
    // Queues with no registry row: a row removed while a delete failed, or a
    // reconcile that stopped halfway. Surfaced rather than silently ignored.
    orphaned_queues: [...depths.keys()].filter(
      (queueName) => !rows.some((row) => sensorQueueName(config.prefix, row.name) === queueName)
    ),
    topic_arn: config.topicArn,
    routing_attribute: ROUTING_ATTRIBUTE,
    cluster: config.cluster,
    fetched_at: new Date().toISOString(),
  };
}
