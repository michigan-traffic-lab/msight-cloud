import { Pool } from 'pg';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { MapDetailResponseSchema, MapListResponseSchema } from '../../../shared/schemas/admin';
import { HttpError } from '../../../shared/admin-api/http';

const secretsClient = new SecretsManagerClient({});
let poolPromise: Promise<Pool> | null = null;

const STATEMENT_TIMEOUT_MS = 10_000;

/** Metres per degree of latitude. Good to well under a metre at this scale. */
const METRES_PER_DEGREE_LAT = 111_320;

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      try {
        const host = process.env.DB_HOST;
        const database = process.env.DB_NAME;
        const secretArn = process.env.DB_SECRET_ARN;
        if (!host || !database || !secretArn) {
          throw new HttpError(500, 'not_configured', 'Database environment is incomplete.');
        }

        const secret = await secretsClient.send(
          new GetSecretValueCommand({ SecretId: secretArn })
        );
        const parsed = JSON.parse(secret.SecretString ?? '{}') as {
          username?: string;
          password?: string;
        };

        const pool = new Pool({
          host,
          port: Number(process.env.DB_PORT ?? '5432'),
          database,
          user: parsed.username,
          password: parsed.password,
          ssl: { rejectUnauthorized: false },
          max: 2,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });
        pool.on('error', (error) => console.error('maps pg pool error', error));
        return pool;
      } catch (error) {
        poolPromise = null;
        throw error;
      }
    })();
  }
  return poolPromise;
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[]) {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result.rows as T[];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * `laneType` and `directionalUse` are not consistently typed: the decoder emits
 * a name where it recognises the enum and a raw `[value, bitLength]` pair where
 * it does not. Both forms appear in the same message, so both must be handled.
 */
function firstName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

/**
 * Resolves travel direction from `directionalUse`.
 *
 * J2735 DirectionalUse is a 2-bit BIT STRING, MSB first: bit 0 is ingressPath,
 * bit 1 is egressPath. The decoder gives `[value, bitLength]` when it cannot
 * name the value, so `[2, 2]` is binary `10` — ingress — and `[3, 2]` is `11`,
 * meaning both, which is what the crosswalks carry.
 */
function resolveDirection(value: unknown): 'ingress' | 'egress' | 'both' | 'unknown' {
  const name = typeof value === 'string' ? value : null;
  if (name === 'ingressPath') return 'ingress';
  if (name === 'egressPath') return 'egress';

  if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') {
    const [bits, length] = value as [number, number];
    const ingress = Boolean(bits & (1 << (length - 1)));
    const egress = Boolean(bits & (1 << (length - 2)));
    if (ingress && egress) return 'both';
    if (ingress) return 'ingress';
    if (egress) return 'egress';
  }

  return 'unknown';
}

interface LanePoint {
  x: number;
  y: number;
  lat: number;
  lon: number;
}

/**
 * Walks a lane's node list.
 *
 * Node offsets are cumulative in the local frame: each delta is relative to the
 * previous node, and the first is relative to the intersection reference point.
 * Treating them as absolute would collapse every lane onto the centre.
 */
function projectLane(
  nodeList: unknown,
  refLat: number,
  refLon: number
): { points: LanePoint[]; lengthM: number } {
  // The list arrives tagged: ["nodes", [ ... ]].
  const nodes = Array.isArray(nodeList) && Array.isArray(nodeList[1]) ? nodeList[1] : [];
  const metresPerDegreeLon = METRES_PER_DEGREE_LAT * Math.cos((refLat * Math.PI) / 180);

  let x = 0;
  let y = 0;
  let length = 0;
  const points: LanePoint[] = [];

  for (const node of nodes) {
    const delta = (node as { delta?: unknown }).delta;
    const offset = Array.isArray(delta) ? (delta[1] as { x?: number; y?: number }) : null;
    if (!offset) continue;

    const dx = Number(offset.x ?? 0);
    const dy = Number(offset.y ?? 0);
    x += dx;
    y += dy;
    length += Math.hypot(dx, dy);

    points.push({
      x,
      y,
      lat: refLat + y / METRES_PER_DEGREE_LAT,
      lon: refLon + x / (metresPerDegreeLon || 1),
    });
  }

  return { points, lengthM: length };
}

