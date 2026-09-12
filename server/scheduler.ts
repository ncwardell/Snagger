import { db } from './db';
import { refreshSourceRow } from './refresh';
import type { SourceRow } from './sources';

const CHECK_INTERVAL_MS = 60_000; // every minute
const FIRST_CHECK_DELAY_MS = 10_000;

let timer: ReturnType<typeof setInterval> | null = null;
let runningTick = false;
let _lastTickAt = 0;
let _refreshesFired = 0;

const selectDue = db.query<SourceRow & { refresh_interval_ms: number }, [number]>(`
  SELECT s.*, s.refresh_interval_ms FROM sources s
  WHERE s.enabled = 1
    AND s.refresh_interval_ms > 0
    AND (s.last_refreshed IS NULL OR s.last_refreshed + s.refresh_interval_ms <= ?)
  ORDER BY COALESCE(s.last_refreshed, 0) ASC
`);

async function tick(): Promise<void> {
  if (runningTick) return;
  runningTick = true;
  _lastTickAt = Date.now();
  try {
    const due = selectDue.all(Date.now());
    for (const row of due) {
      try {
        console.log(`[scheduler] refreshing "${row.name}" (interval=${(row.refresh_interval_ms / 1000 / 60).toFixed(0)}m)`);
        await refreshSourceRow(row);
        _refreshesFired++;
      } catch (e) {
        console.error(`[scheduler] refresh ${row.name} failed:`, (e as Error).message);
      }
    }
  } finally {
    runningTick = false;
  }
}

export function startScheduler(): void {
  if (timer) return;
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  timer = setInterval(tick, CHECK_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export function schedulerStats(): { lastTickAt: number; refreshesFired: number; running: boolean } {
  return { lastTickAt: _lastTickAt, refreshesFired: _refreshesFired, running: runningTick };
}

/** Compute when each enabled source will next be due. */
export function nextDueTimes(): Array<{ id: number; name: string; nextDueAt: number | null }> {
  const rows = db.query<{ id: number; name: string; enabled: number; last_refreshed: number | null; refresh_interval_ms: number }, []>(
    `SELECT id, name, enabled, last_refreshed, refresh_interval_ms FROM sources`
  ).all();
  return rows.map(r => {
    if (!r.enabled || r.refresh_interval_ms === 0) return { id: r.id, name: r.name, nextDueAt: null };
    const last = r.last_refreshed ?? 0;
    return { id: r.id, name: r.name, nextDueAt: last + r.refresh_interval_ms };
  });
}
