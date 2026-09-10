import { HttpError } from '../../../shared/admin-api/http';
import { getPool } from './db';
import { configuredApps, fleetCounts } from './clients';

/**
 * The `apps` registry — who receives what.
 *
 * An app is a consumer of this stack's output: a fleet of clients that connects
 * over the WebSocket API and asks to be told about things near it. Three
 * independent subscriptions decide what it is sent, and each one is read on a
 * hot path by a different consumer:
 *
 *   receive_sdsm          — the per-sensor Fargate consumers, ~10 Hz per sensor
 *   receive_spat          — the SPaT Lambda
 *   receive_critical_spat — the critical SPaT Lambda
 *
 * Which makes this table quietly load-bearing: a flag flipped here changes what
 * real vehicles are told, and getting it wrong fails silently — messages simply
 * stop, with no error anywhere. That is why apps had been editable only through
 * the raw Aurora grid, and also why a grid is the wrong place for it.
 *
 * The table itself is created by `tools/init-db.js`, alongside `maps` and the
 * PostGIS extension, rather than on demand here. A missing table means that
 * step has not been run, and inventing one silently would hide a deployment
 * problem behind a page that looks empty but healthy.
 */

/** Matches what `clients.ts` will accept, so a registered app is inspectable. */
const APP_ID_PATTERN = /^[A-Za-z0-9._:-]{2,128}$/;

/**
 * Bounds the Valkey work one page load can cause. Apps are counted in tens, so
 * this is a guard against a surprise rather than an expected limit.
 */
const MAX_COUNTED_APPS = 100;

export interface AppRow {
  app_id: string;
  display_name: string | null;
  receive_sdsm: boolean;
  receive_spat: boolean;
  receive_critical_spat: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `app_id, display_name, receive_sdsm, receive_spat,
                        receive_critical_spat, created_at, updated_at`;

function toRow(row: Record<string, unknown>): AppRow {
  return {
    app_id: String(row.app_id),
    display_name: row.display_name === null ? null : String(row.display_name),
    receive_sdsm: Boolean(row.receive_sdsm),
    receive_spat: Boolean(row.receive_spat),
    receive_critical_spat: Boolean(row.receive_critical_spat),
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}

/** Postgres reports a missing relation as 42P01. */
function isMissingTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '42P01';
}

async function query(sql: string, params: unknown[] = []) {
  const pool = await getPool();
  try {
    return await pool.query(sql, params);
  } catch (error) {
    if (isMissingTable(error)) {
      throw new HttpError(
        500,
        'apps_table_missing',
        'The apps table does not exist in this database. It is created by the ' +
          'one-time `node tools/init-db.js` step, along with maps and PostGIS.'
      );
    }
    throw error;
  }
}

export async function listAppRows(): Promise<AppRow[]> {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM apps ORDER BY app_id`);
  return rows.map(toRow);
}

async function requireApp(appId: string): Promise<AppRow> {
  const { rows } = await query(`SELECT ${SELECT_COLUMNS} FROM apps WHERE app_id = $1`, [appId]);
  if (rows.length === 0) {
    throw new HttpError(404, 'app_not_found', `No app registered as "${appId}".`);
  }
  return toRow(rows[0]);
}

/**
 * How long a subscription change takes to reach the consumers.
 *
 * They cache the app list rather than querying Aurora per message — the SDSM
 * path alone runs at roughly 10 Hz per sensor, and uncached it held the cluster
 * at its connection ceiling. The cost of that is staleness, and it is the first
 * thing anyone flipping a toggle needs to know, so it is reported rather than
 * left to be discovered.
 */
function configCacheTtlSeconds(): number {
  const parsed = Number.parseInt(process.env.CONFIG_CACHE_TTL_SECONDS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

/**
 * The registry, with each app's live fleet alongside.
 *
 * Counts come from the app ids in the table, never from a keyspace scan — the
 * registry is the known list that makes a bounded read possible.
 */
export async function listApps() {
  const rows = await listAppRows();

  const counted = rows.slice(0, MAX_COUNTED_APPS).map((row) => row.app_id);

  // Best effort, deliberately. The registry is the point of this page and lives
  // in Aurora; the fleet counts are a nicety that lives in Valkey. Letting a
  // Valkey problem throw would take out the whole page — and the Overview card
  // with it — over a number, and leave an operator unable to see or change
  // subscriptions during exactly the sort of incident when they need to.
  let countsById = new Map<string, Awaited<ReturnType<typeof fleetCounts>>[number]>();
  let countsError: string | null = null;
  try {
    countsById = new Map((await fleetCounts(counted)).map((count) => [count.app_id, count]));
  } catch (error) {
    countsError = error instanceof Error ? error.message : 'Valkey did not answer.';
    console.error(
      JSON.stringify({ event: 'app_fleet_counts_unavailable', message: countsError })
    );
  }

  // Apps the Live clients page may drill into. Separate from the registry on
  // purpose — that page predates this one and reads its list from deploy
  // config, so the two can disagree, and each direction of disagreement means
  // something different.
  const inspectable = new Set(configuredApps());

  const apps = rows.map((row) => {
    const counts = countsById.get(row.app_id);
    return {
      ...row,
      /** The Live clients page can inspect this app's fleet. */
      inspectable: inspectable.has(row.app_id),
      connected: counts?.connected ?? null,
      expiring_within_60s: counts?.expiring_within_60s ?? null,
      expired_not_yet_reaped: counts?.expired_not_yet_reaped ?? null,
      /** No subscription at all: it connects, and is told nothing. */
      receives_nothing:
        !row.receive_sdsm && !row.receive_spat && !row.receive_critical_spat,
    };
  });

  return {
    apps,
    /**
     * Configured for live-client inspection but absent from the registry. Such
     * an app receives nothing — the consumers read this table, not the config —
     * so this is a real misconfiguration rather than a cosmetic mismatch.
     */
    unregistered_app_ids: [...inspectable].filter(
      (appId) => !rows.some((row) => row.app_id === appId)
    ),
    total_connected: apps.reduce((sum, app) => sum + (app.connected ?? 0), 0),
    counts_capped: rows.length > MAX_COUNTED_APPS,
    /** Set when the fleet counts could not be read; the registry is still good. */
    counts_error: countsError,
    config_cache_ttl_seconds: configCacheTtlSeconds(),
    fetched_at: new Date().toISOString(),
  };
}

export async function addApp(input: {
  appId: string;
  displayName?: string | null;
  receiveSdsm?: boolean;
  receiveSpat?: boolean;
  receiveCriticalSpat?: boolean;
  actor: string;
}): Promise<AppRow> {
  if (!APP_ID_PATTERN.test(input.appId)) {
    throw new HttpError(
      400,
      'invalid_app_id',
      'App ids must be 2-128 characters of letters, digits, dot, underscore, ' +
        'colon or hyphen. Clients present this value when they connect, so it ' +
        'cannot be changed afterwards.'
    );
  }

  const existing = await query('SELECT 1 FROM apps WHERE app_id = $1', [input.appId]);
  if (existing.rowCount && existing.rowCount > 0) {
    throw new HttpError(409, 'app_exists', `An app called "${input.appId}" already exists.`);
  }

  await query(
    `INSERT INTO apps (app_id, display_name, receive_sdsm, receive_spat, receive_critical_spat)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.appId,
      input.displayName ?? null,
      input.receiveSdsm ?? false,
      input.receiveSpat ?? false,
      input.receiveCriticalSpat ?? false,
    ]
  );

  console.log(
    JSON.stringify({
      event: 'app_added',
      actor: input.actor,
      app_id: input.appId,
      receive_sdsm: input.receiveSdsm ?? false,
      receive_spat: input.receiveSpat ?? false,
      receive_critical_spat: input.receiveCriticalSpat ?? false,
    })
  );

  return requireApp(input.appId);
}

