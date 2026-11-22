/**
 * Daily sync (docs/sync-plan.md phase 4, step 3). Decided on 22 Nov 2026: once a day, when it is due,
 * not at a fixed time (the computer is not on at night).
 *
 * A project with sync on is due when its last sync started dailySyncHours (24) ago or more, or when it
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
 * The Settings screen turns it off, or changes the 24 hours (TRACKER_DAILY_SYNC, TRACKER_DAILY_SYNC_HOURS win).
 *
 * The AI step (docs/sync-plan.md phase 8). When no project is due for a sync, the runner gives one
 * project at a time to the AI:
 *  1. The AI update (server/ai-update.ts runReview): the features whose tests or code changed since
 *     the last AI check.
 *  2. The mapping loop (server/map-loop.ts), with at most dailyAiUnits units: changed, new and unlinked
 *     test files, then the code that no test runs.
 * A project gets the AI step after each sync, until the loop finds no unit left. At the unit limit,
 * it waits until the next day, so each project gets some AI work each day.
 * The syncs go first: the AI step stops between 2 units (or 2 features) when a sync is due.
 * The AI step uses the same Claude plan as the user's own sessions. It does not start, and it stops
 * between units, when a run reported dailyAiMaxUse % use or more of a limit window (default 80). It
 * waits until that window resets. A loop or AI update that a person starts has no such stop.
 * All the numbers, the model, and both on/off switches are on the Settings screen (server/settings.ts).
 * An environment variable (TRACKER_DAILY_SYNC, TRACKER_DAILY_AI, TRACKER_DAILY_AI_UNITS …) wins.
 */
import { db } from './db.ts';
import { loadProjects } from './projects.ts';
import { startSync, SyncError } from './sync.ts';
import { testRunLockHolder } from './test-run.ts';
import { aiRunning, runReview } from './ai-update.ts';
import { markLoopStopped, startMapLoop } from './map-loop.ts';
import { mapLoopRunning, syncRunning } from './sync.ts';
import { planUse } from './plan-limit.ts';
import { setting } from './settings.ts';

// The Settings screen (server/settings.ts) sets these; an environment variable wins. Each is read
// when it is needed, so a change works at the next check, with no restart.
const dueHours = () => setting<number>('dailySyncHours');
const isOn = () => setting<boolean>('dailySync');
const aiOn = () => setting<boolean>('dailyAi');
const aiUnits = () => setting<number>('dailyAiUnits');
const aiMaxUse = () => setting<number>('dailyAiMaxUse');
/** The model of the daily AI step. Default: sonnet (decided on 22 Nov 2026: it uses less of the plan). */
const aiModel = () => setting<string>('dailyAiModel');

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
      const dueAt = last ? new Date(new Date(last).getTime() + dueHours() * 3_600_000) : now;
      return { project: p.id, lastSyncAt: last, dueAt: dueAt.toISOString(), due: dueAt <= now };
    });
}

let running: string | null = null;
/** Why a due project waits, by project. Set when it cannot start; cleared when it starts or is not due. */
const notes = new Map<string, string>();

