/**
 * Sync: brings the tracker's own copy of a plugin to the latest remote branch, writes the
 * change report, and runs the Playwright tests with coverage when the code changed.
 *
 * Steps (each one is saved in the syncs table, so the app can show it):
 *  1. check   the copy is on the sync branch, has no changed files and no own commits
 *  2. fetch   git fetch, then git merge --ff-only. With the checks of step 1 this gives the
 *             same result as "git reset --hard", but it refuses instead of throwing work away.
 *  3. packages npm ci in the Playwright folder when its package files changed
 *  4. scan    reads the files and tests again
 *  5. report  the change report from the old to the new commit (server/changes.ts)
 *  6. tests   the test run job (server/test-run.ts), when the code changed since the selected run
 *
 * Safety: each command runs without a terminal (own session, no input), with
 * coverage/no-sudo first in PATH (stubs for sudo, su, doas, pkexec and echowp).
 * Sync never runs "git clean": the copy's .env and node_modules are not in git.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.ts';
import { changedFiles, changeReport, playwrightRoot, type ChangeReport } from './changes.ts';
import { getProject, ROOT, type ProjectConfig } from './projects.ts';
import { syncProject } from './scan.ts';
import { runTests, type TestResult } from './test-run.ts';
import { findEchowp } from './echowp.ts';
import { runFreshness } from './coverage.ts';

export type TestMode = 'auto' | 'always' | 'never';

export const NO_SUDO = path.join(ROOT, 'coverage', 'no-sudo');

/** Makes sure that the stubs exist (git keeps the links, but a copy without links can lose them). */
function ensureStubs() {
  for (const n of ['sudo', 'su', 'doas', 'pkexec', 'echowp']) {
    const link = path.join(NO_SUDO, n);
    try {
      fs.lstatSync(link);
    } catch {
      fs.symlinkSync('blocked.sh', link);
    }
  }
}

/** The environment of each command that a sync starts. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  ensureStubs();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${NO_SUDO}${path.delimiter}${process.env.PATH ?? ''}`,
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
  delete env.CI; // CI turns on retries and other CI-only behavior in the test config
  // No password helper: without a terminal and without these, sudo stops before it asks for a password.
  // With an askpass program (or a display for one), sudo would send an empty password to PAM, and that counts as a failed login.
  for (const k of ['SUDO_ASKPASS', 'SSH_ASKPASS', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[k];
  return env;
}

/**
 * setpriv --no-new-privs: the command and its children cannot gain privileges, so a setuid
 * program (sudo, also by its full path /usr/bin/sudo) cannot start as root and stops before it asks.
 */
export const SETPRIV = (() => {
  try {
    execFileSync('setpriv', ['--no-new-privs', '--', 'true'], { stdio: 'ignore' });
    return 'setpriv';
  } catch {
    return null;
  }
})();

/** A command that the running sync started. Cancel stops its whole process group. */
export interface Job {
  syncId: number;
  /** A command that still runs: the last one that started, or else another one that runs. */
  child: ReturnType<typeof spawn> | null;
  /** All commands that run now. A test run starts one setup command for each test site at the same time. */
  children?: Set<ReturnType<typeof spawn>>;
  cancelled: boolean;
  /** Fires on a cancel. It stops work that is not in job.child, such as a build of the coverage PHP. */
  abort: AbortController;
}
const jobs = new Map<string, Job>();

export class SyncError extends Error {}

const MAX_LOG = 200_000;

function appendLog(syncId: number, text: string) {
  const row = db.prepare('SELECT log FROM syncs WHERE id = ?').get(syncId) as any;
  let log = (row?.log ?? '') + text;
  if (log.length > MAX_LOG) log = '…\n' + log.slice(-MAX_LOG);
  db.prepare('UPDATE syncs SET log = ? WHERE id = ?').run(log, syncId);
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Each output line. The sync log gets them too, unless quiet. */
  onLine?: (line: string) => void;
  quiet?: boolean;
  /** Text for the command's standard input. Without it, the input is empty. */
  input?: string;
}

/**
 * Runs a command without a terminal and waits for it. The process gets its own session
 * (detached), so it has no terminal where sudo could ask for a password.
 */
