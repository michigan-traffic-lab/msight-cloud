import { Pool } from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { HttpError } from '../../../shared/admin-api/http';

/**
 * The one Aurora connection pool this function uses.
 *
 * Shared rather than one pool per service module. Three services here talk to
 * the same database through the same RDS Proxy, and a pool each meant a single
 * warm container could hold three times the connections it needs — against a
 * Serverless cluster that bills for the capacity those connections keep awake,
 * and that this stack has already had to be pulled back from the ceiling once.
 *
 * `max` stays small for the same reason. A Lambda handles one request at a
 * time, so concurrency here comes only from a handler issuing parallel queries.
 */
const secretsClient = new SecretsManagerClient({});

let poolPromise: Promise<Pool> | null = null;

async function loadCredentials(): Promise<{ username: string; password: string }> {
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) throw new HttpError(500, 'not_configured', 'DB_SECRET_ARN is not set.');

  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new HttpError(500, 'not_configured', 'Database secret has no SecretString.');
  }

  const parsed = JSON.parse(result.SecretString) as { username?: unknown; password?: unknown };
  if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
    throw new HttpError(500, 'not_configured', 'Database secret is missing username/password.');
  }
  return { username: parsed.username, password: parsed.password };
}

export async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      try {
        const host = process.env.DB_HOST;
        const database = process.env.DB_NAME;
        if (!host || !database) {
          throw new HttpError(500, 'not_configured', 'DB_HOST / DB_NAME are not set.');
        }

        const { username, password } = await loadCredentials();
        const pool = new Pool({
          host,
          port: Number(process.env.DB_PORT ?? '5432'),
          database,
          user: username,
          password,
          ssl: { rejectUnauthorized: false },
          max: 2,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });
        pool.on('error', (error) => console.error('admin-vpc-api pg pool error', error));
        return pool;
      } catch (error) {
        // Cleared so a transient Secrets Manager failure at cold start does not
        // poison every later request in the same container.
        poolPromise = null;
        throw error;
      }
    })();
  }
  return poolPromise;
}
