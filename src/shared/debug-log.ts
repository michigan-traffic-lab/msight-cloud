/**
 * Per-request logging that is off by default.
 *
 * CloudWatch Logs ingestion is billed per GB, and the functions on the hot path
 * here run at message rates, not human rates: the SPaT consumers fire at roughly
 * 10 Hz per sensor, and each SPaT message fans out to a radius broadcast per app
 * per intersection, each of which delivers to every nearby WebSocket client. A
 * single log line per invocation on those paths is what produced most of this
 * account's CloudWatch bill.
 *
 * So success-path detail goes through `debugLog`, which is silent unless
 * DEBUG_LOGGING is set on the function. Anything an operator would act on — an
 * error, a missing configuration, a dropped message — keeps using `console.*`
 * directly and always appears.
 *
 * Gated rather than deleted on purpose: the detail is what makes a decode or
 * delivery bug diagnosable, and flipping an environment variable is a much
 * cheaper way to get it back than editing and redeploying a Lambda mid-incident.
 */

const DEBUG_LOGGING = (process.env.DEBUG_LOGGING ?? 'false').toLowerCase() === 'true';

/** True when per-request logging is enabled, for skipping expensive payloads. */
export const debugLoggingEnabled = DEBUG_LOGGING;

/** Logs success-path detail. Silent unless DEBUG_LOGGING is on. */
export function debugLog(message: string, fields?: Record<string, unknown>): void {
  if (!DEBUG_LOGGING) return;
  if (fields === undefined) {
    console.log(message);
  } else {
    console.log(message, fields);
  }
}
