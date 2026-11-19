/**
 * Test run job of a sync: one full Playwright run with PHP coverage on an echowp test site.
 *
 *  0. start the project's test site in the tracker's own echowp home (server/echowp.ts, with the
 *     coverage PHP) and reset its database. The site stops at the end, also after a failure or a cancel.
 *  1. empty coverage-data/raw (the site writes one file for each request there)
 *  2. baseline page loads (coverage/baseline.sh): their code is "library code"
 *  3. the Playwright tests, 1 worker, with the window reporter (start and end time of each test)
 *  4. copy the requests and the windows into a new run folder, then coverage/analyze.py
 *  5. write run-info.json and select the run, only when the report looks right
 *
 * Only one test run at a time, for all projects: coverage-data/raw is one shared folder.
 * All sites of the tracker's echowp home share one PHP server, so each of them records coverage.
 * During a run, coverage-data/test-site.json names the port of the test site. Then
 * coverage/prepend.php records only the requests to that port.
 * When the server stops during a run (restart, Ctrl+C), an exit handler stops the test site.
 * The copy's .env can say ECHOWP=true. The job always sets ECHOWP=false and BASE_URL, so the
 * tests use the tracker's site, and the plugin's own echowp setup (which can call sudo) does nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db } from './db.ts';
import { playwrightRoot } from './changes.ts';
import { addCoverageRun, ROOT, type ProjectConfig } from './projects.ts';
import { startTestSite, stopTestSitesSync, type TestSite } from './echowp.ts';

export interface TestResult {
  ran: boolean;
  /** Why the tests did not run, or why the run was not selected. */
  reason?: string;
  /** True: the new run is the selected Playwright run now. */
  selected?: boolean;
  /** Run folder, relative to this tool. */
  runDir?: string;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  /** Exit code of the Playwright command (1 = some tests failed). */
  exit?: number | string;
  minutes?: number;
}

interface Ctx {
  run: (cmd: string, args: string[], o: { cwd: string; env?: NodeJS.ProcessEnv; onLine?: (l: string) => void; quiet?: boolean }) => Promise<{ code: number | null; signal: string | null; out: string }>;
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
  log: (line: string) => void;
  cancelled: () => boolean;
  /** Fires on a cancel. */
  signal?: AbortSignal;
}

const DATA = path.join(ROOT, 'coverage-data');
const LOCK = path.join(ROOT, 'data', 'test-run.lock');
/** The test site of the run that runs now: coverage/prepend.php reads it. */
const SITE_MARK = path.join(DATA, 'test-site.json');

/** The project of the test run that runs in this process, for the exit handler. */
let active: ProjectConfig | null = null;

// The "finally" of runTests does not run when the process exits (sync.ts calls process.exit on
// SIGINT, SIGTERM and SIGHUP). Stop the test site here, synchronously, so that it does not keep
// its port and PHP server.
process.on('exit', () => {
  if (!active) return;
  const p = active;
  active = null;
  try {
    for (const e of stopTestSitesSync(p)) console.error(`Could not stop the test site: ${e}`);
  } catch (e) {
    console.error(`Could not stop the test site: ${(e as Error).message}`);
  }
  fs.rmSync(SITE_MARK, { force: true });
  fs.rmSync(LOCK, { force: true });
});

function takeLock(projectId: string) {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    let alive = false;
    try {
      process.kill(held.pid, 0);
      alive = true;
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code === 'EPERM';
    }
    if (alive) throw new Error(`Another test run is running (project ${held.project}, process ${held.pid}). One test run at a time.`);
    fs.rmSync(LOCK); // left by a process that stopped
  } catch (e) {
    // Bad JSON: a process stopped between making the file and writing it. The lock is not held.
    if (e instanceof SyntaxError) fs.rmSync(LOCK, { force: true });
    else if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, project: projectId, at: new Date().toISOString() }), { flag: 'wx' });
}

/** Reads KEY=VALUE lines of a .env file. The values stay in this process: they are never logged. */
function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

