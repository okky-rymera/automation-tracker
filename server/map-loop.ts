/**
 * Mapping loop: headless Claude (`claude -p`) runs the map-features skill one unit at a time, until
 * no unit is left or a limit stops it. A person then reviews the result in the app (review state:
 * new, changed, reviewed).
 *
 * The runner owns the loop, not the model:
 *  1. `map next` picks the unit (Playwright files, then Cypress files, then code areas).
 *  2. One `claude -p` run maps that one unit with the skill. The run can use only the tools in
 *     ALLOWED_TOOLS (--permission-mode dontAsk refuses each other tool). It runs under setpriv
 *     --no-new-privs, with the no-sudo stubs first in PATH.
 *  3. The runner checks that the unit was saved or skipped (processed_units). If not, `next` would
 *     give the same unit again, so a unit gets one more try. After 2 fails, the runner parks it
 *     (`map park`): `next` skips it until its files change, and the loop goes on with the next unit.
 *  4. The runner stops the test site after each unit.
 * The run uses the claude.ai login (the plan), not an API key, so it has no dollar limit. The
 * runner reads the plan limit events of the run (stream-json, rate_limit_event):
 *  - The 5-hour or weekly limit is reached: the runner stops the run, and the loop stops. The unit
 *    is "stopped", not "failed": it was not saved, and it runs again at the next start.
 *  - The run starts to use extra usage (paid, past the plan): the same stop.
 * The loop stops at: no unit left, the unit limit, a plan limit, or a stop from a person. A unit that runs longer than 60 minutes is stopped and counts as failed.
 *
 * Each start is a row in map_loops, and each unit a row in map_runs, with its cost (a list-price
 * estimate of the plan use) and the final message of the run (what it did, its open questions). A
 * sync and an AI update do not start while a loop runs, and the reverse: they use the same copy and
 * test site.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, DB_FILE, now } from './db.ts';
import { getProject, ROOT, type ProjectConfig } from './projects.ts';
import { childEnv, mapLoopRunning, processAlive, run, SETPRIV, syncRunning, type Job } from './sync.ts';
import { aiRunning } from './ai-update.ts';
import { stopTestSites } from './echowp.ts';
import { clearDeadLock, runTests, stopLeftoverRunSpec, type RunPlan } from './test-run.ts';
import { LIMIT_TEXT, notePlanUse, readPlanLine } from './plan-limit.ts';

const execFileAsync = promisify(execFile);

export const MAP_DEFAULTS = { model: 'opus', maxUnits: 10 };
/** The highest unit limit. startMapLoop refuses a value above it. */
export const MAP_LIMITS = { maxUnits: 200 };

/**
 * Checks the unit limit that a person gave. A bad value must stop the start: as NaN, the limit
 * would be off, because each comparison with NaN is false.
 */
function checkLimits(o: MapLoopOptions) {
  const v = o.maxUnits;
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > MAP_LIMITS.maxUnits) {
    throw new MapLoopError(`The unit limit must be a whole number from 1 to ${MAP_LIMITS.maxUnits} (got ${String(v)}).`);
  }
}
/** A run that takes longer than this is stopped. A Playwright unit with screenshots takes about 10 to 20 minutes. */
const UNIT_TIMEOUT_MS = 60 * 60 * 1000;
/** After a timeout or a stop: the time from SIGTERM to SIGKILL. */
const KILL_GRACE_MS = 30_000;
const SCRATCH = path.join(ROOT, 'data', 'map-loop');

export class MapLoopError extends Error {}

export { LIMIT_TEXT, readPlanLine, type PlanLine } from './plan-limit.ts';

export interface MapLoopOptions {
  model?: string;
  maxUnits?: number;
  startedBy?: 'app' | 'cli' | 'sync';
  onLine?: (line: string) => void;
  /** Checked before each unit. A reason stops the loop there (the daily sync: a sync is due, or the plan use is high). */
  shouldStop?: () => string | null;
}

