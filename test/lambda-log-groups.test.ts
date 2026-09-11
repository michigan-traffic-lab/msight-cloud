import * as fs from 'node:fs';
import * as path from 'node:path';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { logRetentionFromContext } from '../lib/log-retention';

/**
 * Guards against a Lambda being added without an explicit log group.
 *
 * When neither `logGroup` nor `logRetention` is given, CDK creates an implicit
 * log group whose retention defaults to "never expire". That is how two of the
 * functions here accumulated 276 GB between them: nothing in code owned their
 * retention, so nobody noticed until it showed up on the bill. The implicit
 * groups are also outside `cdk destroy`, so they survive the stack.
 *
 * This reads the stack source rather than a synthesized template on purpose.
 * Synthesizing needs Docker for the Fargate image asset and the Python layer,
 * which would make this slow and make it fail for reasons unrelated to what it
 * checks. The trade-off is that this is a textual guardrail, not a proof about
 * the template — it catches the mistake it is meant to catch (adding a function
 * and forgetting the prop) and nothing more.
 */

const STACK_SOURCE = path.join(__dirname, '..', 'lib', 'msight-cloud-stack.ts');

/** Construct IDs and the props block for every Lambda in the stack source. */
function lambdaDefinitions(source: string): Array<{ id: string; props: string }> {
  const pattern = /new (?:lambda\.Function|NodejsFunction)\(this, '([A-Za-z0-9]+)', \{/g;
  const found: Array<{ id: string; props: string }> = [];

  for (const match of source.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length;

    // Walk braces from the opening one so the props block's true extent is
    // known: these blocks contain nested objects, and a regex for the closing
    // brace would stop at the first nested one.
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    }

    found.push({ id: match[1] as string, props: source.slice(start, i - 1) });
  }

  return found;
}

/** The object literal starting at `from`, found by matching braces. */
function objectBodyAt(source: string, from: number): string {
  let depth = 1;
  let i = from;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return source.slice(from, i - 1);
}

/** Top-level `logGroup:` only — a nested one would belong to something else. */
function declaresLogGroup(props: string): boolean {
  let depth = 0;
  for (let i = 0; i < props.length; i += 1) {
    const c = props[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (depth === 0 && props.startsWith('logGroup:', i)) return true;
  }
  return false;
}

describe('lambda log groups', () => {
  const source = fs.readFileSync(STACK_SOURCE, 'utf8');
  const lambdas = lambdaDefinitions(source);

  it('finds every Lambda in the stack source', () => {
    // A parser that silently matched nothing would make the assertion below
    // pass for the wrong reason.
    expect(lambdas.length).toBeGreaterThanOrEqual(18);
  });

  it('gives every Lambda an explicit log group', () => {
    const missing = lambdas.filter((fn) => !declaresLogGroup(fn.props)).map((fn) => fn.id);

    expect(missing).toEqual([]);
  });

  it('caps retention on every declared log group', () => {
    // Retention is what actually bounds storage; a named group with no
    // retention is no better than the implicit one it replaced.
    // Brace-matched rather than a character class: these bodies contain a
    // template literal (`/${name.logPrefix}/...`) whose closing brace would
    // end a `[^}]*` match early and make every group look unbounded.
    const groups = source.matchAll(/new logs\.LogGroup\(this, '([A-Za-z0-9]+)', \{/g);
    const unbounded: string[] = [];

    for (const group of groups) {
      const id = group[1] as string;
      const body = objectBodyAt(source, (group.index ?? 0) + group[0].length);
      // Any retention will do; the value now comes from deploy.config.yaml and
      // is validated by logRetentionFromContext. What matters here is that a
      // group is never declared without one.
      if (!/retention:\s*\S/.test(body)) {
        unbounded.push(id);
      }
    }

    expect(unbounded).toEqual([]);
  });
});

/**
 * Functions that name log groups at runtime must be told the prefix to use.
 *
 * `names()` defaults `logPrefix` to the deployment name, and this deployment
 * overrides it: `msight-cloud` logs under `/msight/`. A function that is not
 * given LOG_PREFIX therefore derives a different name from the one its own IAM
 * policy is scoped to, and every attempt to create or read a log group is
 * denied. That has happened twice — once on the Logs page, which matched none
 * of its own groups, and once on microservice provisioning, which could not
 * create them at all.
 *
 * Source text rather than a synthesized template, for the same reason as the
 * checks above: synthesis needs Docker for the image assets.
 */
describe('runtime log group naming', () => {
  const source = fs.readFileSync(STACK_SOURCE, 'utf8');
  const lambdas = lambdaDefinitions(source);

  /**
   * The two that derive log group names at runtime: the Logs page reads them,
   * and microservice provisioning creates them. Both are scoped by IAM to the
   * `logPrefix` form, so both have to be told what it is.
   */
  const NAMES_LOG_GROUPS = ['AdminApiLambda', 'AdminVpcApiLambda'];

  it.each(NAMES_LOG_GROUPS)('gives %s the deployment log prefix', (id) => {
    const fn = lambdas.find((candidate) => candidate.id === id);
    // A stale id would otherwise make this pass by finding nothing.
    expect(fn).toBeDefined();
    expect(fn!.props).toContain('LOG_PREFIX: name.logPrefix');
  });
});

describe('log retention config', () => {
  it('accepts the values CloudWatch supports and fills in defaults', () => {
    const config = logRetentionFromContext({ lambda: 30, api: 1 });

    expect(config.lambda).toBe(RetentionDays.ONE_MONTH);
    expect(config.api).toBe(RetentionDays.ONE_DAY);
    // Omitted keys fall back, so an existing config keeps working unedited.
    expect(config.container).toBe(RetentionDays.ONE_WEEK);
  });

  it('rejects a period CloudWatch would refuse, naming the key', () => {
    // 10 days looks reasonable but is not one of the accepted values, and the
    // API error it would cause at deploy time does not say which setting broke.
    expect(() => logRetentionFromContext({ lambda: 10 })).toThrow(
      /logRetentionDays\.lambda = 10 is not a retention period/
    );
  });

  it('rejects a non-integer', () => {
    expect(() => logRetentionFromContext({ container: 'two weeks' })).toThrow(
      /logRetentionDays\.container must be a whole number/
    );
  });
});
