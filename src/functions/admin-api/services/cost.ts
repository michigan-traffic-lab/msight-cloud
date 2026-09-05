import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
  type Expression,
} from '@aws-sdk/client-cost-explorer';
import {
  CostServiceDetailResponseSchema,
  CostSummaryResponseSchema,
} from '../../../shared/schemas/admin';
import { HttpError } from '../../../shared/admin-api/http';

// Cost Explorer is a global service reached through us-east-1 regardless of
// where the stack itself lives.
const client = new CostExplorerClient({ region: 'us-east-1' });

/**
 * GetCostAndUsage is billed per request, so every response is cached. At a few
 * cents a day the charge is trivial in isolation, but a page that refetched on
 * every view would cost more per month than a sensor's Fargate task.
 *
 * The cache is per warm container, which is deliberate: it needs no extra
 * infrastructure, and the worst case is one extra call per cold start.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

async function cached<T>(key: string, refresh: boolean, load: () => Promise<T>) {
  const hit = cache.get(key);

  if (!refresh && hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return { value: hit.value as T, fetchedAt: hit.fetchedAt, fromCache: true };
  }

  const value = await load();
  const fetchedAt = Date.now();
  cache.set(key, { fetchedAt, value });
  return { value, fetchedAt, fromCache: false };
}

function tagFilter(): { key: string; value: string; expression: Expression } {
  const key = process.env.COST_TAG_KEY;
  const value = process.env.COST_TAG_VALUE;

  if (!key || !value) {
    throw new HttpError(
      500,
      'not_configured',
      'COST_TAG_KEY / COST_TAG_VALUE are not set on the admin API function.'
    );
  }

  return { key, value, expression: { Tags: { Key: key, Values: [value] } } };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Cost Explorer treats End as exclusive, so "today" needs tomorrow's date. */
function tomorrow(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return isoDate(date);
}

function startOfMonth(): string {
  const now = new Date();
  return isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
}

function startOfNextMonth(): string {
  const now = new Date();
  return isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface Period {
  start: string;
  end: string;
  isCurrentMonth: boolean;
}

/**
 * Resolves the requested window, defaulting to the current month to date.
 * Validates here rather than passing user input to Cost Explorer, so a bad
 * range produces a clear 400 instead of an opaque AWS error.
 */
export function resolvePeriod(start?: string, end?: string): Period {
  if (!start && !end) {
    return { start: startOfMonth(), end: tomorrow(), isCurrentMonth: true };
  }

  if (!start || !end) {
    throw new HttpError(
      400,
      'invalid_period',
      'Provide both start and end, or neither for the current month.'
    );
  }

  if (!DATE_PATTERN.test(start) || !DATE_PATTERN.test(end)) {
    throw new HttpError(400, 'invalid_period', 'Dates must be formatted YYYY-MM-DD.');
  }

  if (start >= end) {
    throw new HttpError(400, 'invalid_period', 'start must be earlier than end.');
  }

  return { start, end, isCurrentMonth: start === startOfMonth() };
}

/** The window of equal length immediately before `period`, for comparison. */
function previousPeriod(period: Period): { start: string; end: string } {
  const startMs = Date.parse(period.start);
  const endMs = Date.parse(period.end);
  const span = endMs - startMs;
  return {
    start: isoDate(new Date(startMs - span)),
    end: period.start,
  };
}

function amountOf(value?: { Amount?: string }): number {
  return value?.Amount ? Number.parseFloat(value.Amount) : 0;
}

async function totalForRange(
  filter: Expression,
  start: string,
  end: string
): Promise<number> {
  const result = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      Filter: filter,
    })
  );

  return (result.ResultsByTime ?? []).reduce(
    (sum, bucket) => sum + amountOf(bucket.Total?.UnblendedCost),
    0
  );
}

/**
 * Projected spend for the remainder of the current month.
 *
 * Returns null rather than throwing when Cost Explorer refuses: a freshly
 * tagged stack has too little history to forecast, which is an expected state
 * and not an error worth failing the page over.
 */
async function forecastRemainder(filter: Expression): Promise<number | null> {
  const start = tomorrow();
  const end = startOfNextMonth();

  if (start >= end) {
    return null;
  }

  try {
    const result = await client.send(
      new GetCostForecastCommand({
        TimePeriod: { Start: start, End: end },
        Granularity: 'MONTHLY',
        Metric: 'UNBLENDED_COST',
        Filter: filter,
      })
    );
    return amountOf(result.Total);
  } catch {
    return null;
  }
}

