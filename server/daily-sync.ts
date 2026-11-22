/**
 * Daily sync (docs/sync-plan.md phase 4, step 3). Decided on 22 Nov 2026: once a day, when it is due,
 * not at a fixed time (the computer is not on at night).
 *
 * A project with sync on is due when its last sync started DUE_HOURS (24) ago or more, or when it
 * never synced. A sync that a person starts counts too. A failed or cancelled sync counts as well, so
 * a broken sync runs again the next day, not each minute. An interrupted sync (the server stopped, for
 * example a restart of "npm run dev") does not count: it runs again at the next check.
 * While any test run holds the shared test lock (data/test-run.lock: another project's sync, or
 * run-spec of the mapping loop), no daily sync starts: it would fail at its test step.
 * The server checks each minute, from 1 minute after it starts, and syncs the due projects one after the other, with the tests in "auto" mode: a partial
 * run after a code change, a full run when the last full run is 7 days old (server/selection.ts), and
 * no test run when nothing changed. A project that cannot start now (a sync, an AI update or a mapping
 * loop runs) is tried again at the next check.
 *
 * TRACKER_DAILY_SYNC=off turns it off. TRACKER_DAILY_SYNC_HOURS=12 changes the 24 hours.
 */
import { db } from './db.ts';
import { loadProjects } from './projects.ts';
import { startSync, SyncError } from './sync.ts';
import { testRunLockHolder } from './test-run.ts';

const DUE_HOURS = (() => {
  const v = Number.parseFloat(process.env.TRACKER_DAILY_SYNC_HOURS ?? '');
  return v > 0 ? v : 24;
})();
const isOn = () => !/^(off|false|0)$/i.test((process.env.TRACKER_DAILY_SYNC ?? '').trim());

export interface DueInfo {
  project: string;
  /** Start of the last sync of the project (any status), or null. */
  lastSyncAt: string | null;
  /** When the project is due: now or later. */
  dueAt: string;
  due: boolean;
}

/** The due state of each project with sync on. */
export function dueProjects(now = new Date()): DueInfo[] {
  return loadProjects()
    .filter((p) => p.syncBranch)
    .map((p) => {
      const last = (db.prepare("SELECT MAX(started_at) AS t FROM syncs WHERE project_id = ? AND status != 'interrupted'").get(p.id) as any)?.t ?? null;
      const dueAt = last ? new Date(new Date(last).getTime() + DUE_HOURS * 3_600_000) : now;
      return { project: p.id, lastSyncAt: last, dueAt: dueAt.toISOString(), due: dueAt <= now };
    });
}

let running: string | null = null;
/** Why a due project waits, by project. Set when it cannot start; cleared when it starts or is not due. */
const notes = new Map<string, string>();

/** Syncs the due projects, one after the other. */
export async function runDue(log: (l: string) => void = console.log): Promise<void> {
  if (running) return;
  const wait = (project: string, why: string) => {
    // Log a reason only once, not each minute.
    if (notes.get(project) !== why) log(`Daily sync of ${project} waits: ${why}`);
    notes.set(project, why);
  };
  try {
    for (const d of dueProjects()) {
      if (!d.due) {
        notes.delete(d.project);
        continue;
      }
      const lock = testRunLockHolder();
      if (lock) {
        wait(d.project, `another test run (process ${lock}) uses the test sites now`);
        continue;
      }
      running = d.project;
      try {
        const { syncId, done } = startSync(d.project, 'auto');
        notes.delete(d.project);
        log(`Daily sync: ${d.project} (sync ${syncId}; the last sync started ${d.lastSyncAt ?? 'never'})`);
        await done;
      } catch (e) {
        // Busy (a sync, an AI update or a mapping loop): try again at the next check.
        if (!(e instanceof SyncError)) throw e;
        wait(d.project, (e as Error).message);
      } finally {
        running = null;
      }
    }
  } finally {
    running = null;
  }
}

/** The state for the app. */
export function dailySyncState() {
  return { on: isOn(), hours: DUE_HOURS, running, projects: dueProjects().map((d) => ({ ...d, waiting: notes.get(d.project) ?? null })) };
}

/** Checks each minute for due projects, from 1 minute after the server starts. */
export function startDailySync(log: (l: string) => void = console.log) {
  if (!isOn()) {
    log('Daily sync: off (TRACKER_DAILY_SYNC=off)');
    return;
  }
  const tick = () => {
    if (running) return;
    runDue(log).catch((e) => log(`Daily sync failed: ${(e as Error).message}`));
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  const due = dueProjects().filter((d) => d.due).map((d) => d.project);
  log(`Daily sync: each project once each ${DUE_HOURS} hours, when it is due. Due now: ${due.join(', ') || 'none'}.`);
}
