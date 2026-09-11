import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import {
  LogGroupsResponseSchema,
  LogQueryResultsResponseSchema,
  LogQueryStartedResponseSchema,
} from '../../../shared/schemas/admin';
import { HttpError } from '../../../shared/admin-api/http';

const logs = new CloudWatchLogsClient({});
const lambda = new LambdaClient({});

/**
 * Insights bills per GB scanned, and a query over every group across a long
 * window can scan a lot. These bounds keep an accidental click cheap.
 */
const MAX_GROUPS_PER_QUERY = 20;
const MAX_RESULTS = 1000;
const DEFAULT_RESULTS = 100;
const MAX_WINDOW_HOURS = 24 * 14;

/**
 * This deployment's log group prefix.
 *
 * Read from the environment rather than hardcoded, because it is
 * deployment-scoped: `logPrefix` defaults to the deployment name, so a stack
 * called `msight-cloud` writes to `/msight-cloud/...` and a second one writes
 * somewhere else entirely.
 *
 * It used to be the literal `/msight/`, which matched neither — every group
 * this stack owns was silently excluded and the Logs page listed almost
 * nothing. Falling back to the deployment name keeps that from recurring if the
 * variable is ever dropped.
 */
function logPrefix(): string {
  const prefix = process.env.LOG_PREFIX ?? process.env.DEPLOYMENT_NAME ?? 'msight';
  return `/${prefix.replace(/^\/+|\/+$/g, '')}/`;
}

/** Groups belonging to this stack. Everything else in the account is not ours. */
function belongsToStack(name: string): boolean {
  return (
    name.startsWith('/aws/lambda/MsightCloudStack-') ||
    name.startsWith(logPrefix()) ||
    name.includes('msight-cluster')
  );
}

export type LogCategory =
  | 'lambda'
  | 'container'
  | 'microservice'
  | 'build'
  | 'insights'
  | 'api'
  | 'other';

/**
 * What kind of thing wrote this group.
 *
 * Microservices get two categories of their own rather than being folded into
 * 'container': their runtime logs and their build logs answer different
 * questions, are retained separately, and are cleared separately.
 */
function categorise(name: string): LogCategory {
  const prefix = logPrefix();
  if (name.startsWith('/aws/lambda/')) return 'lambda';
  if (name.startsWith(`${prefix}lambda/`)) return 'lambda';
  if (name.startsWith(`${prefix}sensor-consumer/`)) return 'container';
  if (name.startsWith(`${prefix}microservice-build/`)) return 'build';
  if (name.startsWith(`${prefix}microservice/`)) return 'microservice';
  if (name.includes('containerinsights')) return 'insights';
  if (name.startsWith(`${prefix}apigw/`)) return 'api';
  return 'other';
}

/**
 * The function name a Lambda log group belongs to, or null.
 *
 * CloudWatch keeps a group after its function is deleted or replaced, so old
 * groups accumulate silently and keep costing storage. Matching against live
 * functions is what lets the console mark them.
 */
function functionNameOf(logGroupName: string): string | null {
  const prefix = '/aws/lambda/';
  return logGroupName.startsWith(prefix) ? logGroupName.slice(prefix.length) : null;
}

export async function listGroups() {
  const collected: Array<{
    name: string;
    stored_bytes: number;
    retention_days: number | null;
    created_at: string | null;
  }> = [];

  let nextToken: string | undefined;
  do {
    const page = await logs.send(new DescribeLogGroupsCommand({ nextToken, limit: 50 }));
    for (const group of page.logGroups ?? []) {
      const name = group.logGroupName ?? '';
      if (!belongsToStack(name)) continue;
      collected.push({
        name,
        stored_bytes: group.storedBytes ?? 0,
        retention_days: group.retentionInDays ?? null,
        created_at: group.creationTime ? new Date(group.creationTime).toISOString() : null,
      });
    }
    nextToken = page.nextToken;
  } while (nextToken);

  // Live function names, to tell a current group from an orphan.
  const live = new Set<string>();
  let marker: string | undefined;
  do {
    const page = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 200 }));
    for (const fn of page.Functions ?? []) {
      if (fn.FunctionName) live.add(fn.FunctionName);
    }
    marker = page.NextMarker;
  } while (marker);

  const groups = collected
    .map((group) => {
      const fnName = functionNameOf(group.name);
      return {
        ...group,
        category: categorise(group.name),
        // Only meaningful for Lambda groups; others are never marked orphaned.
        orphaned: fnName !== null && !live.has(fnName),
      };
    })
    .sort((a, b) => b.stored_bytes - a.stored_bytes);

  return LogGroupsResponseSchema.parse({
    groups,
    total_stored_bytes: groups.reduce((sum, group) => sum + group.stored_bytes, 0),
    orphaned_count: groups.filter((group) => group.orphaned).length,
    fetched_at: new Date().toISOString(),
  });
}