/** Syncs the due projects, one after the other. */
export async function runDue(log: (l: string) => void = console.log, o: { evenIfOff?: boolean } = {}): Promise<void> {
  if (running) return;
  const wait = (project: string, why: string) => {
    // Log a reason only once, not each minute.
    if (notes.get(project) !== why) log(`Daily sync of ${project} waits: ${why}`);
    notes.set(project, why);
  };
  try {
    for (const d of dueProjects()) {
      // Switched off on the Settings screen while the syncs ran: start no more. The daily-sync command
      // of a person syncs anyway.
      if (!o.evenIfOff && !isOn()) return;
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

// ---- The AI step ----

/** The project and step that the AI works on now. */
let aiNow: { project: string; step: 'review' | 'map'; startedAt: string } | null = null;
/** The AI step waits until this time (ms): the plan use is at aiMaxUse() or more. */
let aiWaitUntil: number | null = null;
/** The last AI note, for the app (a stop reason, an error). */
let aiNote: string | null = null;
/** By project: the day the AI step could not start (an error). It tries again the next day. */
const aiCapped = new Map<string, string>();
const day = () => new Date().toISOString().slice(0, 10);

/**
 * The loops of the daily AI step are rows in map_loops (started_by "sync"), so a server restart
 * keeps these facts. Done: a loop after the last sync found no unit left. Capped: a loop of today
 * reached the unit limit.
 */
function aiFinished(projectId: string, syncStartedAt: string): string | null {
  const done = db
    .prepare("SELECT 1 FROM map_loops WHERE project_id = ? AND started_by = 'sync' AND status = 'done' AND stop_reason LIKE 'No unit is left%' AND started_at > ? LIMIT 1")
    .get(projectId, syncStartedAt);
  if (done) return 'done';
  if (aiCapped.get(projectId) === day()) return 'capped';
  // A person stopped a daily loop today, or a daily loop failed: no new start today. A loop whose
  // process is gone (a server restart) does not count: the step goes on after the restart.
  const ended = db
    .prepare(
      `SELECT 1 FROM map_loops WHERE project_id = ? AND started_by = 'sync' AND substr(started_at, 1, 10) = ?
       AND (stop_reason = 'Stopped by a person' OR (status = 'failed' AND COALESCE(stop_reason, '') <> 'The process that ran the loop is gone')) LIMIT 1`,
    )
    .get(projectId, day());
  if (ended) return 'stopped';
  if (unitsToday(projectId) >= aiUnits()) return 'capped';
  return null;
}

/** Units that the daily loops of today ran for the project. A unit that was stopped before its save runs again, so it does not count. */
function unitsToday(projectId: string): number {
  return (db
    .prepare(
      `SELECT COUNT(*) AS n FROM map_runs r JOIN map_loops l ON l.id = r.loop_id
       WHERE l.project_id = ? AND l.started_by = 'sync' AND substr(l.started_at, 1, 10) = ? AND r.status IN ('done', 'skipped', 'failed')`,
    )
    .get(projectId, day()) as any).n as number;
}

/**
 * Projects that are due for a sync and can sync now. A due project that waits (its own mapping loop
 * or AI update runs, so its sync cannot start) does not hold back the AI step of the other projects.
 */
function dueNow(): string[] {
  return dueProjects().filter((d) => d.due && !notes.has(d.project)).map((d) => d.project);
}

/** A reason to stop the AI step now, or null. */
function aiStopReason(): string | null {
  if (!isOn() || !aiOn()) return 'The daily sync or its AI step was switched off on the Settings screen.';
  if (dueNow().length) return 'A daily sync is due. The AI step goes on after the syncs.';
  const use = planUse(aiModel());
  if (use && use.value * 100 >= aiMaxUse()) return `The ${use.window} use of the Claude plan is ${Math.round(use.value * 100)}% (the AI step stops at ${aiMaxUse()}%).`;
  return null;
}

/** Gives one project the AI step, when no sync is due. Returns after that project. */
export async function runAiStep(log: (l: string) => void = console.log): Promise<void> {
  if (!aiOn() || aiNow) return;
  if (dueNow().length) return;
  const use = planUse(aiModel());
  if (use && use.value * 100 >= aiMaxUse()) {
    // Wait for the reset of the window. Without a reset time, look again in one hour.
    if (aiWaitUntil === null) log(`Daily AI step waits: the ${use.window} use of the Claude plan is ${Math.round(use.value * 100)}%.`);
    aiWaitUntil = use.resetsAt ?? Date.now() + 3_600_000;
    return;
  }
  if (aiWaitUntil !== null && aiWaitUntil > Date.now()) return;
  aiWaitUntil = null;
  if (testRunLockHolder()) return;
  for (const p of loadProjects().filter((x) => x.syncBranch)) {
    const last = db.prepare('SELECT id, status, started_at FROM syncs WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(p.id) as any;
    // A project that never synced gets the AI step after its first sync.
    if (!last || last.status === 'running') continue;
    // First mark the loops of a process that is gone (a server restart), so their units count.
    markLoopStopped(p.id);
    if (aiFinished(p.id, last.started_at)) continue;
    if (syncRunning(p.id) || mapLoopRunning(p.id) || aiRunning(p.id)) continue;
    const say = (l: string) => log(`AI step ${p.id}: ${l}`);
    aiNote = null;
    try {
      aiNow = { project: p.id, step: 'review', startedAt: new Date().toISOString() };
      const rv = await runReview(p, { model: aiModel(), onLine: say, shouldStop: aiStopReason });
      if (rv.stoppedBy) {
        aiNote = `${p.id}: the AI update stopped: ${rv.stoppedBy}`;
        say(`stopped: ${rv.stoppedBy}`);
        return;
      }
      aiNow = { project: p.id, step: 'map', startedAt: new Date().toISOString() };
      // The units of today's earlier daily loops count: a loop that a due sync stopped does not get a new 10.
      const left = aiUnits() - unitsToday(p.id);
      if (left <= 0) return;
      const { loopId, done } = startMapLoop(p, { model: aiModel(), maxUnits: left, startedBy: 'sync', shouldStop: aiStopReason, onLine: say });
      await done;
      // The loop row says if the project is done or capped (aiFinished). Other ends: note the reason.
      const row = db.prepare('SELECT status, stop_reason FROM map_loops WHERE id = ?').get(loopId) as any;
      const reason = String(row?.stop_reason ?? '');
      if (!(row?.status === 'done' && (reason.startsWith('No unit is left') || reason.startsWith('The unit limit')))) aiNote = `${p.id}: the mapping loop ended: ${reason || row?.status}`;
    } catch (e) {
      // For example: setpriv is missing. Try again the next day, not each minute.
      aiCapped.set(p.id, day());
      aiNote = `${p.id}: ${(e as Error).message}`;
      say(`could not run: ${(e as Error).message}`);
    } finally {
      aiNow = null;
    }
    return;
  }
}

/** The state for the app. */
export function dailySyncState() {
  return {
    on: isOn(),
    hours: dueHours(),
    running,
    projects: dueProjects().map((d) => ({ ...d, waiting: notes.get(d.project) ?? null })),
    ai: {
      on: isOn() && aiOn(),
      units: aiUnits(),
      maxUse: aiMaxUse(),
      now: aiNow,
      waitingUntil: aiWaitUntil !== null && aiWaitUntil > Date.now() ? new Date(aiWaitUntil).toISOString() : null,
      note: aiNote,
      planUse: planUse(aiModel()),
    },
  };
}

/** Checks each minute for due projects, from 1 minute after the server starts. */
export function startDailySync(log: (l: string) => void = console.log) {
  // The timer always runs: the Settings screen can turn the daily sync on or off at any time.
  let busy = false;
  const tick = () => {
    if (running || busy || !isOn()) return;
    busy = true;
    runDue(log)
      .catch((e) => log(`Daily sync failed: ${(e as Error).message}`))
      .then(() => runAiStep(log))
      .catch((e) => log(`Daily AI step failed: ${(e as Error).message}`))
      .finally(() => (busy = false));
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  const due = dueProjects().filter((d) => d.due).map((d) => d.project);
  if (!isOn()) return log('Daily sync: off (Settings screen). It starts when you turn it on there.');
  log(`Daily sync: each project once each ${dueHours()} hours, when it is due. Due now: ${due.join(', ') || 'none'}.`);
  log(aiOn() ? `Daily AI step (${aiModel()}): after the syncs, at most ${aiUnits()} units for each project each day; it stops at ${aiMaxUse()}% plan use.` : 'Daily AI step: off (Settings screen)');
}