/**
 * Values as node-postgres actually hands them over, which is not always what
 * the column type suggests: `int8` (BIGSERIAL) arrives as a **string** so large
 * ids cannot silently lose precision, and numerics can too. Everything numeric
 * is therefore coerced rather than trusted.
 */
interface MapRow {
  id: string | number;
  name: string;
  center_lat: string | number;
  center_lon: string | number;
  data: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const SELECT_COLUMNS = `id, name, data,
  ST_Y(center::geometry) AS center_lat,
  ST_X(center::geometry) AS center_lon,
  created_at, updated_at`;

export async function listMaps() {
  const rows = await query<MapRow>(
    `SELECT ${SELECT_COLUMNS} FROM maps ORDER BY name ASC LIMIT 200`,
    []
  );

  return MapListResponseSchema.parse({
    maps: rows.map((row) => {
      const intersection = (row.data?.intersections as Record<string, unknown>[] | undefined)?.[0];
      const lanes = (intersection?.laneSet as unknown[] | undefined) ?? [];
      return {
        id: num(row.id),
        name: row.name,
        center_lat: num(row.center_lat),
        center_lon: num(row.center_lon),
        intersection_name: (intersection?.name as string) ?? null,
        lane_count: lanes.length,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
      };
    }),
    fetched_at: new Date().toISOString(),
  });
}

/**
 * Consistency checks between the stored geometry and the columns the rest of
 * the stack actually reads. Both failure modes below are silent in production:
 * SPaT simply stops reaching clients, with only a log line to show for it.
 */
function deriveFindings(input: {
  mapName: string;
  intersectionName: string | null;
  centerLat: number;
  centerLon: number;
  refLat: number;
  refLon: number;
  lanes: Array<{ kind: string; direction: string; node_count: number; length_m: number; lane_id: number }>;
}) {
  const findings: Array<{ severity: 'info' | 'warning' | 'critical'; title: string; detail: string }> = [];

  if (input.intersectionName && input.intersectionName !== input.mapName) {
    findings.push({
      severity: 'critical',
      title: 'Row name does not match the name inside the MAP',
      detail:
        `The row is "${input.mapName}" but the message says "${input.intersectionName}". The SPaT ` +
        `consumer looks this table up by the name decoded from the SPAT message, so one of these ` +
        `will never be found and broadcasts for it are dropped silently.`,
    });
  }

  // A degree of latitude is ~111 km, so this threshold is roughly one metre.
  const drift = Math.hypot(input.centerLat - input.refLat, input.centerLon - input.refLon);
  if (drift > 0.00001) {
    const metres = Math.round(drift * METRES_PER_DEGREE_LAT);
    findings.push({
      severity: 'critical',
      title: `center column is ${metres} m from the MAP reference point`,
      detail:
        'SPaT broadcasts use the center column while the lane geometry is anchored on refPoint. ' +
        'While they disagree, messages are broadcast to the wrong place with no error raised.',
    });
  }

  const empty = input.lanes.filter((lane) => lane.node_count === 0);
  if (empty.length > 0) {
    findings.push({
      severity: 'warning',
      title: `${empty.length} lanes have no geometry`,
      detail: `Lane IDs: ${empty.map((lane) => lane.lane_id).join(', ')}. They cannot be drawn or used.`,
    });
  }

  const implausible = input.lanes.filter((lane) => lane.length_m > 2000);
  if (implausible.length > 0) {
    findings.push({
      severity: 'warning',
      title: `${implausible.length} lanes extend more than 2 km`,
      detail:
        'That usually means node offsets were interpreted in the wrong unit upstream — ' +
        `decimetres read as metres, for example. Lane IDs: ${implausible.map((l) => l.lane_id).join(', ')}.`,
    });
  }

  // Crosswalks legitimately belong to no approach, so they are exempt.
  const unassigned = input.lanes.filter(
    (lane) => lane.kind !== 'crosswalk' && lane.direction === 'unknown'
  );
  if (unassigned.length > 0) {
    findings.push({
      severity: 'info',
      title: `${unassigned.length} vehicle lanes have no direction of travel`,
      detail: `Lane IDs: ${unassigned.map((lane) => lane.lane_id).join(', ')}.`,
    });
  }

  return findings;
}

export async function getMap(name: string) {
  if (!name || name.length > 256) {
    throw new HttpError(400, 'invalid_name', 'A map name is required.');
  }

  const rows = await query<MapRow>(
    `SELECT ${SELECT_COLUMNS} FROM maps WHERE name = $1 LIMIT 1`,
    [name]
  );

  const row = rows[0];
  if (!row) {
    throw new HttpError(404, 'map_not_found', `No map named "${name}".`);
  }

  const intersection = (row.data?.intersections as Record<string, unknown>[] | undefined)?.[0];
  if (!intersection) {
    throw new HttpError(
      422,
      'malformed_map',
      'The stored MAP message contains no intersections array.'
    );
  }

  const refPoint = (intersection.refPoint ?? {}) as { lat?: number; long?: number; elevation?: number };
  const centerLat = num(row.center_lat);
  const centerLon = num(row.center_lon);
  const refLat = refPoint.lat === undefined ? centerLat : num(refPoint.lat);
  const refLon = refPoint.long === undefined ? centerLon : num(refPoint.long);

  const laneSet = (intersection.laneSet as Record<string, unknown>[] | undefined) ?? [];

  const lanes = laneSet.map((lane) => {
    const attributes = (lane.laneAttributes ?? {}) as Record<string, unknown>;
    const { points, lengthM } = projectLane(lane.nodeList, refLat, refLon);
    const kindName = firstName(attributes.laneType) ?? 'unknown';

    return {
      lane_id: num(lane.laneID ?? 0),
      arm_id: lane.arm_id === null || lane.arm_id === undefined ? null : num(lane.arm_id),
      kind: kindName,
      direction: resolveDirection(attributes.directionalUse),
      ingress_approach:
        lane.ingressApproach === null || lane.ingressApproach === undefined
          ? null
          : Number(lane.ingressApproach),
      egress_approach:
        lane.egressApproach === null || lane.egressApproach === undefined
          ? null
          : Number(lane.egressApproach),
      maneuvers: Array.isArray(lane.maneuvers) ? (lane.maneuvers as number[]) : [],
      node_count: points.length,
      length_m: Math.round(lengthM * 10) / 10,
      points,
    };
  });

  const speedLimits = (intersection.speedLimits as Array<{ type?: string; speed?: number }>) ?? [];

  return MapDetailResponseSchema.parse({
    id: num(row.id),
    name: row.name,
    center_lat: centerLat,
    center_lon: centerLon,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    intersection: {
      name: (intersection.name as string) ?? null,
      intersection_id: Number((intersection.id as { id?: number })?.id ?? 0),
      region: Number((intersection.id as { region?: number })?.region ?? 0),
      revision: Number(intersection.revision ?? 0),
      ref_lat: refLat,
      ref_lon: refLon,
      elevation: refPoint.elevation === undefined ? null : Number(refPoint.elevation),
      lane_width_m: intersection.laneWidth === undefined ? null : Number(intersection.laneWidth),
      speed_limit_mps: speedLimits[0]?.speed ?? null,
    },
    lanes,
    findings: deriveFindings({
      mapName: row.name,
      intersectionName: (intersection.name as string) ?? null,
      centerLat,
      centerLon,
      refLat,
      refLon,
      lanes,
    }),
    fetched_at: new Date().toISOString(),
  });
}