/**
 * Changes an app's name or its subscriptions.
 *
 * Every field is optional and absent means "leave alone", so the console sends
 * only the toggle that was touched rather than restating the row — restating is
 * how a stale form silently reverts someone else's change.
 *
 * `app_id` is deliberately not updatable: clients present it when they connect
 * and it is embedded in the Valkey keys holding their live state, so renaming
 * would orphan a fleet rather than move it.
 */
export async function updateApp(input: {
  appId: string;
  displayName?: string | null;
  receiveSdsm?: boolean;
  receiveSpat?: boolean;
  receiveCriticalSpat?: boolean;
  actor: string;
}): Promise<AppRow> {
  const current = await requireApp(input.appId);

  const assignments: string[] = [];
  const params: unknown[] = [input.appId];

  const push = (column: string, value: unknown) => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  };

  if (input.displayName !== undefined) push('display_name', input.displayName);
  if (input.receiveSdsm !== undefined) push('receive_sdsm', input.receiveSdsm);
  if (input.receiveSpat !== undefined) push('receive_spat', input.receiveSpat);
  if (input.receiveCriticalSpat !== undefined) {
    push('receive_critical_spat', input.receiveCriticalSpat);
  }

  if (assignments.length === 0) return current;

  await query(
    `UPDATE apps SET ${assignments.join(', ')}, updated_at = NOW() WHERE app_id = $1`,
    params
  );

  // Attributable because every one of these changes what live clients are sent,
  // and the effect is invisible until someone notices messages stopped.
  console.log(
    JSON.stringify({
      event: 'app_updated',
      actor: input.actor,
      app_id: input.appId,
      changed: assignments.map((assignment) => assignment.split(' ')[0]),
    })
  );

  return requireApp(input.appId);
}

/**
 * Removes an app.
 *
 * Its connected clients are not disconnected — they hold WebSocket connections
 * this has no reach into, and their Valkey entries expire on their own TTL.
 * What stops immediately, once the consumers' cache turns over, is being sent
 * anything.
 */
export async function removeApp(input: { appId: string; actor: string }): Promise<void> {
  const result = await query('DELETE FROM apps WHERE app_id = $1', [input.appId]);
  if (result.rowCount === 0) {
    throw new HttpError(404, 'app_not_found', `No app registered as "${input.appId}".`);
  }
  console.log(
    JSON.stringify({ event: 'app_removed', actor: input.actor, app_id: input.appId })
  );
}