/** Tools of the run. Each other tool, and each other command, is refused without a question. */
function allowedTools(scratch: string): string[] {
  return [
    'Read', 'Grep', 'Glob', 'Skill',
    // Payloads and screenshots go only to the scratch folder of the run. An Edit rule covers the
    // Write tool too. A Write(...) rule does not work: tested on 20 Nov 2026, the write was refused.
    `Edit(/${scratch}/**)`,
    // Only the steps of the skill. Not "reset" or "move-scope": those are a person's commands.
    ...['status', 'next', 'features', 'feature', 'code', 'test-code', 'apply', 'skip', 'screenshots'].map((c) => `Bash(npm run -s map -- ${c}:*)`),
    'Bash(npm run -s project -- list)',
    'Bash(npm run -s project -- run-spec:*)',
    'Bash(npm run -s project -- echowp:*)',
    'Bash(playwright-cli:*)',
    'Bash(faillock:*)',
  ];
}

interface Unit {
  kind: 'playwright' | 'cypress' | 'code';
  /** The file of a test unit. For code: the first candidate file (the model names the area). */
  ref: string;
  raw: any;
}

async function mapCmd(args: string[]): Promise<any> {
  const { stdout } = await execFileAsync('npx', ['tsx', path.join(ROOT, 'server', 'map.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
  });
  return JSON.parse(stdout);
}

async function nextUnit(p: ProjectConfig): Promise<Unit | null> {
  const n = await mapCmd(['next', p.id]);
  if (n.kind === 'code') {
    if (!n.candidates?.length) return null;
    return { kind: 'code', ref: n.candidates[0].file, raw: n };
  }
  if (n.done || !n.ref) return null;
  return { kind: n.kind, ref: n.ref, raw: n };
}

function prompt(p: ProjectConfig, u: Unit, scratch: string): string {
  const what =
    u.kind === 'code'
      ? `the next code area. Run \`npm run -s map -- next ${p.id} code\`, and choose one plugin feature or settings area, as the skill says.`
      : `the ${u.kind} unit "${u.ref}" (from \`npm run -s map -- next ${p.id} ${u.kind}\`).`;
  return `/map-features Map exactly one unit of project ${p.id}: ${what}

You run headless, in a loop. No person reads this session or answers a question. So:
- Do only this one unit. Do not start a second unit.
- Finish the unit with "map apply" (or "map skip" when the unit has no feature). A unit that is not saved counts as failed.
- Decide each test of the file: link it, or put it in "leftOut" with a reason. When "next" gives "unlinkedTests", decide only those tests: the other tests are done.
- Put a question for a person in the feature's "questions" list, not in this session.
- Write the payload JSON and the screenshots only in this folder: ${scratch}
- Do not run Cypress (\`npx cypress\` is refused). For a Cypress unit, read the step definitions and try the feature with playwright-cli.
- Start the test site only with \`npm run -s project -- echowp ${p.id} up --count 1 --profile test\`. It sets the plugin's admin login itself. Do not read the .env file into a command.
- Run a Playwright spec only with \`npm run -s project -- run-spec ${p.id} <unit ref>\`, never with npx playwright. Give the Bash call a timeout of 600000.
- Run the failed-login check with the user name typed out: \`faillock --user ${os.userInfo().username}\`. A command with \`$USER\` is refused.
- Commands that the skill does not name are refused. Do not try other ways around a refused command: say it in the report.
- Before you finish: close the browser (\`playwright-cli close\`).

Your final message is the report of step 5 of the skill, in plain words: the unit, how you checked it and the test result, the features and scopes, the links, the code, the screenshots, the open questions, and the text of a person that the tool kept. Do not add the next command to run.`;
}

interface UnitResult {
  ok: boolean;
  costUsd: number | null;
  durationMs: number | null;
  report: string;
  error: string | null;
  /** Set when a plan limit (or extra usage) stopped the run: the reason, with the reset time. */
  planLimit: string | null;
  /** The last plan use that the run reported, for example "5-hour 24%, weekly 53%". */
  planUse: string | null;
  /** The run took longer than UNIT_TIMEOUT_MS and was stopped. */
  timedOut?: boolean;
}

async function runUnit(p: ProjectConfig, u: Unit, o: { model: string }, onStart: (pid: number | undefined) => void, job: Job): Promise<UnitResult> {
  const scratch = path.join(SCRATCH, `${p.id}-${Date.now()}`);
  fs.mkdirSync(scratch, { recursive: true });
  const args = [
    '-p',
    '--model', o.model,
    // One JSON line for each event. The plan limit events (rate_limit_event) come only in this format.
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'dontAsk',
    '--allowedTools', ...allowedTools(scratch),
    '--add-dir', scratch,
    // No MCP servers of the user's setup. The skills of this repo (and playwright-cli) stay.
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
  // Spec runs take some minutes: the default Bash timeout (2 minutes) is too short.
  // MAP_LOOP_SCRATCH: "map screenshots" refuses a folder outside the scratch folder.
  const env = childEnv({ BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '900000', MAP_LOOP_SCRATCH: scratch });
  // The claude.ai login (plan use), not an API key: a key in the environment would win and bill the key.
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete env[k];
  let timedOut = false;
  const child = () => job.child;
  const killGroup = (sig: NodeJS.Signals) => {
    const pid = child()?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      /* gone */
    }
  };
  const timers: NodeJS.Timeout[] = [];
  /** SIGTERM now, and SIGKILL after a grace time: claude can ignore SIGTERM. */
  const stopRun = () => {
    killGroup('SIGTERM');
    timers.push(setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS));
  };
  timers.push(
    setTimeout(() => {
      timedOut = true;
      stopRun();
    }, UNIT_TIMEOUT_MS),
  );
  // Read the output line by line: the result and the plan limit events (JSON, on stdout), and the
  // last lines of stderr (Claude Code's own messages).
  let out: any = null;
  let planLimit: string | null = null;
  let planUse: string | null = null;
  const textTail: string[] = [];
  const onLine = (l: string, stream: 'stdout' | 'stderr') => {
    // stderr, or a stdout line that is not JSON: a message of Claude Code.
    if (stream === 'stderr' || !l.startsWith('{')) {
      if (l.trim()) {
        textTail.push(l.slice(0, 300));
        if (textTail.length > 3) textTail.shift();
      }
      return;
    }
    const plan = readPlanLine(l, o.model);
    notePlanUse(plan);
    if (plan) {
      if (plan.use) planUse = plan.use;
      // Do not wait for claude: it can wait for the limit to reset. Stop the run now.
      if (plan.stop && !planLimit) {
        planLimit = plan.stop;
        stopRun();
      }
      return;
    }
    if (l.includes('"type":"result"')) {
      try {
        const v = JSON.parse(l);
        if (v?.type === 'result') out = v;
      } catch {
        /* not JSON */
      }
    }
  };
  try {
    const started = run(job, 'claude', args, { cwd: ROOT, env, quiet: true, input: prompt(p, u, scratch), onLine });
    onStart(job.child?.pid);
    // A command that claude started in its own process group (a run-spec) can keep the output
    // pipes open after claude is gone (a timeout or a stop). Then "close" never comes, and the run
    // would never end. So close the pipes 10 s after claude exits. The loop then stops that
    // run-spec (stopLeftoverRunSpec).
    const c = job.child;
    c?.once('exit', () => {
      timers.push(
        setTimeout(() => {
          c.stdout?.destroy();
          c.stderr?.destroy();
        }, 10_000),
      );
    });
    const res = await started;
    const base = { planUse };
    if (planLimit) {
      const cost = typeof out?.total_cost_usd === 'number' ? out.total_cost_usd : null;
      const duration = typeof out?.duration_ms === 'number' ? out.duration_ms : null;
      return { ...base, ok: false, costUsd: cost, durationMs: duration, report: typeof out?.result === 'string' ? out.result : '', error: planLimit, planLimit };
    }
    if (!out) {
      const tail = textTail.join(' | ');
      if (timedOut) return { ...base, ok: false, costUsd: null, durationMs: UNIT_TIMEOUT_MS, report: '', error: `The unit took longer than ${UNIT_TIMEOUT_MS / 60000} minutes and was stopped.`, planLimit: null, timedOut };
      const hit = textTail.find((l) => LIMIT_TEXT.test(l));
      const limit = hit ? `The Claude plan limit is reached: ${hit.trim()}` : null;
      return { ...base, ok: false, costUsd: null, durationMs: null, report: '', error: limit ?? `claude gave no result (exit ${res.code ?? res.signal}): ${tail}`, planLimit: limit };
    }
    const costUsd = typeof out.total_cost_usd === 'number' ? out.total_cost_usd : null;
    const durationMs = typeof out.duration_ms === 'number' ? out.duration_ms : null;
    const report = typeof out.result === 'string' ? out.result : '';
    if (out.is_error || out.subtype !== 'success') {
      // Claude Code puts its own limit message in the result text. LIMIT_TEXT matches it only at the
      // start, so a report that talks about a "usage limit" setting does not match.
      const limit = LIMIT_TEXT.test(report) ? `The Claude plan limit is reached: ${report.slice(0, 300)}` : null;
      return { ...base, ok: false, costUsd, durationMs, report, error: limit ?? `claude stopped: ${out.subtype ?? 'error'}${report ? ': ' + report.slice(0, 300) : ''}`, planLimit: limit };
    }
    return { ...base, ok: true, costUsd, durationMs, report, error: null, planLimit: null };
  } catch (e) {
    return { ok: false, costUsd: null, durationMs: null, report: '', error: (e as Error).message, planLimit: null, planUse };
  } finally {
    for (const t of timers) clearTimeout(t);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A short coverage run of one Playwright spec file, before its unit, when the selected coverage run
 * has no test of the file (a new file, and no sync ran it yet). It is a partial run: the new run
 * keeps the other tests of the selected run (coverage/merge-run.py), and it becomes the selected run.
 * Not for Cypress (slow), and not without a selected Playwright run (nothing to keep). A failure only
 * goes in the log: the model then finds the code by reading it.
 */
export async function coverageFirst(p: ProjectConfig, u: Unit, job: Job, log: (l: string) => void, shouldStop?: () => string | null) {
  if (u.kind !== 'playwright' || u.raw?.coverage !== false) return;
  const fresh = getProject(p.id) ?? p;
  const base = fresh.runs.playwright;
  if (!base) return log(`No coverage run for "${u.ref}": the project has no selected Playwright run to add it to. The model reads the code.`);
  let info: any = {};
  try {
    info = JSON.parse(fs.readFileSync(path.join(ROOT, base.dir, 'run-info.json'), 'utf8'));
  } catch {
    /* an old run: no full-run date */
  }
  let commit: string;
  try {
    commit = (await execFileAsync('git', ['-C', fresh.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
  } catch (e) {
    return log(`No coverage run for "${u.ref}": ${(e as Error).message}`);
  }
  // A unit ref is relative to the spec folder ("frontend/x.spec.js"). The run names a file relative to
  // the folder above it ("specs/frontend/x.spec.js"), as server/selection.ts does.
  if (!fresh.playwrightDir) return log(`No coverage run for "${u.ref}": the project has no Playwright folder.`);
  const file = path.posix.join(path.posix.relative(path.posix.dirname(fresh.playwrightDir), fresh.playwrightDir), u.ref);
  const plan: RunPlan = {
    files: [file],
    baseDir: base.dir,
    info: { fullRunAt: info.fullRunAt ?? null, untested: info.untested ?? [], partial: { fromRun: base.dir, fromCommit: info.pluginCommit ?? null, reason: `the mapping loop: "${u.ref}" was not in the coverage run` } },
  };
  log(`"${u.ref}" is not in the coverage run. A short coverage run of this file first.`);
  try {
    const r = await runTests(fresh, commit, {
      run: (c, a, o) => run(job, c, a, o),
      env: (extra) => childEnv(extra),
      log: () => {},
      // A stop of the daily sync (a due sync, a high plan use) ends the run between its steps too.
      cancelled: () => job.cancelled || !!shouldStop?.(),
      signal: job.abort.signal,
    }, plan);
    log(r.selected ? `Coverage run done and selected: ${r.runDir ?? ''}` : `The coverage run was not selected: ${r.reason ?? 'no reason given'}. The model reads the code.`);
  } catch (e) {
    log(`The coverage run failed: ${(e as Error).message}. The model reads the code.`);
  }
}

/** The units that a run saved or skipped since it started. Code: the area that the model named. */
function savedUnits(p: ProjectConfig, u: Unit, since: string): { ref: string; status: string; features: number[] }[] {
  const rows = (
    u.kind === 'code'
      ? db.prepare("SELECT ref, status, features FROM processed_units WHERE project_id = ? AND kind = 'code' AND processed_at >= ?").all(p.id, since)
      : db.prepare('SELECT ref, status, features FROM processed_units WHERE project_id = ? AND kind = ? AND ref = ? AND processed_at >= ?').all(p.id, u.kind, u.ref, since)
  ) as any[];
  return rows.map((r) => ({ ref: r.ref, status: r.status, features: r.features ? JSON.parse(r.features) : [] }));
}

/** Ends a loop whose process is gone (a server restart), and its running unit, and stops its claude run. */
export function markLoopStopped(projectId: string) {
  for (const l of db.prepare("SELECT id, owner_pid FROM map_loops WHERE project_id = ? AND status = 'running'").all(projectId) as any[]) {
    if (l.owner_pid === process.pid ? live.has(l.id) : processAlive(l.owner_pid)) continue;
    for (const r of db.prepare("SELECT id, claude_pid FROM map_runs WHERE loop_id = ? AND status = 'running'").all(l.id) as any[]) {
      if (r.claude_pid && processAlive(r.claude_pid)) {
        try {
          process.kill(-r.claude_pid, 'SIGTERM');
        } catch {
          /* gone */
        }
      }
      db.prepare("UPDATE map_runs SET status = 'failed', finished_at = ?, claude_pid = NULL, error = 'The loop stopped before the end of this unit (its process is gone)' WHERE id = ?").run(now(), r.id);
    }
    db.prepare("UPDATE map_loops SET status = 'failed', finished_at = ?, stop_reason = 'The process that ran the loop is gone' WHERE id = ?").run(now(), l.id);
  }
}

/** Loops that this process runs now, and their current job (for a stop). */
const live = new Map<number, Job | null>();
const lastError = new Map<string, string>();
const logs = new Map<string, string[]>();

function say(projectId: string, line: string, onLine?: (l: string) => void) {
  const list = logs.get(projectId) ?? [];
  list.push(`${new Date().toLocaleTimeString()} ${line}`);
  logs.set(projectId, list.slice(-200));
  onLine?.(line);
}

/** For the app: the last loops and units, the mapping progress, and the defaults. */
export function mapLoopState(projectId: string) {
  markLoopStopped(projectId);
  const loops = db.prepare('SELECT * FROM map_loops WHERE project_id = ? ORDER BY id DESC LIMIT 10').all(projectId) as any[];
  const runs = db.prepare('SELECT id, loop_id, unit_kind, unit_ref, started_at, finished_at, status, cost_usd, duration_ms, features, report, error FROM map_runs WHERE project_id = ? ORDER BY id DESC LIMIT 50').all(projectId) as any[];
  const total = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS n FROM map_runs WHERE project_id = ?').get(projectId) as any;
  return {
    running: mapLoopRunning(projectId),
    loops,
    runs: runs.map((r) => ({ ...r, features: r.features ? JSON.parse(r.features) : [] })),
    totalUsd: total.usd as number,
    count: total.n as number,
    defaults: MAP_DEFAULTS,
    limits: MAP_LIMITS,
    log: logs.get(projectId) ?? [],
    error: lastError.get(projectId) ?? null,
  };
}

/** Units that failed 2 times in one loop, and wait until their files change (`map park`). */
export function listParked(projectId: string) {
  return (db.prepare('SELECT kind, ref, reason, parked_at FROM parked_units WHERE project_id = ? ORDER BY parked_at DESC').all(projectId) as any[]).map((r) => ({
    kind: r.kind as string, ref: r.ref as string, reason: r.reason as string, parkedAt: r.parked_at as string,
  }));
}

/** "Try again": the unit comes back in the loop. */
export function unpark(projectId: string, kind: string, ref: string): boolean {
  return db.prepare('DELETE FROM parked_units WHERE project_id = ? AND kind = ? AND ref = ?').run(projectId, kind, ref).changes > 0;
}

/** Asks the running loop to stop. The current unit stops too; its partial work is not saved. */
export function stopMapLoop(projectId: string) {
  const rows = db.prepare("SELECT id FROM map_loops WHERE project_id = ? AND status = 'running'").all(projectId) as any[];
  if (!rows.length) throw new MapLoopError('No mapping loop runs for this project.');
  for (const l of rows) {
    db.prepare('UPDATE map_loops SET stop_reason = ? WHERE id = ?').run('Stopped by a person', l.id);
    // A loop of another process (the command line) sees the reason before its next unit. Its claude run stops now.
    for (const r of db.prepare("SELECT claude_pid FROM map_runs WHERE loop_id = ? AND status = 'running' AND claude_pid IS NOT NULL").all(l.id) as any[]) {
      try {
        process.kill(-r.claude_pid, 'SIGTERM');
      } catch {
        /* gone */
      }
      // claude can ignore SIGTERM: kill its group after a grace time, if it still runs.
      setTimeout(() => {
        try {
          process.kill(-r.claude_pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }, KILL_GRACE_MS).unref();
    }
    const job = live.get(l.id);
    if (job) {
      job.cancelled = true;
      job.abort.abort();
      // The commands of the job (the coverage run before a unit) run in their own process groups.
      for (const c of new Set([...(job.children ?? []), ...(job.child ? [job.child] : [])])) {
        try {
          if (c.pid) process.kill(-c.pid, 'SIGTERM');
        } catch {
          /* gone */
        }
      }
    }
  }
}

/** Starts the loop in the background. Throws when a loop, a sync or an AI update of the project runs. */
export function startMapLoop(p: ProjectConfig, o: MapLoopOptions = {}): { loopId: number; done: Promise<void> } {
  checkLimits(o);
  markLoopStopped(p.id);
  if (mapLoopRunning(p.id)) throw new MapLoopError('A mapping loop runs already for this project.');
  if (syncRunning(p.id)) throw new MapLoopError('A sync runs now. Start the mapping loop when it ends.');
  if (aiRunning(p.id)) throw new MapLoopError('An AI update runs now. Start the mapping loop when it ends.');
  // Claude runs commands in the loop. Without setpriv, nothing stops a sudo by its full path.
  if (!SETPRIV) throw new MapLoopError('setpriv is not installed, so the loop cannot block sudo. Install util-linux (setpriv).');
  const model = o.model ?? MAP_DEFAULTS.model;
  const maxUnits = o.maxUnits ?? MAP_DEFAULTS.maxUnits;
  const loopId = Number(
    db
      .prepare("INSERT INTO map_loops (project_id, started_at, status, started_by, model, max_units, owner_pid) VALUES (?, ?, 'running', ?, ?, ?, ?)")
      .run(p.id, now(), o.startedBy ?? 'app', model, maxUnits, process.pid).lastInsertRowid,
  );
  live.set(loopId, null);
  lastError.delete(p.id);
  logs.set(p.id, []);
  const done = loop(p, loopId, { model, maxUnits, shouldStop: o.shouldStop, daily: o.startedBy === 'sync' }, o.onLine).catch((e) => {
    lastError.set(p.id, `The mapping loop stopped: ${(e as Error).message}`);
    db.prepare("UPDATE map_loops SET status = 'failed', finished_at = ?, stop_reason = ? WHERE id = ? AND status = 'running'").run(now(), (e as Error).message, loopId);
    // A unit row must not stay "running" when the loop fails after it added the row.
    db.prepare("UPDATE map_runs SET status = 'failed', finished_at = ?, claude_pid = NULL, error = COALESCE(error, ?) WHERE loop_id = ? AND status = 'running'").run(now(), `The loop failed: ${(e as Error).message}`, loopId);
  }).finally(() => live.delete(loopId));
  return { loopId, done };
}

async function loop(p: ProjectConfig, loopId: number, o: { model: string; maxUnits: number; shouldStop?: () => string | null; daily?: boolean }, onLine?: (l: string) => void) {
  const log = (l: string) => say(p.id, l, onLine);
  const end = (status: string, reason: string) => {
    db.prepare('UPDATE map_loops SET status = ?, finished_at = ?, stop_reason = COALESCE(stop_reason, ?) WHERE id = ?').run(status, now(), reason, loopId);
    log(`Loop ended: ${reason}`);
  };
  // Let the caller (an HTTP request) answer first.
  await new Promise((r) => setImmediate(r));
  // A backup before the first change, as CLAUDE.md asks for large changes. The daily AI step starts a
  // loop for each project each day: one backup for each day is enough there.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const backup = path.join(
    path.dirname(DB_FILE),
    o.daily ? `tracker-backup-${stamp.slice(0, 8)}-before-daily-ai.db` : `tracker-backup-${stamp}-before-map-loop.db`,
  );
  if (!fs.existsSync(backup)) db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  log(`Backup: ${path.relative(ROOT, backup)}. Model ${o.model}, at most ${o.maxUnits} units. The loop stops at the 5-hour or weekly limit of the Claude plan.`);

  let units = 0;
  const failed = new Map<string, number>();
  for (;;) {
    const stop = (db.prepare('SELECT stop_reason FROM map_loops WHERE id = ?').get(loopId) as any)?.stop_reason;
    if (stop) return end('stopped', stop);
    if (units >= o.maxUnits) return end('done', `The unit limit (${o.maxUnits}) is reached.`);
    const why = o.shouldStop?.();
    if (why) return end('stopped', why);
    const u = await nextUnit(p);
    // A stop can come while "map next" runs. Then there is nothing to cancel yet: check again.
    const stopNow = (db.prepare('SELECT stop_reason FROM map_loops WHERE id = ?').get(loopId) as any)?.stop_reason;
    if (stopNow) return end('stopped', stopNow);
    if (!u) return end('done', 'No unit is left to map.');
    const key = `${u.kind}:${u.ref}`;
    // The park after the second fail did not work (see below): stop, or the loop would run it again and again.
    if ((failed.get(key) ?? 0) >= 2) return end('failed', `The unit ${u.kind} "${u.ref}" failed two times. Look at its report.`);

    const since = now();
    const runId = Number(
      db.prepare("INSERT INTO map_runs (loop_id, project_id, unit_kind, unit_ref, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')").run(loopId, p.id, u.kind, u.ref, since).lastInsertRowid,
    );
    log(`Unit ${units + 1}: ${u.kind} ${u.kind === 'code' ? '(the model picks the area)' : `"${u.ref}"`}`);
    const job: Job = { syncId: 0, child: null, cancelled: false, abort: new AbortController() };
    live.set(loopId, job);
    await coverageFirst(p, u, job, log, o.shouldStop);
    // A stop during the coverage run: no claude run was started yet, so nothing else would stop it.
    const stopAfterRun = job.cancelled ? 'Stopped' : ((db.prepare('SELECT stop_reason FROM map_loops WHERE id = ?').get(loopId) as any)?.stop_reason as string | null) ?? o.shouldStop?.() ?? null;
    if (stopAfterRun) {
      live.set(loopId, null);
      db.prepare("UPDATE map_runs SET status = 'stopped', finished_at = ?, error = ? WHERE id = ?").run(now(), `Not started: ${stopAfterRun}`, runId);
      return end('stopped', stopAfterRun);
    }
    const r = await runUnit(p, u, { model: o.model }, (pid) => db.prepare('UPDATE map_runs SET claude_pid = ? WHERE id = ?').run(pid ?? null, runId), job);
    live.set(loopId, null);
    // A stop from a person. The app of another process (a loop that the command line started) sets
    // only the stop reason in the database, and stops claude: job.cancelled is not set here then.
    const stopReason = (db.prepare('SELECT stop_reason FROM map_loops WHERE id = ?').get(loopId) as any)?.stop_reason as string | null;
    const cancelled = job.cancelled || !!stopReason;
    units++;
    // A run-spec that still runs (a unit that timed out) would hold the test-run lock, and the next
    // unit could not run a spec. Stop it before the site.
    try {
      const left = await stopLeftoverRunSpec();
      if (left) log(left);
    } catch (e) {
      log(`Could not stop the test run that was left: ${(e as Error).message}`);
    }
    // The site and the browser must not stay on between units. Async: the server must keep answering.
    try {
      for (const e of await stopTestSites(p)) log(`Could not stop the test site: ${e}`);
    } catch (e) {
      log(`Could not stop the test site: ${(e as Error).message}`);
    }
    clearDeadLock(); // a run-spec that the stop killed
    try {
      await execFileAsync('playwright-cli', ['close'], { cwd: ROOT, env: childEnv(), timeout: 30_000 });
    } catch {
      /* no browser open */
    }

    const saved = savedUnits(p, u, since);
    // A unit that a plan limit or a person stopped is "stopped", not "failed": it was not saved, and
    // "map next" gives it again at the next start.
    const stoppedEarly = !!r.planLimit || cancelled;
    const status = saved.length ? (saved.every((s) => s.status === 'skipped') ? 'skipped' : 'done') : stoppedEarly ? 'stopped' : 'failed';
    const error = saved.length
      ? null
      : r.planLimit
        ? `Not saved: ${r.planLimit} The unit runs again at the next start.`
        : cancelled
          ? 'Not saved: a person stopped the loop. The unit runs again at the next start.'
          : r.error ?? 'The run ended, but it did not save or skip the unit.';
    const ref = u.kind === 'code' && saved.length ? saved.map((s) => s.ref).join(', ') : u.ref;
    db.prepare('UPDATE map_runs SET status = ?, finished_at = ?, cost_usd = ?, duration_ms = ?, features = ?, report = ?, error = ?, unit_ref = ?, claude_pid = NULL WHERE id = ?').run(
      status, now(), r.costUsd, r.durationMs, JSON.stringify([...new Set(saved.flatMap((s) => s.features))]), r.report, error, ref, runId,
    );
    log(`Unit ${units}: ${status}${r.costUsd !== null ? `, $${r.costUsd.toFixed(2)}` : ''}${r.durationMs ? `, ${Math.round(r.durationMs / 60000)} min` : ''}${r.planUse ? ` (plan use: ${r.planUse})` : ''}${error ? `: ${error}` : ''}`);
    if (r.planLimit) return end('stopped', `${r.planLimit} Start the loop again after the reset.`);
    if (cancelled) return end('stopped', stopReason ?? 'Stopped');
    // A unit that took too long counts as failed. The loop goes on. After a second fail, the unit is
    // parked: "map next" skips it until its files change, so a daily loop does not try it each day.
    if (status === 'failed') {
      const n = (failed.get(key) ?? 0) + 1;
      failed.set(key, n);
      if (n >= 2) {
        try {
          await mapCmd(['park', p.id, u.kind, u.ref, `Failed 2 times (loop ${loopId}): ${(error ?? '').slice(0, 300)}`]);
          log(`Unit ${u.kind} "${u.ref}" failed 2 times. It is parked until its files change. "Try again" in the app removes the park.`);
        } catch (e) {
          log(`Could not park ${u.kind} "${u.ref}": ${(e as Error).message}`);
        }
      }
    }
  }
}

/** Ends this process's loops when the process exits (the claude runs are in their own process groups). */
process.on('exit', () => {
  for (const job of live.values()) {
    if (job?.child?.pid) {
      try {
        process.kill(-job.child.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
  }
});

export const projectOrThrow = (id: string) => {
  const p = getProject(id);
  if (!p) throw new MapLoopError(`No project ${id}`);
  return p;
};
