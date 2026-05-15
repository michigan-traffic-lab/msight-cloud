#!/usr/bin/env node

const {
  RDSDataClient,
  ExecuteStatementCommand,
} = require('@aws-sdk/client-rds-data');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function getArg(args, key, envKey, defaultValue = undefined) {
  return args[key] ?? process.env[envKey] ?? defaultValue;
}

function requireArg(args, key, envKey) {
  const value = getArg(args, key, envKey);
  if (!value) {
    throw new Error(
      `Missing required parameter: --${key} or environment variable ${envKey}`
    );
  }
  return value;
}

async function executeSql(client, params, label, sql) {
  console.log(`\n==> ${label}`);
  await client.send(
    new ExecuteStatementCommand({
      ...params,
      sql,
    })
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const clusterArn = requireArg(args, 'cluster-arn', 'DB_CLUSTER_ARN');
  const secretArn = requireArg(args, 'secret-arn', 'DB_SECRET_ARN');
  const database = getArg(args, 'db-name', 'DB_NAME', 'msight');
  const region = requireArg(args, 'region', 'AWS_REGION');

  console.log('Configuration:');
  console.log(`  region      = ${region}`);
  console.log(`  cluster arn = ${clusterArn}`);
  console.log(`  secret arn  = ${secretArn}`);
  console.log(`  database    = ${database}`);

  const client = new RDSDataClient({ region });

  const baseParams = {
    resourceArn: clusterArn,
    secretArn,
    database,
  };

  // One statement per call. This is the safe pattern for Aurora Serverless v2.
  const statements = [
    {
      label: 'Enable PostGIS extension',
      sql: `CREATE EXTENSION IF NOT EXISTS postgis;`,
    },
    {
      label: 'Create apps table',
      sql: `
        CREATE TABLE IF NOT EXISTS apps (
          app_id       TEXT PRIMARY KEY,
          display_name TEXT NULL,
          receive_sdsm BOOLEAN NOT NULL DEFAULT FALSE,
          receive_spat BOOLEAN NOT NULL DEFAULT FALSE,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `,
    },
    {
      label: 'Add receive_spat column (idempotent migration)',
      sql: `ALTER TABLE apps ADD COLUMN IF NOT EXISTS receive_spat BOOLEAN NOT NULL DEFAULT FALSE;`,
    },
    {
      label: 'Create maps table',
      sql: `
        CREATE TABLE IF NOT EXISTS maps (
          id         BIGSERIAL    PRIMARY KEY,
          name       TEXT         NOT NULL UNIQUE,
          data       JSONB        NOT NULL,
          center     GEOGRAPHY(Point, 4326) NOT NULL,
          created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        );
      `,
    },
    {
      label: 'Create maps center spatial index',
      sql: `
        CREATE INDEX IF NOT EXISTS maps_center_idx
          ON maps USING GIST (center);
      `,
    },
    {
      label: 'Create maps name index',
      sql: `
        CREATE INDEX IF NOT EXISTS maps_name_idx
          ON maps (name);
      `,
    },
  ];

  for (const stmt of statements) {
    await executeSql(client, baseParams, stmt.label, stmt.sql);
  }

  console.log('\n==> Verify apps table');
  const appsResult = await client.send(
    new ExecuteStatementCommand({
      ...baseParams,
      sql: `
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'apps'
        ORDER BY ordinal_position;
      `,
      includeResultMetadata: true,
    })
  );

  const appsColumnCount = appsResult.records ? appsResult.records.length : 0;
  console.log(`  apps column count = ${appsColumnCount}`);

  console.log('\n==> Verify maps table');
  const mapsResult = await client.send(
    new ExecuteStatementCommand({
      ...baseParams,
      sql: `
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'maps'
        ORDER BY ordinal_position;
      `,
      includeResultMetadata: true,
    })
  );

  const mapsColumnCount = mapsResult.records ? mapsResult.records.length : 0;
  console.log(`  maps column count = ${mapsColumnCount}`);

  console.log('\n==> Verify maps indexes');
  const mapsIndexResult = await client.send(
    new ExecuteStatementCommand({
      ...baseParams,
      sql: `
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'maps'
        ORDER BY indexname;
      `,
      includeResultMetadata: true,
    })
  );

  const mapsIndexNames = (mapsIndexResult.records ?? []).map(
    (row) => row[0].stringValue
  );
  console.log(`  maps indexes = ${mapsIndexNames.join(', ')}`);

  console.log('\nDatabase initialization completed successfully.');
}

main().catch((error) => {
  console.error('\nDatabase initialization failed.');
  console.error(error);
  process.exit(1);
});