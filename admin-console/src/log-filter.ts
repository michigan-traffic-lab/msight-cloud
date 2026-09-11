/**
 * Reading a log that has no structure.
 *
 * CloudWatch stores a timestamp and a string. There is no level, no source, and
 * no way to tell stdout from stderr — the awslogs driver sends both into one
 * stream, and a CloudWatch event carries nothing that says which fd a line came
 * from. So everything useful about a line has to be recovered from its text,
 * and the console says as much wherever it does so.
 */

export type Severity = 'error' | 'warn' | 'info';

/**
 * Anchored at the end of the word only, and that asymmetry is the whole trick.
 *
 * Real logs put these words inside identifiers far more often than they put
 * them alone: `botocore.exceptions.ClientError`, `AccessDenied`,
 * `DeprecationWarning`, `ReadTimeout`. A leading \b misses every one of those —
 * which is to say it misses precisely the lines worth finding, while still
 * matching the tame ones.
 *
 * The trailing \b is what keeps it honest. It is what separates "ClientError:"
 * from "terrorism", and "DeprecationWarning" from "forewarned" — both of which
 * contain one of these words and neither of which is a fault. Dropping it too
 * would tint a healthy log from end to end, and a tint that is always on says
 * nothing.
 *
 * It stays a guess either way: "errors: 0" reads as an error here. The UI says
 * the level is inferred from the wording rather than reported, because there is
 * nothing in a CloudWatch event that reports it.
 */
const ERROR_WORDS =
  /(errors?|fatal|exceptions?|traceback|panic|failed|failure|denied|refused|unauthori[sz]ed|timeouts?|timed out)\b/i;

const WARN_WORDS = /(warn|warnings?|deprecated|retrying|throttled|degraded)\b/i;

export function severityOf(message: string): Severity {
  if (ERROR_WORDS.test(message)) return 'error';
  if (WARN_WORDS.test(message)) return 'warn';
  return 'info';
}

/**
 * A container log stream is `<service>/<container>/<task id>`. The task id is
 * the only part that differs between the streams being merged, so it is the
 * only part worth showing beside a line.
 */
export function shortStream(stream: string): string {
  const task = stream.split('/').pop() ?? stream;
  return task.length > 12 ? `${task.slice(0, 8)}…` : task;
}

export interface HighlightPart {
  text: string;
  hit: boolean;
}

/**
 * Splits a line around each match, so the match can be marked without `v-html`.
 *
 * Log lines are arbitrary bytes from someone else's process. Interpolating one
 * as markup to get a highlight would hand every container a way to inject into
 * this page, which is a steep price for a yellow background.
 */
export function highlight(message: string, needle: string): HighlightPart[] {
  const query = needle.trim();
  if (!query) return [{ text: message, hit: false }];

  const parts: HighlightPart[] = [];
  const haystack = message.toLowerCase();
  const lower = query.toLowerCase();
  let at = 0;

  for (;;) {
    const found = haystack.indexOf(lower, at);
    if (found === -1) {
      if (at < message.length) parts.push({ text: message.slice(at), hit: false });
      return parts;
    }
    if (found > at) parts.push({ text: message.slice(at, found), hit: false });
    parts.push({ text: message.slice(found, found + query.length), hit: true });
    at = found + query.length;
  }
}

export interface FilterableLine {
  message: string;
  stream: string | null;
  severity: Severity;
}

export interface LogFilter {
  query: string;
  severity: 'all' | 'warn' | 'error';
  stream: string | null;
}

/** Whether a filter would narrow anything, for the "showing X of Y" line. */
export function isFiltering(filter: LogFilter): boolean {
  return filter.query.trim() !== '' || filter.severity !== 'all' || filter.stream !== null;
}

export function matches(line: FilterableLine, filter: LogFilter): boolean {
  if (filter.stream && line.stream !== filter.stream) return false;
  if (filter.severity === 'error' && line.severity !== 'error') return false;
  // 'warn' means warnings *and above*, which is what someone triaging wants.
  if (filter.severity === 'warn' && line.severity === 'info') return false;

  const needle = filter.query.trim().toLowerCase();
  if (needle && !line.message.toLowerCase().includes(needle)) return false;

  return true;
}