export async function getSummary(period: Period, refresh: boolean) {
  const { key, value, expression } = tagFilter();
  const cacheKey = `summary:${key}=${value}:${period.start}:${period.end}`;

  const { value: payload, fetchedAt, fromCache } = await cached(cacheKey, refresh, async () => {
    const byService = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: period.start, End: period.end },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        Filter: expression,
      })
    );

    // A multi-month window returns one bucket per month; fold them together so
    // the breakdown always describes the whole requested period.
    const totals = new Map<string, number>();
    for (const bucket of byService.ResultsByTime ?? []) {
      for (const group of bucket.Groups ?? []) {
        const service = group.Keys?.[0] ?? 'Unknown';
        const amount = amountOf(group.Metrics?.UnblendedCost);
        totals.set(service, (totals.get(service) ?? 0) + amount);
      }
    }

    const components = [...totals.entries()]
      .map(([service, amount]) => ({ service, amount }))
      .filter((entry) => entry.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    const total = components.reduce((sum, entry) => sum + entry.amount, 0);

    // Both of these are only meaningful for the current month, and the console
    // only renders them there. Skipping them for an explicit date range saves a
    // billed Cost Explorer call per search rather than computing data nothing
    // displays.
    const previous = previousPeriod(period);
    const [previousTotal, remainder] = period.isCurrentMonth
      ? await Promise.all([
          totalForRange(expression, previous.start, previous.end).catch(() => null),
          forecastRemainder(expression),
        ])
      : [null, null];

    return {
      total,
      previousTotal,
      projected: remainder === null ? null : total + remainder,
      components: components.map((entry) => ({
        ...entry,
        share: total > 0 ? entry.amount / total : 0,
      })),
    };
  });

  return CostSummaryResponseSchema.parse({
    period: {
      start: period.start,
      end: period.end,
      is_current_month: period.isCurrentMonth,
    },
    currency: 'USD',
    total: payload.total,
    projected_month_total: payload.projected,
    previous_period_total: payload.previousTotal,
    components: payload.components,
    filter: { tag_key: key, tag_value: value },
    fetched_at: new Date(fetchedAt).toISOString(),
    cached: fromCache,
  });
}

export async function getServiceDetail(
  service: string,
  period: Period,
  refresh: boolean
) {
  if (!service) {
    throw new HttpError(400, 'invalid_request', 'A service name is required.');
  }

  const { key, value, expression } = tagFilter();
  const scoped: Expression = {
    And: [expression, { Dimensions: { Key: 'SERVICE', Values: [service] } }],
  };
  const cacheKey = `service:${key}=${value}:${service}:${period.start}:${period.end}`;

  const { value: payload, fetchedAt, fromCache } = await cached(cacheKey, refresh, async () => {
    const [byUsageType, daily] = await Promise.all([
      client.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: period.start, End: period.end },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
          GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
          Filter: scoped,
        })
      ),
      client.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: period.start, End: period.end },
          Granularity: 'DAILY',
          Metrics: ['UnblendedCost'],
          Filter: scoped,
        })
      ),
    ]);

    const usageTotals = new Map<string, number>();
    for (const bucket of byUsageType.ResultsByTime ?? []) {
      for (const group of bucket.Groups ?? []) {
        const usageType = group.Keys?.[0] ?? 'Unknown';
        usageTotals.set(
          usageType,
          (usageTotals.get(usageType) ?? 0) + amountOf(group.Metrics?.UnblendedCost)
        );
      }
    }

    const usageTypes = [...usageTotals.entries()]
      .map(([usage_type, amount]) => ({ usage_type, amount }))
      .filter((entry) => entry.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    const total = usageTypes.reduce((sum, entry) => sum + entry.amount, 0);

    return {
      total,
      usageTypes: usageTypes.map((entry) => ({
        ...entry,
        share: total > 0 ? entry.amount / total : 0,
      })),
      daily: (daily.ResultsByTime ?? []).map((bucket) => ({
        date: bucket.TimePeriod?.Start ?? '',
        amount: amountOf(bucket.Total?.UnblendedCost),
      })),
    };
  });

  return CostServiceDetailResponseSchema.parse({
    service,
    period: {
      start: period.start,
      end: period.end,
      is_current_month: period.isCurrentMonth,
    },
    currency: 'USD',
    total: payload.total,
    usage_types: payload.usageTypes,
    daily: payload.daily,
    fetched_at: new Date(fetchedAt).toISOString(),
    cached: fromCache,
  });
}
