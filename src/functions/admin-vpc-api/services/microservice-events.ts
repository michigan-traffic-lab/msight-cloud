import { ensureMicroserviceSchema } from '../../../shared/microservice-schema';
import { getPool } from './db';

/**
 * What has happened to a microservice, in order.
 *
 * Everything the console could show about a service was a snapshot: its current
 * build state, the ECS events of the last hour, the rollout in progress. None
 * of it survived the next change, so "when did this last deploy and what commit
 * was it" had no answer once the deploy was a few hours old.
 *
 * That was tolerable while every deploy was somebody clicking a button. It is
 * not once a push can deploy with nobody watching: an unexpected change in
 * behaviour needs to be traceable to the commit that caused it, and this is the
 * only place that connection is written down.
 *
 * Recording is best-effort by design — see `recordEvent`.
 */

export type MicroserviceEventKind =
  | 'launch'
  | 'rebuild'
  | 'build_started'
  | 'build_succeeded'
  | 'build_failed'
  | 'deployed'
  | 'deploy_failed'
  | 'restarted'
  | 'rolled_back'
  | 'push_ignored';

export type MicroserviceEventTrigger = 'console' | 'push' | 'reconcile';

export interface MicroserviceEvent {
  id: string;
  microservice: string;
  at: string;
  kind: MicroserviceEventKind;
  actor: string;
  trigger: MicroserviceEventTrigger;
  detail: string | null;
  commit_sha: string | null;
  image_tag: string | null;
  build_id: string | null;
}

export interface RecordEventInput {
  microservice: string;
  kind: MicroserviceEventKind;
  actor: string;
  trigger?: MicroserviceEventTrigger | undefined;
  detail?: string | null | undefined;
  commitSha?: string | null | undefined;
  imageTag?: string | null | undefined;
  buildId?: string | null | undefined;
}

/** Long enough for an AWS failure message, short enough not to be a log. */
const DETAIL_LIMIT = 2000;

/**
 * How many events are kept per service.
 *
 * Enough to cover months of ordinary use, and bounded so a service in a crash
 * loop — restarted every few minutes by a reconcile that never succeeds —
 * cannot grow this table without limit. Trimmed on write rather than on a
 * schedule, because the only moment the table is known to have grown is the
 * moment something was added to it.
 */
const KEEP_PER_SERVICE = 200;

/**
 * Writes one event, and never fails the thing it is recording.
 *
 * A deploy that worked must not be reported as failed because its history row
 * could not be written, so every error here is logged and swallowed. That is
 * the right trade in one direction only: it means the history can have holes,
 * and the console says so rather than implying that nothing happened.
 */
export async function recordEvent(input: RecordEventInput): Promise<void> {
  try {
    const pool = await getPool();
    await pool.query(
      `INSERT INTO microservice_events
              (microservice, kind, actor, trigger, detail, commit_sha, image_tag, build_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.microservice,
        input.kind,
        input.actor,
        input.trigger ?? 'console',
        input.detail === null || input.detail === undefined
          ? null
          : input.detail.slice(0, DETAIL_LIMIT),
        input.commitSha ?? null,
        input.imageTag ?? null,
        input.buildId ?? null,
      ]
    );

    /**
     * Trim, cheaply and approximately.
     *
     * Runs on one in every twenty writes rather than on all of them: the bound
     * exists to stop unbounded growth, not to hold the table at exactly 200
     * rows, and paying for a window function on every deploy to enforce a limit
     * nobody reads to the row would be the wrong price.
     */
    if (Math.random() < 0.05) {
      await pool.query(
        `DELETE FROM microservice_events
               WHERE microservice = $1
                 AND id NOT IN (
                   SELECT id FROM microservice_events
                    WHERE microservice = $1
                    ORDER BY at DESC, id DESC
                    LIMIT $2
                 )`,
        [input.microservice, KEEP_PER_SERVICE]
      );
    }
  } catch (error) {
    console.error('could not record microservice event', {
      microservice: input.microservice,
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function toEvent(row: Record<string, unknown>): MicroserviceEvent {
  return {
    id: String(row.id),
    microservice: String(row.microservice),
    at: new Date(row.at as string).toISOString(),
    kind: String(row.kind) as MicroserviceEventKind,
    actor: String(row.actor),
    trigger: String(row.trigger) as MicroserviceEventTrigger,
    detail: row.detail === null ? null : String(row.detail),
    commit_sha: row.commit_sha === null ? null : String(row.commit_sha),
    image_tag: row.image_tag === null ? null : String(row.image_tag),
    build_id: row.build_id === null ? null : String(row.build_id),
  };
}

export async function listMicroserviceEvents(
  name: string,
  limit = 50
): Promise<MicroserviceEvent[]> {
  await ensureMicroserviceSchema(await getPool());
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT id, microservice, at, kind, actor, trigger, detail, commit_sha, image_tag, build_id
       FROM microservice_events
      WHERE microservice = $1
      ORDER BY at DESC, id DESC
      LIMIT $2`,
    [name, Math.min(Math.max(limit, 1), 200)]
  );
  return rows.map(toEvent);
}
