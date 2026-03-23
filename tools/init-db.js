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
      label: 'Create PostGIS extension',
      sql: `
        CREATE EXTENSION IF NOT EXISTS postgis;
      `,
    },
    {
      label: 'Create client_locations table',
      sql: `
        CREATE TABLE IF NOT EXISTS client_locations (
          app_id TEXT NOT NULL,
          client_id TEXT NOT NULL,

          event_timestamp TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,

          lat DOUBLE PRECISION NOT NULL,
          lon DOUBLE PRECISION NOT NULL,
          alt DOUBLE PRECISION NULL,

          horizontal_accuracy_m DOUBLE PRECISION NULL,
          vertical_accuracy_m DOUBLE PRECISION NULL,

          confidence DOUBLE PRECISION NULL,

          speed_mps DOUBLE PRECISION NULL,
          speed_accuracy_mps DOUBLE PRECISION NULL,

          heading_deg DOUBLE PRECISION NULL,
          heading_accuracy_deg DOUBLE PRECISION NULL,

          fix_type TEXT NULL,
          satellites_visible INTEGER NULL,

          hdop DOUBLE PRECISION NULL,
          vdop DOUBLE PRECISION NULL,
          pdop DOUBLE PRECISION NULL,

          source TEXT NULL,

          position GEOGRAPHY(POINT, 4326) NOT NULL,

          payload JSONB NOT NULL,

          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

          PRIMARY KEY (app_id, client_id),

          CONSTRAINT client_locations_lat_range
            CHECK (lat >= -90 AND lat <= 90),

          CONSTRAINT client_locations_lon_range
            CHECK (lon >= -180 AND lon <= 180),

          CONSTRAINT client_locations_confidence_range
            CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),

          CONSTRAINT client_locations_speed_mps_nonnegative
            CHECK (speed_mps IS NULL OR speed_mps >= 0),

          CONSTRAINT client_locations_speed_accuracy_mps_nonnegative
            CHECK (speed_accuracy_mps IS NULL OR speed_accuracy_mps >= 0),

          CONSTRAINT client_locations_heading_deg_range
            CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg <= 360)),

          CONSTRAINT client_locations_heading_accuracy_deg_nonnegative
            CHECK (heading_accuracy_deg IS NULL OR heading_accuracy_deg >= 0),

          CONSTRAINT client_locations_horizontal_accuracy_positive
            CHECK (horizontal_accuracy_m IS NULL OR horizontal_accuracy_m > 0),

          CONSTRAINT client_locations_vertical_accuracy_positive
            CHECK (vertical_accuracy_m IS NULL OR vertical_accuracy_m > 0),

          CONSTRAINT client_locations_satellites_visible_nonnegative
            CHECK (satellites_visible IS NULL OR satellites_visible >= 0),

          CONSTRAINT client_locations_hdop_nonnegative
            CHECK (hdop IS NULL OR hdop >= 0),

          CONSTRAINT client_locations_vdop_nonnegative
            CHECK (vdop IS NULL OR vdop >= 0),

          CONSTRAINT client_locations_pdop_nonnegative
            CHECK (pdop IS NULL OR pdop >= 0),

          CONSTRAINT client_locations_fix_type_valid
            CHECK (
              fix_type IS NULL OR
              fix_type IN ('unknown', '2d', '3d', 'dgps', 'rtk_float', 'rtk_fixed', 'ppp')
            ),

          CONSTRAINT client_locations_source_valid
            CHECK (
              source IS NULL OR
              source IN ('gps', 'network', 'fused', 'manual', 'unknown')
            )
        );
      `,
    },
    {
      label: 'Create geo index on position',
      sql: `
        CREATE INDEX IF NOT EXISTS client_locations_position_gix
          ON client_locations
          USING GIST (position);
      `,
    },
    {
      label: 'Create expires_at index',
      sql: `
        CREATE INDEX IF NOT EXISTS client_locations_expires_at_idx
          ON client_locations (expires_at);
      `,
    },
    {
      label: 'Create event_timestamp index',
      sql: `
        CREATE INDEX IF NOT EXISTS client_locations_event_timestamp_idx
          ON client_locations (event_timestamp);
      `,
    },
    {
      label: 'Create client_id index',
      sql: `
        CREATE INDEX IF NOT EXISTS client_locations_client_id_idx
          ON client_locations (client_id);
      `,
    },
    {
      label: 'Create app_id index',
      sql: `
        CREATE INDEX IF NOT EXISTS client_locations_app_id_idx
          ON client_locations (app_id);
      `,
    },
  ];

  for (const stmt of statements) {
    await executeSql(client, baseParams, stmt.label, stmt.sql);
  }

  console.log('\n==> Verify PostGIS extension');
  const extResult = await client.send(
    new ExecuteStatementCommand({
      ...baseParams,
      sql: `
        SELECT extname, extversion
        FROM pg_extension
        WHERE extname = 'postgis';
      `,
      includeResultMetadata: true,
    })
  );

  if (extResult.records && extResult.records.length > 0) {
    const row = extResult.records[0];
    const extname = row[0]?.stringValue ?? 'postgis';
    const extversion = row[1]?.stringValue ?? 'unknown';
    console.log(`  ${extname} version = ${extversion}`);
  } else {
    console.log('  PostGIS extension query returned no rows.');
  }

  console.log('\n==> Verify client_locations table columns');
  const tableResult = await client.send(
    new ExecuteStatementCommand({
      ...baseParams,
      sql: `
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_name = 'client_locations'
        ORDER BY ordinal_position;
      `,
      includeResultMetadata: true,
    })
  );

  const columnCount = tableResult.records ? tableResult.records.length : 0;
  console.log(`  client_locations column count = ${columnCount}`);

  console.log('\nDatabase initialization completed successfully.');
}

main().catch((error) => {
  console.error('\nDatabase initialization failed.');
  console.error(error);
  process.exit(1);
});