function parseWindow(startIso?: string, endIso?: string) {
  const end = endIso ? Date.parse(endIso) : Date.now();
  const start = startIso ? Date.parse(startIso) : end - 60 * 60 * 1000;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new HttpError(400, 'invalid_window', 'start must be a valid time before end.');
  }
  if (end - start > MAX_WINDOW_HOURS * 3600 * 1000) {
    throw new HttpError(
      400,
      'window_too_large',
      `The time window may not exceed ${MAX_WINDOW_HOURS / 24} days.`
    );
  }

  return { start: Math.floor(start / 1000), end: Math.floor(end / 1000) };
}

/**
 * Starts an Insights query. CloudWatch runs these asynchronously, so this
 * returns an id the caller polls rather than blocking a Lambda for the
 * duration — a query over gigabytes can take far longer than an API timeout.
 */
export async function startQuery(input: {
  groups?: string[];
  query?: string;
  start?: string;
  end?: string;
  limit?: number;
}) {
  const groups = (input.groups ?? []).filter((name) => belongsToStack(name));

  if (groups.length === 0) {
    throw new HttpError(400, 'no_groups', 'Select at least one log group belonging to this stack.');
  }
  if (groups.length > MAX_GROUPS_PER_QUERY) {
    throw new HttpError(
      400,
      'too_many_groups',
      `Query at most ${MAX_GROUPS_PER_QUERY} groups at once — Insights bills per GB scanned.`
    );
  }

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_RESULTS, 1), MAX_RESULTS);
  const { start, end } = parseWindow(input.start, input.end);

  const queryString =
    input.query?.trim() || `fields @timestamp, @message\n| sort @timestamp desc`;

  const result = await logs.send(
    new StartQueryCommand({
      logGroupNames: groups,
      startTime: start,
      endTime: end,
      queryString,
      limit,
    })
  );

  if (!result.queryId) {
    throw new HttpError(502, 'query_not_started', 'CloudWatch did not return a query id.');
  }

  return LogQueryStartedResponseSchema.parse({
    query_id: result.queryId,
    groups,
    limit,
    started_at: new Date().toISOString(),
  });
}

export async function getResults(queryId: string) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(queryId)) {
    throw new HttpError(400, 'invalid_query_id', 'That is not a valid query id.');
  }

  const result = await logs.send(new GetQueryResultsCommand({ queryId }));

  // Insights returns rows as field/value pairs; flatten to objects the table
  // can render without the UI needing to know the query's shape.
  const rows = (result.results ?? []).map((row) => {
    const record: Record<string, string> = {};
    for (const field of row) {
      if (field.field) record[field.field] = field.value ?? '';
    }
    return record;
  });

  return LogQueryResultsResponseSchema.parse({
    query_id: queryId,
    status: result.status ?? 'Unknown',
    rows,
    // Present only once the query finishes; useful for judging query cost.
    scanned_bytes: result.statistics?.bytesScanned ?? null,
    matched_records: result.statistics?.recordsMatched ?? null,
    fetched_at: new Date().toISOString(),
  });
}

export async function stopQuery(queryId: string) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(queryId)) {
    throw new HttpError(400, 'invalid_query_id', 'That is not a valid query id.');
  }
  await logs.send(new StopQueryCommand({ queryId }));
  return { query_id: queryId, stopped: true };
}