export function run(job: Job, cmd: string, args: string[], o: RunOptions): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new SyncError('Cancelled'));
    const [c, a] = SETPRIV ? [SETPRIV, ['--no-new-privs', '--', cmd, ...args]] : [cmd, args];
    const child = spawn(c, a, { cwd: o.cwd, env: o.env ?? childEnv(), stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
    job.child = child;
    (job.children ??= new Set()).add(child);
    if (o.input !== undefined) {
      // A command that stops before it reads all its input gives EPIPE. Without a handler, that
      // error would stop the whole server. The exit code and output still show what went wrong.
      child.stdin!.on('error', () => {});
      child.stdin!.end(o.input);
    }
    let out = '';
    let partial = '';
    const take = (buf: Buffer) => {
      const text = partial + buf.toString();
      const lines = text.split('\n');
      partial = lines.pop() ?? '';
      for (const l0 of lines) {
        const l = l0.replace(/\r$/, '');
        if (/^\|[■ ]*\|\s+\d+% of/.test(l)) continue; // download bars of "playwright install"
        out += l + '\n';
        if (out.length > 1_000_000) out = out.slice(-500_000);
        o.onLine?.(l);
      }
      const keep = lines.filter((l) => !/^\|[■ ]*\|\s+\d+% of/.test(l));
      if (!o.quiet && keep.length) appendLog(job.syncId, keep.map((l) => l + '\n').join(''));
    };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (partial) take(Buffer.from('\n'));
      job.children?.delete(child);
      // Point to a command that still runs (the setup commands of a test run end in any order).
      if (job.child === child) job.child = [...(job.children ?? [])].pop() ?? null;
      resolve({ code, signal, out });
    });
  });
}

