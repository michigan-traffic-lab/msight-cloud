import {
  highlight,
  isFiltering,
  matches,
  severityOf,
  shortStream,
  type FilterableLine,
} from '../admin-console/src/log-filter';

/**
 * The log a person actually reads.
 *
 * None of this can be checked against CloudWatch, because CloudWatch has no
 * opinion about any of it: it stores a timestamp and a string. Everything the
 * console shows beyond those two — a severity tint, a highlighted match, which
 * task a line came from — is recovered from the text here, so this is where the
 * recovery is pinned.
 */

const line = (message: string, stream: string | null = null): FilterableLine => ({
  message,
  stream,
  severity: severityOf(message),
});

/** Real lines from the running `testing` container and its failed build. */
const HEALTHY =
  '2026-09-11T11:40:47.734Z [ip-10-0-116-134.us-east-2.compute.internal] tick 6869: msight-cloud test container alive';
const BUILD_FAILURE =
  'PRE_BUILD: COMMAND_EXECUTION_ERROR: Error while executing command: set -euo pipefail. Reason: exit status 2';

describe('severity, guessed from the text', () => {
  it('leaves an ordinary line alone', () => {
    // The whole point of a narrow word list: a healthy log must stay untinted,
    // or the tint means nothing when it does appear.
    expect(severityOf(HEALTHY)).toBe('info');
  });

  it('catches the build failure that actually happened', () => {
    expect(severityOf(BUILD_FAILURE)).toBe('error');
  });

  it.each([
    ['Traceback (most recent call last):', 'error'],
    ['botocore.exceptions.ClientError: AccessDenied', 'error'],
    ['connection refused', 'error'],
    ['request timed out after 30s', 'error'],
    ['WARNING: retrying in 5s', 'warn'],
    ['DeprecationWarning: use X instead', 'warn'],
    ['listening on 0.0.0.0:8080', 'info'],
    ['processed 412 frames', 'info'],
  ])('reads %j as %s', (message, expected) => {
    expect(severityOf(message)).toBe(expected);
  });

  /**
   * The failure mode that makes the feature useless: a pattern loose enough to
   * fire inside ordinary words tints a healthy log from end to end.
   */
  it('does not fire on the word inside another word', () => {
    expect(severityOf('terrorism module loaded')).toBe('info');
    expect(severityOf('forewarned is forearmed')).toBe('info');
    expect(severityOf('deferred until later')).toBe('info');
  });
});

describe('filtering', () => {
  const rows = [
    line(HEALTHY, 'testing/testing/aaa'),
    line('WARNING: retrying in 5s', 'testing/testing/aaa'),
    line('Error: connection refused', 'testing/testing/bbb'),
  ];

  const filterOf = (over: Partial<Parameters<typeof matches>[1]> = {}) => ({
    query: '',
    severity: 'all' as const,
    stream: null,
    ...over,
  });

  it('shows everything by default, and says it is not filtering', () => {
    expect(isFiltering(filterOf())).toBe(false);
    expect(rows.filter((row) => matches(row, filterOf()))).toHaveLength(3);
  });

  it('treats "warnings" as warnings and above', () => {
    // Someone triaging wants the warning *and* the error under it, not the
    // warnings alone — that is the difference between a filter and a blindfold.
    const visible = rows.filter((row) => matches(row, filterOf({ severity: 'warn' })));
    expect(visible.map((row) => row.severity)).toEqual(['warn', 'error']);
  });

  it('narrows to errors', () => {
    const visible = rows.filter((row) => matches(row, filterOf({ severity: 'error' })));
    expect(visible).toHaveLength(1);
    expect(visible[0]!.message).toContain('refused');
  });

  it('matches text without regard to case', () => {
    expect(rows.filter((row) => matches(row, filterOf({ query: 'REFUSED' })))).toHaveLength(1);
    expect(rows.filter((row) => matches(row, filterOf({ query: '  tick  ' })))).toHaveLength(1);
  });

  it('narrows to one task when several are merged', () => {
    const visible = rows.filter((row) =>
      matches(row, filterOf({ stream: 'testing/testing/aaa' }))
    );
    expect(visible).toHaveLength(2);
  });

  it('combines the three', () => {
    const visible = rows.filter((row) =>
      matches(row, filterOf({ severity: 'warn', stream: 'testing/testing/aaa', query: 'retry' }))
    );
    expect(visible).toHaveLength(1);
  });
});

describe('match highlighting', () => {
  it('returns the line untouched when nothing is being searched for', () => {
    expect(highlight(HEALTHY, '')).toEqual([{ text: HEALTHY, hit: false }]);
    expect(highlight(HEALTHY, '   ')).toEqual([{ text: HEALTHY, hit: false }]);
  });

  it('splits around every match, preserving the original text exactly', () => {
    const parts = highlight('tick 1 tick 2 tick', 'tick');
    // Reassembling has to give back the input: a highlighter that drops or
    // duplicates a character corrupts the log it is meant to help read.
    expect(parts.map((part) => part.text).join('')).toBe('tick 1 tick 2 tick');
    expect(parts.filter((part) => part.hit)).toHaveLength(3);
  });

  it('matches case-insensitively but shows the original casing', () => {
    const parts = highlight('Error: refused', 'error');
    expect(parts[0]).toEqual({ text: 'Error', hit: true });
  });

  it('terminates on a match at the very end', () => {
    // The loop advances by the needle length; a match flush against the end is
    // where an off-by-one would spin for ever.
    const parts = highlight('all quiet', 'quiet');
    expect(parts.map((part) => part.text).join('')).toBe('all quiet');
    expect(parts[parts.length - 1]).toEqual({ text: 'quiet', hit: true });
  });
});

describe('stream labels', () => {
  it('keeps the task id, which is the part that differs', () => {
    // The prefix is the same for every task of a service, so showing it would
    // spend the column on nothing.
    expect(shortStream('testing/testing/5cb0bb3204ea467380fd4d318d6ae72b')).toBe('5cb0bb32…');
  });

  it('leaves a short id whole', () => {
    expect(shortStream('testing/testing/abc123')).toBe('abc123');
  });
});
