/**
 * Schema for the registry tables, applied on demand rather than by a migration
 * step.
 *
 * The `sensors` table already worked this way and the reasons carry over: a
 * fresh deployment needs no separate migration command, and the tables are
 * created EMPTY so a deploy can never resurrect something an operator deleted.
 *
 * Every statement here is idempotent and additive. That is the whole contract —
 * this runs on a live database on the first request after any deploy, so a
 * statement that rewrites or drops anything would do it under live traffic with
 * no way to review it first.
 */

/** Minimal shape both `pg.Pool` and `pg.PoolClient` satisfy. */
export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

/**
 * Bucket registry plus the sensor ingest columns that reference it.
 *
 * `sensors` predates all of this and is altered rather than recreated. The
 * defaults are chosen so an existing row keeps behaving exactly as it did:
 * `stream_enabled` defaults TRUE because every sensor that exists today streams
 * in real time, and reconciliation now keys on it.
 */
export async function ensureStorageSchema(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS storages (
      bucket       TEXT PRIMARY KEY,
      display_name TEXT NULL,
      region       TEXT NULL,
      -- 'created' when this deployment made the bucket, 'adopted' when an
      -- operator registered one that already existed. Decides whether removal
      -- may offer anything beyond unregistering.
      origin       TEXT NOT NULL DEFAULT 'adopted',
      -- Whether the bucket SHOULD publish ObjectCreated events to the control
      -- topic. Derived, not chosen: it is true exactly when at least one sensor
      -- archives here, and the reconciler writes it. Kept as a column rather
      -- than recomputed on read so the console can show intent beside what S3
      -- actually reports, which is what makes drift visible.
      notify       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sensors (
      name         TEXT PRIMARY KEY,
      display_name TEXT NULL,
      enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Two independent ingest paths, not a mode enum: a sensor may stream, may
  // archive, or may do both. An enum would make "both" a third value that every
  // consumer has to remember to handle, and forgetting reads as a sensor
  // silently not streaming.
  //
  // storage_bucket and storage_prefix are also the lookup table for anything
  // that subscribes to upload events later: an S3 key maps back to a sensor by
  // matching it against these prefixes, longest first.
  await db.query(`
    ALTER TABLE sensors
      ADD COLUMN IF NOT EXISTS stream_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS archive_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS storage_bucket  TEXT NULL,
      ADD COLUMN IF NOT EXISTS storage_prefix  TEXT NOT NULL DEFAULT ''
  `);

  // Added separately from the column so an existing database that already has
  // the column still gets the constraint. ON DELETE SET NULL is a backstop
  // only: unregistering a bucket clears the sensors' archive settings first,
  // because clearing the bucket while archive_enabled stayed true would leave
  // a sensor claiming to archive nowhere.
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'sensors_storage_bucket_fkey'
      ) THEN
        ALTER TABLE sensors
          ADD CONSTRAINT sensors_storage_bucket_fkey
          FOREIGN KEY (storage_bucket) REFERENCES storages(bucket) ON DELETE SET NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'sensors_archive_needs_bucket'
      ) THEN
        ALTER TABLE sensors
          ADD CONSTRAINT sensors_archive_needs_bucket
          CHECK (NOT archive_enabled OR storage_bucket IS NOT NULL);
      END IF;
    END
    $$
  `);

  // One S3 notification serves a whole bucket, however many sensors write into
  // it under different prefixes. So its lifecycle is a count: install on the
  // first archiving sensor, remove after the last one goes. The reconciler runs
  // that count for every registered bucket on a schedule and after every change
  // to a sensor, which makes it the hottest query against this table.
  //
  // Partial on `archive_enabled` because that is exactly the predicate the
  // count uses, and it keeps the index to the rows that can ever match. The
  // table is small today; the index costs nothing and stops this from becoming
  // a sequential scan per reconcile as sensors are added.
  await db.query(`
    CREATE INDEX IF NOT EXISTS sensors_archiving_bucket_idx
      ON sensors (storage_bucket)
      WHERE archive_enabled AND storage_bucket IS NOT NULL
  `);

  // Serves the console's "which sensors are attached to this bucket" listing,
  // which includes sensors configured for a bucket but not currently archiving.
  await db.query(`
    CREATE INDEX IF NOT EXISTS sensors_storage_bucket_idx
      ON sensors (storage_bucket)
      WHERE storage_bucket IS NOT NULL
  `);
}