/** Stops the process group of each command of the job: npx, playwright and the browser. */
function killChildren(job: Job) {
  const all = new Set(job.children ?? []);
  if (job.child) all.add(job.child);
  for (const c of all) {
    if (!c.pid) continue;
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

/** Runs a command and fails the sync when it does not end with code 0. */
async function must(job: Job, cmd: string, args: string[], o: RunOptions): Promise<string> {
  const r = await run(job, cmd, args, o);
  if (job.cancelled) throw new SyncError('Cancelled');
  if (r.code !== 0) throw new SyncError(`${cmd} ${args.join(' ')} failed (exit ${r.code ?? r.signal}): ${r.out.trim().split('\n').slice(-3).join(' | ')}`);
  return r.out.trim();
}

const alive = (pid: number | null) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** A sync that is "running" but whose process is gone was interrupted (server stop, crash). */
function markInterrupted(projectId?: string) {
  const rows = db.prepare(`SELECT id, owner_pid FROM syncs WHERE status = 'running' ${projectId ? 'AND project_id = ?' : ''}`).all(...(projectId ? [projectId] : [])) as any[];
  for (const r of rows) {
    const ours = r.owner_pid === process.pid;
    const running = ours ? [...jobs.values()].some((j) => j.syncId === r.id) : alive(r.owner_pid);
    if (!running) {
      db.prepare("UPDATE syncs SET status = 'interrupted', finished_at = ?, error = COALESCE(error, 'The sync process stopped before the end') WHERE id = ?").run(now(), r.id);
    }
  }
}

export interface SyncRow {
  id: number;
  status: 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
  step: string;
  startedAt: string;
  finishedAt: string | null;
  fromCommit: string | null;
  toCommit: string | null;
  report: ChangeReport | null;
  tests: TestResult | null;
  runDir: string | null;
  error: string | null;
  log: string;
}

const toRow = (r: any): SyncRow => ({
  id: r.id,
  status: r.status,
  step: r.step,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  fromCommit: r.from_commit,
  toCommit: r.to_commit,
  report: r.report ? JSON.parse(r.report) : null,
  tests: r.tests ? JSON.parse(r.tests) : null,
  runDir: r.run_dir,
  error: r.error,
  log: r.log,
});

/** The last sync of a project, and the live test progress while tests run. */
/** True when a process (server or command line) runs a sync of the project now. */
export function syncRunning(projectId: string): boolean {
  markInterrupted(projectId);
  return !!db.prepare("SELECT 1 FROM syncs WHERE project_id = ? AND status = 'running'").get(projectId);
}

/** True when the process is alive. For the AI update rows too (server/ai-update.ts). */
export const processAlive = (pid: number | null) => alive(pid);

/**
 * True when a process (server or command line) runs a mapping loop of the project now
 * (server/map-loop.ts). The loop uses the copy and the test site, as a sync and an AI update do.
 */
export function mapLoopRunning(projectId: string): boolean {
  const rows = db.prepare("SELECT owner_pid FROM map_loops WHERE project_id = ? AND status = 'running'").all(projectId) as any[];
  return rows.some((r) => r.owner_pid === process.pid || alive(r.owner_pid));
}

export function syncState(projectId: string) {
  markInterrupted(projectId);
  const p = getProject(projectId)!;
  const r = db.prepare('SELECT * FROM syncs WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId) as any;
  const last = r ? toRow(r) : null;
  let progress = null;
  if (last?.status === 'running' && last.step === 'tests') {
    try {
      progress = JSON.parse(fs.readFileSync(path.join(ROOT, 'coverage-data', 'progress.json'), 'utf8'));
    } catch {
      /* not started yet */
    }
  }
  return {
    enabled: !!p.syncBranch,
    branch: p.syncBranch ?? null,
    syncedCommit: p.syncedCommit ?? null,
    syncedAt: p.syncedAt ?? null,
    last: last && { ...last, log: last.log.slice(-6000) },
    progress,
  };
}

function setStep(job: Job, step: string, log = true) {
  db.prepare('UPDATE syncs SET step = ? WHERE id = ?').run(step, job.syncId);
  if (log) appendLog(job.syncId, `== ${step}\n`);
}

/**
 * Starts a sync of one project. Returns the sync ID at once; the work goes on in the background.
 * onLog gets the log lines (the command line prints them).
 */
export function startSync(projectId: string, mode: TestMode = 'auto', onLog?: (line: string) => void): { syncId: number; done: Promise<SyncRow> } {
  const p = getProject(projectId);
  if (!p) throw new SyncError(`No project ${projectId}`);
  if (!p.syncBranch) {
    throw new SyncError(
      `Sync is off for ${projectId}. Sync changes the files in ${p.path}, so turn it on only for the tracker's own copy: ` +
        `npm run project -- set-sync ${projectId} --branch trunk`,
    );
  }
  markInterrupted(projectId);
  const busy = db.prepare("SELECT id FROM syncs WHERE project_id = ? AND status = 'running'").get(projectId) as any;
  if (busy) throw new SyncError(`A sync of ${projectId} is running now (sync ${busy.id})`);
  // An AI update reads the copy: the sync must not change it in the middle. Any process can run
  // one (server or command line), so the check reads the database, not a list in memory.
  const ai = db.prepare("SELECT owner_pid FROM ai_updates WHERE project_id = ? AND status IN ('running', 'waiting')").all(projectId) as any[];
  if (ai.some((r) => alive(r.owner_pid))) throw new SyncError('An AI update runs now. Sync when it ends.');
  if (mapLoopRunning(projectId)) throw new SyncError('A mapping loop runs now. Sync when it ends, or stop it.');
  const syncId = Number(
    db.prepare("INSERT INTO syncs (project_id, started_at, status, step, owner_pid) VALUES (?, ?, 'running', 'check', ?)").run(projectId, now(), process.pid).lastInsertRowid,
  );
  const job: Job = { syncId, child: null, cancelled: false, abort: new AbortController() };
  jobs.set(projectId, job);
  const done = doSync(p, job, mode, onLog)
    .then(() => {
      db.prepare("UPDATE syncs SET status = 'done', step = '', finished_at = ? WHERE id = ?").run(now(), syncId);
    })
    .catch((e: Error) => {
      const status = job.cancelled ? 'cancelled' : 'failed';
      if (!(e instanceof SyncError)) console.error(e);
      appendLog(syncId, `!! ${e.message}\n`);
      onLog?.(`!! ${e.message}`);
      db.prepare('UPDATE syncs SET status = ?, finished_at = ?, error = ? WHERE id = ?').run(status, now(), e.message, syncId);
    })
    .finally(() => jobs.delete(projectId))
    .then(() => toRow(db.prepare('SELECT * FROM syncs WHERE id = ?').get(syncId)));
  return { syncId, done };
}

/**
 * The commands run in their own process group (detached), so they do not stop with this process.
 * When this process ends (a server restart, Ctrl+C), stop them too. Else Playwright keeps running
 * while the next sync empties the request folder.
 */
function stopAll() {
  for (const job of jobs.values()) {
    job.cancelled = true;
    job.abort.abort();
    killChildren(job);
  }
}
process.on('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(sig, () => {
    stopAll();
    process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const)[sig]);
  });
}

