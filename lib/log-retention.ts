import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * Turns a plain number of days from deploy.config.yaml into a
 * `logs.RetentionDays`.
 *
 * CloudWatch does not accept an arbitrary number of days — only the fixed set
 * below. A value outside it is rejected by the API at deploy time with a message
 * that does not say which setting was wrong, so it is validated here instead and
 * the error names the key and lists what is allowed.
 *
 * Retention is what bounds log storage: undeclared, CloudWatch keeps events
 * forever and charges for them, which is how two log groups in this stack
 * reached 276 GB between them.
 */

/** The values CloudWatch Logs accepts, in days. `0` means never expire. */
const ALLOWED: Record<number, logs.RetentionDays> = {
  1: logs.RetentionDays.ONE_DAY,
  3: logs.RetentionDays.THREE_DAYS,
  5: logs.RetentionDays.FIVE_DAYS,
  7: logs.RetentionDays.ONE_WEEK,
  14: logs.RetentionDays.TWO_WEEKS,
  30: logs.RetentionDays.ONE_MONTH,
  60: logs.RetentionDays.TWO_MONTHS,
  90: logs.RetentionDays.THREE_MONTHS,
  120: logs.RetentionDays.FOUR_MONTHS,
  150: logs.RetentionDays.FIVE_MONTHS,
  180: logs.RetentionDays.SIX_MONTHS,
  365: logs.RetentionDays.ONE_YEAR,
  400: logs.RetentionDays.THIRTEEN_MONTHS,
  545: logs.RetentionDays.EIGHTEEN_MONTHS,
  731: logs.RetentionDays.TWO_YEARS,
  1827: logs.RetentionDays.FIVE_YEARS,
  3653: logs.RetentionDays.TEN_YEARS,
  0: logs.RetentionDays.INFINITE,
};

export interface LogRetentionConfig {
  /** Every Lambda function in the stack. */
  lambda: logs.RetentionDays;
  /** Fargate sensor consumer containers. */
  container: logs.RetentionDays;
  /** API Gateway access logs. */
  api: logs.RetentionDays;
}

const DEFAULTS = { lambda: 14, container: 7, api: 7 };

function resolve(days: unknown, key: string): logs.RetentionDays {
  const value = Number(days);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `deploy.config.yaml: logRetentionDays.${key} must be a whole number of days, got ${String(days)}.`
    );
  }

  const retention = ALLOWED[value];
  if (retention === undefined) {
    throw new Error(
      `deploy.config.yaml: logRetentionDays.${key} = ${value} is not a retention period CloudWatch ` +
        `accepts. Use one of: ${Object.keys(ALLOWED)
          .map(Number)
          .filter((d) => d !== 0)
          .sort((a, b) => a - b)
          .join(', ')} — or 0 to keep logs forever, which is rarely what you want: ` +
        'CloudWatch charges for that storage indefinitely.'
    );
  }

  return retention;
}

/**
 * Reads the `logRetentionDays` block from CDK context, filling in defaults for
 * anything omitted so an existing config keeps working without an edit.
 */
export function logRetentionFromContext(raw: unknown): LogRetentionConfig {
  const config = (raw ?? {}) as Partial<Record<keyof typeof DEFAULTS, unknown>>;

  return {
    lambda: resolve(config.lambda ?? DEFAULTS.lambda, 'lambda'),
    container: resolve(config.container ?? DEFAULTS.container, 'container'),
    api: resolve(config.api ?? DEFAULTS.api, 'api'),
  };
}