const stamp = () => {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
};

export async function runTests(p: ProjectConfig, commit: string, ctx: Ctx): Promise<TestResult> {
  const pwRoot = path.join(p.path, playwrightRoot(p));
  takeLock(p.id);
  active = p;
  const started = Date.now();
  let runDir: string | null = null;
  let echowpSite: TestSite | null = null;
  try {
    const dotenv = readEnv(path.join(pwRoot, '.env'));
    // The same defaults as the plugin's Playwright config.
    const creds = { ADMIN_USERNAME: dotenv.ADMIN_USERNAME || 'admin', ADMIN_PASSWORD: dotenv.ADMIN_PASSWORD || 'test' };
    // 0. The test site.
    ctx.log('Start the echowp test site (the first start of a project downloads WordPress and the plugins)');
    echowpSite = await startTestSite(p, { user: creds.ADMIN_USERNAME, password: creds.ADMIN_PASSWORD }, ctx.log, async (cmd, args, env, onLine) => {
      const r = await ctx.run(cmd, args, { cwd: ROOT, env, quiet: true, onLine });
      return r.code ?? 1;
    }, ctx.signal);
    if (ctx.cancelled()) throw new Error('Cancelled');
    const site = echowpSite.url;
    ctx.log(`echowp test site ${echowpSite.name}: ${site}`);
    // Record only the requests to the test site, not to other sites of the tracker's PHP server.
    const port = Number(new URL(site).port) || (site.startsWith('https:') ? 443 : 80);
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(SITE_MARK, JSON.stringify({ port, pid: process.pid, project: p.id }) + '\n');
    const env = ctx.env({ ...creds, ECHOWP: 'false', BASE_URL: site, WORKERS: '1' });

    // 1. A clean request folder.
    const raw = path.join(DATA, 'raw');
    fs.mkdirSync(raw, { recursive: true });
    for (const f of fs.readdirSync(raw)) if (f.endsWith('.json')) fs.rmSync(path.join(raw, f));
    for (const f of ['test-windows.json', 'progress.json']) fs.rmSync(path.join(DATA, f), { force: true });

    // 2. Baseline page loads.
    ctx.log(`Baseline page loads on ${site}`);
    const base = await ctx.run('bash', [path.join(ROOT, 'coverage', 'baseline.sh'), site], { cwd: ROOT, env });
    if (ctx.cancelled()) throw new Error('Cancelled');
    if (base.code !== 0) return { ran: false, reason: `the baseline page loads failed (exit ${base.code ?? base.signal}). Is the site running?` };
    if (!fs.readdirSync(raw).some((f) => f.endsWith('.json'))) {
      return { ran: false, reason: `the site wrote no coverage files. Check that ${site} runs with coverage/prepend.php` };
    }

    // 3. The tests. --reporter replaces the config's HTML reporter, which can wait for a person after a failure.
    const runRel = path.join('data', 'projects', p.id, 'runs', `${stamp()}-sync-${commit.slice(0, 8)}`);
    runDir = path.join(ROOT, runRel);
    fs.mkdirSync(runDir, { recursive: true });
    const logFile = fs.openSync(path.join(runDir, 'full-run.log'), 'w');
    ctx.log(`Playwright run, 1 worker.`);
    const reporter = path.join(ROOT, 'coverage', 'test-window-reporter.cjs');
    let pw;
    try {
      pw = await ctx.run('npx', ['playwright', 'test', `--reporter=list,${reporter}`, '--workers=1'], {
        cwd: pwRoot,
        env,
        quiet: true,
        onLine: (l) => fs.writeSync(logFile, l + '\n'),
      });
    } finally {
      fs.closeSync(logFile);
    }
    if (ctx.cancelled()) throw new Error('Cancelled');
    const minutes = Math.round((Date.now() - started) / 6000) / 10;
    const tail = pw.out.trim().split('\n').slice(-4).join(' | ');
    ctx.log(`Playwright ended (exit ${pw.code ?? pw.signal}) after ${minutes} minutes: ${tail}`);
    const windowsFile = path.join(DATA, 'test-windows.json');
    // Exit 1 = some tests failed: the run is still good coverage data. Other exits: the run did not finish.
    if ((pw.code !== 0 && pw.code !== 1) || !fs.existsSync(windowsFile)) {
      return { ran: true, selected: false, runDir: runRel, exit: pw.code ?? pw.signal ?? '', minutes, reason: `Playwright did not finish (exit ${pw.code ?? pw.signal}): ${tail}` };
    }

    // Count by the last try of each test.
    const windows = JSON.parse(fs.readFileSync(windowsFile, 'utf8')) as any[];
    const last = new Map<string, any>();
    for (const w of windows) if (w.project !== 'setup' && (!last.has(w.id) || last.get(w.id).retry < w.retry)) last.set(w.id, w);
    const all = [...last.values()];
    const counts = {
      total: all.length,
      passed: all.filter((w) => w.status === 'passed').length,
      skipped: all.filter((w) => w.status === 'skipped').length,
      failed: all.filter((w) => w.status !== 'passed' && w.status !== 'skipped').length,
    };

    // 4. Copy and analyze.
    fs.cpSync(raw, path.join(runDir, 'raw'), { recursive: true });
    fs.copyFileSync(windowsFile, path.join(runDir, 'test-windows.json'));
    const exclude = p.excludeDirs ? ['--exclude', p.excludeDirs.join(',')] : [];
    ctx.log('Coverage analysis (analyze.py)');
    const an = await ctx.run('python3', [path.join(ROOT, 'coverage', 'analyze.py'), p.path, runDir, ...exclude], { cwd: ROOT, env: ctx.env() });
    if (ctx.cancelled()) throw new Error('Cancelled');
    const result: TestResult = { ran: true, runDir: runRel, exit: pw.code ?? '', minutes, ...counts };
    if (an.code !== 0) return { ...result, selected: false, reason: `analyze.py failed: ${an.out.trim().split('\n').slice(-2).join(' | ')}` };

    // 5. Select the run only when the report has the tests.
    let reportTests = 0;
    try {
      reportTests = (JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8')).tests ?? []).filter((t: any) => t.project !== 'setup').length;
    } catch {
      /* no report */
    }
    if (!reportTests || counts.passed === 0) {
      return { ...result, selected: false, reason: `the report has ${reportTests} tests and ${counts.passed} passed: not a good run` };
    }
    const dirty = execFileSync('git', ['-C', p.path, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== '';
    fs.writeFileSync(
      path.join(runDir, 'run-info.json'),
      JSON.stringify({ pluginCommit: commit, pluginDirty: dirty, recordedAt: new Date().toISOString().slice(0, 10), note: `Sync of ${p.syncBranch}`, ...counts }, null, 2) + '\n',
    );
    const label = `Playwright, ${p.syncBranch ?? 'sync'} ${commit.slice(0, 7)}, ${new Date().toISOString().slice(0, 10)}`;
    const runId = addCoverageRun(p.id, runRel, 'playwright', label);
    db.prepare('UPDATE projects SET coverage_run_id = ? WHERE id = ?').run(runId, p.id);
    ctx.log(`Selected the new run: ${runRel} (${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped)`);
    return { ...result, selected: true };
  } catch (e) {
    // A cancelled run has no data worth keeping: remove its half-made folder.
    if ((e as Error).message === 'Cancelled' && runDir) fs.rmSync(runDir, { recursive: true, force: true });
    throw e;
  } finally {
    // A stop error must not replace the result of the run.
    try {
      if (echowpSite) await echowpSite.stop();
    } catch (e) {
      ctx.log(`Could not stop the test site: ${(e as Error).message}`);
    }
    fs.rmSync(SITE_MARK, { force: true });
    fs.rmSync(LOCK, { force: true });
    active = null;
  }
}
