import { type PoolClient } from 'pg';
import {
  AuroraQueryResponseSchema,
  AuroraRowsResponseSchema,
  AuroraTablesResponseSchema,
} from '../../../shared/schemas/admin';
import { HttpError } from '../../../shared/admin-api/http';
import { getPool } from './db';

/**
 * Columns an operator may change, by table.
 *
 * An allowlist rather than "any column": both tables feed the SPaT broadcast
 * path, and a bad value fails silently rather than loudly. `maps.data` (a MAP
 * message) and `maps.center` (a PostGIS point) are deliberately absent — a
 * generic grid is the wrong place to edit either, and malformed geometry breaks
 * broadcasts with no error anywhere.
 */
const EDITABLE_COLUMNS: Record<string, string[]> = {
  apps: ['display_name', 'receive_sdsm', 'receive_spat', 'receive_critical_spat'],
};

/**
 * Tables a row may be deleted from.
 *
 * Deliberately separate from EDITABLE_COLUMNS: "may change this field" and "may
 * remove this record entirely" are different privileges, and a table can
 * reasonably allow one without the other. Anything absent here cannot be
 * deleted through the console at all.
 */
const DELETABLE_TABLES = new Set(['apps', 'maps']);

/** Bounds every read. The client cannot raise these. */
const MAX_ROWS = 200;
const DEFAULT_ROWS = 50;
const STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Runs `work` inside a transaction that Postgres itself refuses to let write.
 *
 * This — not inspection of the SQL text — is what makes the query runner safe.
 * READ ONLY makes the server reject INSERT/UPDATE/DELETE/DDL, including inside
 * data-modifying CTEs, which is exactly the case a keyword filter misses.
 * statement_timeout bounds the cost of anything that is merely expensive.
 */
async function inReadOnlyTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function clampLimit(raw?: string): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ROWS;
  return Math.min(parsed, MAX_ROWS);
}

/**
 * Identifiers cannot be parameterized, so a table or column name is only ever
 * used after matching it against what the catalog actually reports. Nothing
 * derived from user input is concatenated into SQL unchecked.
 */
function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new HttpError(400, 'invalid_identifier', `Not a valid identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export async function listTables() {
  const tables = await inReadOnlyTransaction(async (client) => {
    const result = await client.query(
      `SELECT c.relname AS table_name,
              c.reltuples::bigint AS estimated_rows,
              pg_total_relation_size(c.oid) AS total_bytes,
              (SELECT count(*) FROM information_schema.columns col
                WHERE col.table_schema = 'public' AND col.table_name = c.relname) AS column_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
      []
    );

    return result.rows.map((row) => ({
      name: String(row.table_name),
      estimated_rows: Number(row.estimated_rows ?? 0),
      total_bytes: Number(row.total_bytes ?? 0),
      column_count: Number(row.column_count ?? 0),
      editable_columns: EDITABLE_COLUMNS[String(row.table_name)] ?? [],
      deletable: DELETABLE_TABLES.has(String(row.table_name)),
    }));
  });

  return AuroraTablesResponseSchema.parse({ tables, fetched_at: new Date().toISOString() });
}

interface ColumnMeta {
  name: string;
  data_type: string;
  nullable: boolean;
  default_value: string | null;
  is_primary_key: boolean;
  editable: boolean;
}

async function describeColumns(client: PoolClient, table: string): Promise<ColumnMeta[]> {
  const result = await client.query(
    `SELECT col.column_name,
            col.data_type,
            col.is_nullable,
            col.column_default,
            COALESCE(pk.is_pk, false) AS is_pk
       FROM information_schema.columns col
       LEFT JOIN (
            SELECT a.attname, true AS is_pk
              FROM pg_index i
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
             WHERE i.indrelid = $1::regclass AND i.indisprimary
       ) pk ON pk.attname = col.column_name
      WHERE col.table_schema = 'public' AND col.table_name = $2
      ORDER BY col.ordinal_position`,
    [`public.${table}`, table]
  );

  if (result.rows.length === 0) {
    throw new HttpError(404, 'table_not_found', `No such table in the public schema: ${table}`);
  }

  const editable = EDITABLE_COLUMNS[table] ?? [];
  return result.rows.map((row) => ({
    name: String(row.column_name),
    data_type: String(row.data_type),
    nullable: row.is_nullable === 'YES',
    default_value: row.column_default === null ? null : String(row.column_default),
    is_primary_key: Boolean(row.is_pk),
    editable: editable.includes(String(row.column_name)),
  }));
}

