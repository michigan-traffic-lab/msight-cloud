#!/usr/bin/env node
/**
 * Inserts a dummy map record into the maps table for testing.
 *
 * Usage:
 *   node tools/insert-test-map.js --cluster-arn <arn> --secret-arn <arn> --region us-east-2
 *
 * Optional overrides:
 *   --name         Map name (default: "test-intersection-ann-arbor")
 *   --lat          Center latitude  (default: 42.302615)
 *   --lon          Center longitude (default: -83.704366)
 */

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

function requireArg(args, key, envKey) {
  const value = args[key] ?? process.env[envKey];
  if (!value) throw new Error(`Missing required parameter: --${key} or ${envKey}`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const clusterArn = requireArg(args, 'cluster-arn', 'DB_CLUSTER_ARN');
  const secretArn  = requireArg(args, 'secret-arn',  'DB_SECRET_ARN');
  const database   = args['db-name']  ?? process.env.DB_NAME   ?? 'msight';
  const region     = requireArg(args, 'region', 'AWS_REGION');

  const name = args['name'] ?? 'test-intersection-ann-arbor';
  const lat  = parseFloat(args['lat'] ?? '42.302615');
  const lon  = parseFloat(args['lon'] ?? '-83.704366');

  const data = {
    type: 'intersection',
    description: 'Dummy test map for Ann Arbor intersection',
    lanes: 4,
    speed_limit_mph: 35,
    tags: ['test', 'ann-arbor'],
  };

  console.log('Inserting test map:');
  console.log(`  name   = ${name}`);
  console.log(`  lat    = ${lat}`);
  console.log(`  lon    = ${lon}`);
  console.log(`  data   = ${JSON.stringify(data)}`);

  const client = new RDSDataClient({ region });
  const baseParams = { resourceArn: clusterArn, secretArn, database };

  const result = await client.send(new ExecuteStatementCommand({
    ...baseParams,
    sql: `
      INSERT INTO maps (name, data, center)
      VALUES (
        :name,
        :data::jsonb,
        ST_MakePoint(:lon, :lat)::geography
      )
      ON CONFLICT (name) DO UPDATE
        SET data       = EXCLUDED.data,
            center     = EXCLUDED.center,
            updated_at = NOW()
      RETURNING id, name, created_at, updated_at;
    `,
    parameters: [
      { name: 'name', value: { stringValue: name } },
      { name: 'data', value: { stringValue: JSON.stringify(data) } },
      { name: 'lat',  value: { doubleValue: lat } },
      { name: 'lon',  value: { doubleValue: lon } },
    ],
    includeResultMetadata: true,
  }));

  const row = result.records?.[0];
  if (row) {
    const id         = row[0]?.longValue ?? row[0]?.stringValue;
    const returnName = row[1]?.stringValue;
    const createdAt  = row[2]?.stringValue;
    console.log(`\nInserted/updated map: id=${id}, name=${returnName}, created_at=${createdAt}`);
  }

  console.log('\nDone.');
}

main().catch((error) => {
  console.error('Failed to insert test map:', error);
  process.exit(1);
});