/** Stops the running sync of a project. The old coverage run stays selected. */
export function cancelSync(projectId: string) {
  const job = jobs.get(projectId);
  if (!job) throw new SyncError('No sync of this project runs in this app');
  job.cancelled = true;
  job.abort.abort();
  killChildren(job);
}

async function doSync(p: ProjectConfig, job: Job, mode: TestMode, onLog?: (line: string) => void) {
  const repo = p.path;
  const branch = p.syncBranch!;
  const say = (line: string) => {
    appendLog(job.syncId, line + '\n');
    onLog?.(line);
  };
  const o: RunOptions = { cwd: repo, onLine: onLog };
  // Queries are quiet. fetch, merge and npm print their output to the log.
  const git = (...args: string[]) => must(job, 'git', args, { cwd: repo, quiet: true });
  const gitLoud = (...args: string[]) => must(job, 'git', args, o);

  // 1. The copy must be the tracker's clean copy on the sync branch.
  setStep(job, 'check');
  const head = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (head !== branch) throw new SyncError(`The copy is on "${head}", not on "${branch}". Sync stops, so that no work is lost.`);
  const dirty = await git('status', '--porcelain', '--untracked-files=no');
  if (dirty) throw new SyncError(`The copy has changed files. Sync stops, so that no work is lost:\n${dirty}`);

  // 2. Get the new commits.
  setStep(job, 'fetch');
  await gitLoud('fetch', '--no-tags', 'origin', branch);
  const own = Number(await git('rev-list', '--count', `origin/${branch}..HEAD`));
  if (own > 0) throw new SyncError(`The copy has ${own} commits that are not on origin/${branch}. Sync stops, so that no work is lost.`);
  // The report starts at the commit of the last sync that saved a report. A sync that got the code
  // and then failed would else leave the next report empty. Not an ancestor of HEAD (history was
  // rewritten, or the copy was moved by hand): start at HEAD.
  const headBefore = await git('rev-parse', 'HEAD');
  const lastReport = db
    .prepare("SELECT to_commit FROM syncs WHERE project_id = ? AND report IS NOT NULL AND to_commit IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get(p.id) as any;
  let from = headBefore;
  if (lastReport && lastReport.to_commit !== headBefore) {
    const r = await run(job, 'git', ['merge-base', '--is-ancestor', lastReport.to_commit, headBefore], { cwd: repo, quiet: true });
    if (r.code === 0) from = lastReport.to_commit;
  }
  const to = await git('rev-parse', `origin/${branch}`);
  db.prepare('UPDATE syncs SET from_commit = ?, to_commit = ? WHERE id = ?').run(from, to, job.syncId);
  if (headBefore !== to) {
    await gitLoud('merge', '--ff-only', '--quiet', `origin/${branch}`);
    say(`Updated ${headBefore.slice(0, 8)} -> ${to.slice(0, 8)}`);
  } else {
    say(`Already at ${to.slice(0, 8)}`);
  }
  db.prepare('UPDATE projects SET synced_commit = ?, synced_at = ? WHERE id = ?').run(to, now(), p.id);

  // Package installs and test runs start new trunk code. Without setpriv, a setuid sudo called by its
  // full path is not blocked, so refuse those steps.
  const needSafe = () => {
    if (!SETPRIV) throw new SyncError('setpriv is not installed, so the sync cannot block sudo. Install util-linux (setpriv) to install packages and run tests.');
  };
  // 3. Test packages. npm ci, not npm install: npm install can change the lock file, and then the copy has changed files.
  const pwRoot = p.playwrightDir ? path.join(repo, playwrightRoot(p)) : null;
  if (pwRoot && fs.existsSync(path.join(pwRoot, 'package.json'))) {
    const rel = path.relative(repo, pwRoot);
    const pkgFiles = ['package.json', 'package-lock.json'].map((f) => (rel ? `${rel}/${f}` : f));
    const pkgChanged = from !== to && changedFiles(p, from, to).some((f) => pkgFiles.includes(f.path));
    if (pkgChanged || !fs.existsSync(path.join(pwRoot, 'node_modules'))) {
      needSafe();
      setStep(job, 'packages');
      const before = playwrightVersion(pwRoot);
      const hasLock = fs.existsSync(path.join(pwRoot, 'package-lock.json'));
      await must(job, 'npm', hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'], { ...o, cwd: pwRoot });
      const after = playwrightVersion(pwRoot);
      if (after && after !== before) {
        // Browsers for the new Playwright version. Never --with-deps: it calls sudo.
        await must(job, 'npx', ['playwright', 'install', 'chromium'], { ...o, cwd: pwRoot });
      }
      const dirtyAfter = await git('status', '--porcelain', '--untracked-files=no');
      if (dirtyAfter) say(`Warning: the package install changed files in the copy:\n${dirtyAfter}`);
    }
  }

  // 4. Scan the new files and tests.
  setStep(job, 'scan');
  syncProject(getProject(p.id)!, true);

  // 5. Change report.
  setStep(job, 'report');
  const report = changeReport(p, from, to);
  db.prepare('UPDATE syncs SET report = ? WHERE id = ?').run(JSON.stringify(report), job.syncId);
  say(`${report.commits} commits, ${report.files.length} files, ${report.functions.length} functions, ` +
    `tests +${report.tests.added.length} ~${report.tests.changed.length} -${report.tests.removed.length}, ${report.review.length} features to review`);

  // 6. Tests.
  const why = testDecision(p, to, mode);
  if (why.skip) {
    say(`Tests: not run (${why.reason})`);
    db.prepare('UPDATE syncs SET tests = ? WHERE id = ?').run(JSON.stringify({ ran: false, reason: why.reason }), job.syncId);
    return;
  }
  needSafe();
  say(`Tests: run (${why.reason})`);
  setStep(job, 'tests');
  const result = await runTests(getProject(p.id)!, to, {
    run: (cmd, args, ro) => run(job, cmd, args, ro),
    env: childEnv,
    log: say,
    cancelled: () => job.cancelled,
    signal: job.abort.signal,
  });
  db.prepare('UPDATE syncs SET tests = ?, run_dir = ? WHERE id = ?').run(JSON.stringify(result), result.runDir ?? null, job.syncId);
  if (!result.selected) throw new SyncError(`The test run was not selected: ${result.reason}`);
}

function playwrightVersion(pwRoot: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(pwRoot, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

/**
 * auto: run when the selected Playwright run is not at the new commit, and PHP code or
 * Playwright files changed since the run's commit. Other changes (JS, CSS, docs) do not change the PHP coverage.
 */
export function testDecision(p: ProjectConfig, to: string, mode: TestMode): { skip: boolean; reason: string } {
  if (mode === 'never') return { skip: true, reason: 'tests are off for this sync' };
  if (!p.playwrightDir) return { skip: true, reason: 'the project has no Playwright folder' };
  if (!findEchowp()) return { skip: true, reason: 'echowp is not installed (the tests run on an echowp site)' };
  if (!fs.existsSync(path.join(p.path, 'echowp.yml'))) return { skip: true, reason: `the copy has no echowp.yml (the tests run on an echowp site)` };
  if (mode === 'always') return { skip: false, reason: 'asked' };
  const run = p.runs.playwright;
  // runFreshness imports the run first. The commit column is empty until the run is imported,
  // for example right after a sync selected it.
  const commit = run ? (runFreshness(p, 'playwright')?.runCommit ?? null) : null;
  if (!commit) return { skip: false, reason: run ? 'the selected run has no plugin commit' : 'no Playwright run yet' };
  if (commit === to) return { skip: true, reason: 'the selected run is at this commit' };
  let files;
  try {
    files = changedFiles(p, commit, to);
  } catch {
    return { skip: false, reason: `the run commit ${commit.slice(0, 8)} is not in the copy` };
  }
  const code = files.filter((f) => f.kind === 'php' || f.kind === 'playwright' || f.kind === 'playwright-support');
  if (!code.length) return { skip: true, reason: `no PHP or Playwright change since the run at ${commit.slice(0, 8)}` };
  return { skip: false, reason: `${code.length} PHP or Playwright files changed since the run at ${commit.slice(0, 8)}` };
}