/**
 * A page of rows, with the table's structure alongside so the console can
 * render types, primary keys, and which cells are editable without a second
 * round trip.
 *
 * Keyset pagination on the primary key: `OFFSET n` makes Postgres walk n rows
 * before returning anything, so it degrades as the table grows.
 */
export async function readRows(table: string, cursor?: string, limitRaw?: string) {
  const limit = clampLimit(limitRaw);

  return inReadOnlyTransaction(async (client) => {
    const columns = await describeColumns(client, table);
    const pk = columns.find((column) => column.is_primary_key);

    if (!pk) {
      throw new HttpError(
        400,
        'no_primary_key',
        `${table} has no primary key, so rows cannot be paged or edited safely.`
      );
    }

    const quotedTable = quoteIdent(table);
    const quotedPk = quoteIdent(pk.name);

    // Geography renders as WKB by default, which is unreadable; project it.
    const selectList = columns
      .map((column) =>
        column.data_type === 'USER-DEFINED'
          ? `CASE WHEN ${quoteIdent(column.name)} IS NULL THEN NULL
                  ELSE ST_Y(${quoteIdent(column.name)}::geometry)::text || ', ' ||
                       ST_X(${quoteIdent(column.name)}::geometry)::text END AS ${quoteIdent(column.name)}`
          : quoteIdent(column.name)
      )
      .join(', ');

    const params: unknown[] = [limit + 1];
    let where = '';
    if (cursor !== undefined && cursor !== '') {
      params.push(cursor);
      where = `WHERE ${quotedPk} > $2`;
    }

    const result = await client.query(
      `SELECT ${selectList} FROM ${quotedTable} ${where} ORDER BY ${quotedPk} ASC LIMIT $1`,
      params
    );

    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);

    return AuroraRowsResponseSchema.parse({
      table,
      primary_key: pk.name,
      deletable: DELETABLE_TABLES.has(table),
      columns,
      rows: rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value === null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value),
          ])
        )
      ),
      next_cursor: hasMore ? String(rows[rows.length - 1][pk.name]) : null,
      limit,
      fetched_at: new Date().toISOString(),
    });
  });
}

/**
 * Updates allowlisted columns on one row.
 *
 * Deliberately not SQL the caller supplies: the table, the columns, and the
 * primary key are all checked against the catalog and the allowlist, and every
 * value is bound as a parameter. There is no string to sanitise.
 */
export async function updateRow(input: {
  table: string;
  pkValue: string;
  changes: Record<string, unknown>;
  actor: string;
}) {
  const allowed = EDITABLE_COLUMNS[input.table];
  if (!allowed || allowed.length === 0) {
    throw new HttpError(403, 'table_not_editable', `${input.table} is read-only in the console.`);
  }

  const entries = Object.entries(input.changes);
  if (entries.length === 0) {
    throw new HttpError(400, 'no_changes', 'Supply at least one column to change.');
  }

  const rejected = entries.map(([column]) => column).filter((column) => !allowed.includes(column));
  if (rejected.length > 0) {
    throw new HttpError(
      403,
      'column_not_editable',
      `Not editable on ${input.table}: ${rejected.join(', ')}. Editable: ${allowed.join(', ')}.`
    );
  }

  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const columns = await describeColumns(client, input.table);
    const pk = columns.find((column) => column.is_primary_key);
    if (!pk) {
      throw new HttpError(400, 'no_primary_key', `${input.table} has no primary key.`);
    }

    const assignments = entries.map(([column], index) => `${quoteIdent(column)} = $${index + 1}`);
    const values = entries.map(([, value]) => value);
    values.push(input.pkValue);

    const hasUpdatedAt = columns.some((column) => column.name === 'updated_at');
    const setClause = hasUpdatedAt
      ? `${assignments.join(', ')}, "updated_at" = NOW()`
      : assignments.join(', ');

    const result = await client.query(
      `UPDATE ${quoteIdent(input.table)} SET ${setClause}
        WHERE ${quoteIdent(pk.name)} = $${values.length}
        RETURNING ${quoteIdent(pk.name)}`,
      values
    );

    if (result.rowCount === 0) {
      throw new HttpError(404, 'row_not_found', `No ${input.table} row with that primary key.`);
    }

    // Both tables drive live SPaT fanout, so every change is attributable.
    console.log(
      JSON.stringify({
        event: 'admin_row_update',
        actor: input.actor,
        table: input.table,
        primary_key: input.pkValue,
        columns: entries.map(([column]) => column),
      })
    );

    return {
      table: input.table,
      primary_key: input.pkValue,
      updated: entries.map(([column]) => column),
      updated_at: new Date().toISOString(),
    };
  } finally {
    client.release();
  }
}

