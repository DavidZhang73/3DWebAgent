import type { TraceFrame } from './types.ts';

export function operationAtPixel(pixel: number, spacing: number, last: number) {
  return Math.max(0, Math.min(last, Math.round((pixel - 24) / spacing)));
}

// Only the monotonic attempt belongs on the time axis. Rollback is a separate endpoint.
export function trajectoryRange(trace: TraceFrame[], start: number, end: number) {
  const rollback = end > start && trace[end - 1].phase === 'rollback' ? end - 1 : null;
  const last = Math.max(start, (rollback ?? end) - 1);
  const origin = trace[start]?.sim_time ?? 0;
  return {
    start,
    last,
    rollback,
    origin,
    duration: Math.max(0, (trace[last]?.sim_time ?? origin) - origin),
  };
}

export function frameAtTime(trace: TraceFrame[], start: number, last: number, time: number) {
  let low = start,
    high = last;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (trace[mid].sim_time < time) low = mid + 1;
    else high = mid;
  }
  return low > start && time - trace[low - 1].sim_time < trace[low].sim_time - time ? low - 1 : low;
}
