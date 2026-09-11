/**
 * How numbers are written in the console.
 *
 * Shared rather than redefined per page, because the same number rendered two
 * ways on two screens is the kind of inconsistency that makes people distrust
 * both. The rules here are about what a reader can act on, not about brevity.
 */

/**
 * ECS CPU units, written the way the console asks for them.
 *
 * 1024 units is one vCPU, and the raw unit is an implementation detail of the
 * ECS API that means nothing to the person choosing it — "256" is not a size
 * anyone can picture, and a task description reading "256 CPU units" next to a
 * form that offered "0.25 vCPU" is two different vocabularies for one setting.
 * The unit count is kept in parentheses only where the API value itself matters.
 */
export function vcpu(units: number): string {
  const cores = units / 1024;
  // Trailing zeros stripped: 1 vCPU, not 1.00; 0.25 vCPU, not 0.2500.
  const text = Number.isInteger(cores) ? String(cores) : String(Number(cores.toFixed(3)));
  return `${text} vCPU`;
}

/** MiB as GB where that is readable, MiB where it is not. */
export function mib(value: number): string {
  if (value <= 0) return '0';
  return value >= 1024 ? `${Number((value / 1024).toFixed(2))} GB` : `${value} MiB`;
}

/** A task's shape in one phrase, which is how it is always read. */
export function taskSize(cpuUnits: number, memoryMib: number): string {
  return `${vcpu(cpuUnits)} · ${mib(memoryMib)}`;
}

export function bytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** An absolute timestamp, because "3 hours ago" cannot be compared to a log. */
export function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function timeOnly(iso: string): string {
  return iso ? new Date(iso).toLocaleTimeString() : '';
}

/**
 * How long ago, for things where the gap is the point.
 *
 * Used beside an absolute time rather than instead of it: "2 minutes ago" is
 * what tells you a build is live, and the timestamp is what lets you line it up
 * against a log line.
 */
export function since(iso: string | null): string {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