/**
 * Arbitrary read-only SQL.
 *
 * Safety comes from the transaction being READ ONLY, from passing a parameter
 * array (which forces the extended query protocol and therefore permits exactly
 * one statement, so `;` stacking cannot work), from statement_timeout, and from
 * wrapping the caller's query so the row cap cannot be opted out of.
 */
export async function runQuery(sql: string, limitRaw?: string) {
  const trimmed = (sql ?? '').trim().replace(/;\s*$/, '');
  if (trimmed.length === 0) {
    throw new HttpError(400, 'empty_query', 'Enter a query.');
  }
  if (trimmed.length > 8000) {
    throw new HttpError(400, 'query_too_long', 'Query exceeds 8000 characters.');
  }

  const limit = clampLimit(limitRaw);
  const startedAt = Date.now();

  return inReadOnlyTransaction(async (client) => {
    let result;
    try {
      // The empty parameter array is load-bearing: it selects the extended
      // protocol, which rejects multiple statements at the wire level.
      result = await client.query(`SELECT * FROM (${trimmed}) AS _console_query LIMIT ${limit}`, []);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Query failed.';
      throw new HttpError(400, 'query_failed', message);
    }

    return AuroraQueryResponseSchema.parse({
      columns: result.fields.map((field) => field.name),
      rows: result.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value === null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value),
          ])
        )
      ),
      row_count: result.rows.length,
      capped: result.rows.length >= limit,
      limit,
      duration_ms: Date.now() - startedAt,
      fetched_at: new Date().toISOString(),
    });
  });
}

/**
 * Deletes exactly one row, identified by its primary key.
 *
 * Uses RETURNING * so the row's full contents are logged before it is gone.
 * The console offers no undo, but both tables here drive live behaviour — a
 * deleted `maps` row silently stops SPaT broadcasts for that intersection — so
 * the deleted record needs to survive somewhere it can be read back from.
 */
export async function deleteRow(input: { table: string; pkValue: string; actor: string }) {
  if (!DELETABLE_TABLES.has(input.table)) {
    throw new HttpError(
      403,
      'table_not_deletable',
      `Rows cannot be deleted from ${input.table} through the console.`
    );
  }

  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);

    const columns = await describeColumns(client, input.table);
    const pk = columns.find((column) => column.is_primary_key);
    if (!pk) {
      throw new HttpError(
        400,
        'no_primary_key',
        `${input.table} has no primary key, so a single row cannot be identified.`
      );
    }

    const result = await client.query(
      `DELETE FROM ${quoteIdent(input.table)}
        WHERE ${quoteIdent(pk.name)} = $1
        RETURNING *`,
      [input.pkValue]
    );

    if (result.rowCount === 0) {
      throw new HttpError(404, 'row_not_found', `No ${input.table} row with that primary key.`);
    }

    // The whole deleted record, so it can be reconstructed from logs if this
    // turns out to have been a mistake.
    console.log(
      JSON.stringify({
        event: 'admin_row_delete',
        actor: input.actor,
        table: input.table,
        primary_key: input.pkValue,
        deleted_row: result.rows[0],
      })
    );

    return {
      table: input.table,
      primary_key: input.pkValue,
      deleted: true,
      deleted_at: new Date().toISOString(),
    };
  } finally {
    client.release();
  }
}
