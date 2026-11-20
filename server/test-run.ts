/**
 * Test run job of a sync: one full Playwright run with PHP coverage on an echowp test site.
 *
 *  0. start one test site for each worker in the tracker's own echowp home (server/echowp.ts, with
 *     the coverage PHP) and reset their databases. The sites stop at the end, also after a failure
 *     or a cancel.
 *  1. empty coverage-data/raw (the sites write one file for each request there)
 *  2. baseline page loads (coverage/baseline.sh) on the first site: their code is "library code"
 *  3. the plugin's setup project once for each site, then the other Playwright projects with one
 *     worker for each site (coverage/playwright-wrapper.cjs gives each worker its site), with the
 *     window reporter (start, end and worker slot of each test)
 *  4. copy the requests, the windows and the slot-to-port list (sites.json) into a new run folder,
 *     then coverage/analyze.py. A request goes to a test of the worker whose site has its port.
 *  5. write run-info.json and select the run, only when the report looks right
 *
 * Only one test run at a time, for all projects: coverage-data/raw is one shared folder.
 * All sites of the tracker's echowp home share one PHP server, so each of them records coverage.
 * During a run, coverage-data/test-site.json names the ports of the test sites. Then
 * coverage/prepend.php records only the requests to those ports, with the port.
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
import os from 'node:os';
import { createRequire } from 'node:module';
import { startTestSites, stopTestSitesSync, type TestSites } from './echowp.ts';

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

/**
 * Copied next to the plugin's Playwright config during a run: coverage/playwright-wrapper.cjs for
 * a CommonJS config, coverage/playwright-wrapper.mjs for an ES module config.
 */
const WRAPPER_BASE = '.tracker-playwright.config';
const WRAPPER_LIB = path.join(ROOT, 'coverage', 'playwright-wrapper-lib.cjs');

/** "mjs" when the config is an ES module: .mjs or .mts, or .js or .ts in a "type": "module" package. */
function configKind(pwRoot: string, config: string): 'cjs' | 'mjs' {
  if (/\.m[jt]s$/.test(config)) return 'mjs';
  if (/\.c[jt]s$/.test(config)) return 'cjs';
  for (let dir = pwRoot; ; dir = path.dirname(dir)) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).type === 'module' ? 'mjs' : 'cjs';
    } catch {
      /* no package.json here */
    }
    if (path.dirname(dir) === dir) return 'cjs';
  }
}

/** The copy of a saved login file for the site of a slot: the same name as the wrapper uses. */
const stateCopy: (file: string, slot: number) => string = createRequire(import.meta.url)(WRAPPER_LIB).stateFile;

/** Facts about the plugin's config, from coverage/playwright-wrapper-lib.cjs. */
interface ConfigInfo {
  storageStates: string[];
  setupProjects: string[];
  teardownProjects: string[];
  globalSetup: boolean;
  globalTeardown: boolean;
}

/** Waits for all commands, also when one of them fails to start. A start error becomes exit null. */
async function settleAll<T extends { code: number | null; signal: string | null; out: string }>(jobs: Promise<T>[]) {
  const done = await Promise.allSettled(jobs);
  return done.map((d) => (d.status === 'fulfilled' ? d.value : { code: null, signal: `start error: ${(d.reason as Error)?.message ?? d.reason}`, out: '' }));
}
/** Config file names that Playwright looks for, in its own order. */
const PW_CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mts', 'playwright.config.mjs', 'playwright.config.cts', 'playwright.config.cjs'];

/**
 * Workers (and test sites) for a run. All sites share one PHP server, so more workers than half
 * the CPUs gives slow requests and timeouts. TRACKER_TEST_WORKERS changes it (for trials).
 */
export function testWorkers(): number {
  const env = Number.parseInt(process.env.TRACKER_TEST_WORKERS ?? '', 10);
  if (env > 0) return env;
  return Math.max(1, Math.min(MAX_WORKERS, Math.floor(os.cpus().length / 2)));
}
const MAX_WORKERS = 4;

/** Copies of saved login files, one for each site. Removed at the end of the run, or by the exit handler. */
const activeStateCopies: string[] = [];

/** The wrapper file of the run that runs in this process, for the exit handler. */
let activeWrapper: string | null = null;

/** The project of the test run that runs in this process, for the exit handler. */
let active: ProjectConfig | null = null;

// The "finally" of runTests does not run when the process exits (sync.ts calls process.exit on
// SIGINT, SIGTERM and SIGHUP). Stop the test site here, synchronously, so that it does not keep
// its port and PHP server.
process.on('exit', () => {
  if (activeWrapper) fs.rmSync(activeWrapper, { force: true });
  for (const f of activeStateCopies) fs.rmSync(f, { force: true });
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
  let echowpSites: TestSites | null = null;
  let wrapper: string | null = null;
  const stateCopies = activeStateCopies;
  stateCopies.length = 0;
  try {
    const pwConfig = PW_CONFIGS.find((f) => fs.existsSync(path.join(pwRoot, f)));
    if (!pwConfig) return { ran: false, reason: `no Playwright config (${PW_CONFIGS.join(', ')}) in ${pwRoot}` };
    let workers = testWorkers();
    const dotenv = readEnv(path.join(pwRoot, '.env'));
    // The same defaults as the plugin's Playwright config.
    const creds = { ADMIN_USERNAME: dotenv.ADMIN_USERNAME || 'admin', ADMIN_PASSWORD: dotenv.ADMIN_PASSWORD || 'test' };
    const wrapperName = `${WRAPPER_BASE}.${configKind(pwRoot, pwConfig)}`;
    wrapper = path.join(pwRoot, wrapperName);
    fs.copyFileSync(path.join(ROOT, 'coverage', `playwright-wrapper.${configKind(pwRoot, pwConfig)}`), wrapper);
    activeWrapper = wrapper;
    const baseEnv = ctx.env({ ...creds, ECHOWP: 'false', TRACKER_PW_CONFIG: pwConfig, TRACKER_WRAPPER_LIB: WRAPPER_LIB });
    const pwArgs = ['playwright', 'test', '-c', wrapperName];

    // Before the sites start: read the config, and find tests whose name holds BASE_URL. The test
    // list does not open the sites, so two made-up URLs are enough.
    const infoFile = path.join(DATA, 'config-info.json');
    fs.mkdirSync(DATA, { recursive: true });
    fs.rmSync(infoFile, { force: true });
    const li = await ctx.run('npx', [...pwArgs, '--list'], { cwd: pwRoot, env: { ...baseEnv, BASE_URL: 'http://tracker-check.localhost', TRACKER_PHASE: 'setup', TRACKER_INFO_FILE: infoFile }, quiet: true });
    if (ctx.cancelled()) throw new Error('Cancelled');
    if (li.code !== 0 || !fs.existsSync(infoFile)) {
      return { ran: false, reason: `Playwright could not read the config ${pwConfig} (exit ${li.code ?? li.signal}): ${li.out.trim().split('\n').slice(-3).join(' | ')}` };
    }
    const info = JSON.parse(fs.readFileSync(infoFile, 'utf8')) as ConfigInfo;
    if (workers > 1) {
      const lists: string[] = [];
      for (const slot of ['0', '1']) {
        const out = path.join(DATA, `test-list-${slot}.json`);
        const r = await ctx.run('npx', [...pwArgs, '--list', '--reporter=json'], {
          cwd: pwRoot,
          env: { ...baseEnv, TRACKER_PHASE: 'main', TRACKER_LIST_SLOT: slot, TRACKER_SITE_URLS: JSON.stringify(['http://tracker-check-1.localhost:8801', 'http://tracker-check-2.localhost:8802']), PLAYWRIGHT_JSON_OUTPUT_NAME: out },
          quiet: true,
        });
        if (ctx.cancelled()) throw new Error('Cancelled');
        let suites = '';
        try {
          suites = JSON.stringify(JSON.parse(fs.readFileSync(out, 'utf8')).suites);
        } catch {
          /* no list */
        }
        fs.rmSync(out, { force: true });
        lists.push(r.code === 0 ? suites : '');
      }
      // Playwright lists the tests in the main process (site 1) and runs them in the workers (own
      // site). A name that holds BASE_URL is then not the same, and the worker does not find the test.
      if (!lists[0] || lists[0] !== lists[1]) {
        ctx.log(lists[0] ? 'Some test names hold the site URL (BASE_URL), so the tests run on 1 worker.' : 'Playwright could not list the tests, so the tests run on 1 worker.');
        workers = 1;
      }
    }

    // 0. The test sites: one for each worker.
    ctx.log(`Start ${workers} echowp test site${workers === 1 ? '' : 's'} (the first start of a project downloads WordPress and the plugins)`);
    echowpSites = await startTestSites(p, workers, { user: creds.ADMIN_USERNAME, password: creds.ADMIN_PASSWORD }, ctx.log, async (cmd, args, env, onLine) => {
      const r = await ctx.run(cmd, args, { cwd: ROOT, env, quiet: true, onLine });
      return r.code ?? 1;
    }, ctx.signal);
    if (ctx.cancelled()) throw new Error('Cancelled');
    const sites = echowpSites.sites;
    const site = sites[0].url;
    ctx.log(`echowp test sites: ${sites.map((s) => `${s.name} ${s.url}`).join(', ')}`);
    // Record only the requests to the test sites, not to other sites of the tracker's PHP server.
    fs.writeFileSync(SITE_MARK, JSON.stringify({ ports: sites.map((s) => s.port), pid: process.pid, project: p.id }) + '\n');
    const env = { ...baseEnv, BASE_URL: site, WORKERS: String(workers), TRACKER_SITE_URLS: JSON.stringify(sites.map((s) => s.url)) };

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
    fs.writeFileSync(path.join(runDir, 'sites.json'), JSON.stringify(sites.map((s, slot) => ({ slot, name: s.name, port: s.port })), null, 2) + '\n');
    const logFile = fs.openSync(path.join(runDir, 'full-run.log'), 'w');
    const reporter = path.join(ROOT, 'coverage', 'test-window-reporter.cjs');
    // One command for each site, in the setup or teardown phase. Each has its own results folder:
    // Playwright empties its results folder when it starts.
    const phaseRun = (phase: string, slot: number) =>
      ctx.run('npx', [...pwArgs, '--reporter=list', '--workers=1', '--pass-with-no-tests', `--output=test-results/tracker-${phase}-${sites[slot].name}`], {
        cwd: pwRoot,
        env: { ...env, TRACKER_PHASE: phase, BASE_URL: sites[slot].url, TRACKER_SITE_SLOT: String(slot) },
        quiet: true,
      });
    let pw;
    try {
      // 3a. The setup projects and globalSetup once for each site. Their requests are in no test
      // window, so the analysis counts them as setup. Without saved login files, all sites at the
      // same time. With them, one site after the other: the setup writes one file, and the tracker
      // copies it for the site (coverage/playwright-wrapper-lib.cjs).
      ctx.log(`Playwright setup on ${sites.map((s) => s.name).join(', ')}${info.storageStates.length ? ' (one after the other, for the saved logins)' : ''}`);
      let setups: Awaited<ReturnType<typeof phaseRun>>[];
      if (!info.storageStates.length) setups = await settleAll(sites.map((_, k) => phaseRun('setup', k)));
      else {
        setups = [];
        for (const k of sites.keys()) {
          const r = (await settleAll([phaseRun('setup', k)]))[0];
          setups.push(r);
          if (ctx.cancelled() || r.code !== 0) break;
          for (const f of info.storageStates) {
            const src = path.resolve(pwRoot, f);
            const dst = path.resolve(pwRoot, stateCopy(f, k));
            if (fs.existsSync(src)) {
              fs.copyFileSync(src, dst);
              stateCopies.push(dst);
            }
          }
        }
      }
      for (const [i, su] of setups.entries()) fs.writeSync(logFile, `=== setup on ${sites[i].name} (${sites[i].url}), exit ${su.code ?? su.signal}\n${su.out.trim()}\n`);
      if (ctx.cancelled()) throw new Error('Cancelled');
      const bad = setups.findIndex((su) => su.code !== 0);
      if (bad >= 0) {
        const su = setups[bad];
        const tail = su.out.trim().split('\n').slice(-4).join(' | ');
        return { ran: false, runDir: runRel, reason: `the Playwright setup failed on ${sites[bad].name} (exit ${su.code ?? su.signal}): ${tail}` };
      }
      // 3b. The other projects, one worker for each site.
      ctx.log(`Playwright run, ${workers} worker${workers === 1 ? '' : 's'}.`);
      fs.writeSync(logFile, `=== tests, ${workers} workers\n`);
      pw = await ctx.run('npx', [...pwArgs, `--reporter=list,${reporter}`, `--workers=${workers}`], {
        cwd: pwRoot,
        env: { ...env, TRACKER_PHASE: 'main' },
        quiet: true,
        onLine: (l) => fs.writeSync(logFile, l + '\n'),
      });
      // 3c. The teardown projects and globalTeardown once for each site. A failure here does not
      // change the result of the tests.
      if (!ctx.cancelled() && (info.teardownProjects.length || info.globalTeardown)) {
        ctx.log(`Playwright teardown on ${sites.map((s) => s.name).join(', ')}`);
        const tds = await settleAll(sites.map((_, k) => phaseRun('teardown', k)));
        for (const [i, td] of tds.entries()) {
          fs.writeSync(logFile, `=== teardown on ${sites[i].name}, exit ${td.code ?? td.signal}\n${td.out.trim()}\n`);
          if (td.code !== 0) ctx.log(`The Playwright teardown failed on ${sites[i].name} (exit ${td.code ?? td.signal}). See full-run.log.`);
        }
      }
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
    if (wrapper) fs.rmSync(wrapper, { force: true });
    for (const f of stateCopies) fs.rmSync(f, { force: true });
    activeWrapper = null;
    // A stop error must not replace the result of the run.
    try {
      if (echowpSites) await echowpSites.stop();
    } catch (e) {
      ctx.log(`Could not stop the test sites: ${(e as Error).message}`);
    }
    fs.rmSync(SITE_MARK, { force: true });
    fs.rmSync(LOCK, { force: true });
    active = null;
  }
}

export interface SpecResult {
  /** Exit code of the Playwright command (0 = all passed, 1 = some failed). */
  exit: number | string;
  /** The URL of the test site. The site stays on after the run, for playwright-cli. */
  siteUrl: string;
  /** The last lines of the Playwright output. */
  tail: string;
}

/**
 * The admin login of the plugin's Playwright tests (ADMIN_USERNAME and ADMIN_PASSWORD in its .env).
 * echowp sets it when it makes a site, so the tests and playwright-cli can log in.
 * The values stay in this process: they are never logged.
 */
export function pluginAdminLogin(p: ProjectConfig): { user: string; password: string } {
  const dotenv = readEnv(path.join(p.path, playwrightRoot(p), '.env'));
  return { user: dotenv.ADMIN_USERNAME || 'admin', password: dotenv.ADMIN_PASSWORD || 'test' };
}

/**
 * Runs one Playwright spec file of the copy on the tracker's own echowp site (site-1, profile
 * "test"), for the map-features skill. The site starts with a clean database. It stays on after the
 * run, so the skill can try the feature with playwright-cli. The caller stops it (echowp stop site-1 --profile test, or
 * the mapping loop after each unit). No coverage: the site mark is not written.
 * The copy's .env can say ECHOWP=true. Here it is always false, so the plugin's own echowp setup
 * (which can call sudo, and uses the person's own echowp home) does nothing.
 */
export async function runSpec(p: ProjectConfig, ref: string, ctx: Ctx): Promise<SpecResult> {
  const pwRoot = path.join(p.path, playwrightRoot(p));
  const specDir = path.join(p.path, p.playwrightDir ?? playwrightRoot(p));
  const spec = path.resolve(specDir, ref);
  if (!spec.startsWith(specDir + path.sep) || !fs.existsSync(spec)) throw new Error(`No spec file "${ref}" in ${specDir}. Give the unit ref that "map next" gave.`);
  takeLock(p.id);
  // A stop (the mapping loop's Stop, or a timeout of the caller) ends the process with process.exit:
  // then "finally" does not run, so the exit handler removes the lock.
  const dropLock = () => fs.rmSync(LOCK, { force: true });
  process.on('exit', dropLock);
  try {
    const pwConfig = PW_CONFIGS.find((f) => fs.existsSync(path.join(pwRoot, f)));
    if (!pwConfig) throw new Error(`No Playwright config (${PW_CONFIGS.join(', ')}) in ${pwRoot}`);
    const login = pluginAdminLogin(p);
    const creds = { ADMIN_USERNAME: login.user, ADMIN_PASSWORD: login.password };
    ctx.log('Start the echowp test site site-1 (profile test) with a clean database');
    const { sites } = await startTestSites(p, 1, { user: creds.ADMIN_USERNAME, password: creds.ADMIN_PASSWORD }, ctx.log, async (cmd, args, env, onLine) => {
      const r = await ctx.run(cmd, args, { cwd: ROOT, env, quiet: true, onLine });
      return r.code ?? 1;
    }, ctx.signal);
    if (ctx.cancelled()) throw new Error('Cancelled');
    const site = sites[0].url;
    ctx.log(`Test site: ${site}`);
    // The first admin page load of a new site goes to the WooCommerce home page. The sync run has
    // these page loads first too, so a test that runs first sees the same site as in a sync.
    const warm = await ctx.run('bash', [path.join(ROOT, 'coverage', 'baseline.sh'), site], { cwd: ROOT, env: ctx.env(creds), quiet: true });
    if (warm.code !== 0) ctx.log(`The first page loads failed (exit ${warm.code ?? warm.signal}). The tests run anyway.`);
    const rel = path.relative(pwRoot, spec);
    // Playwright reads a file argument as a regex. Escape it, so that a name with "(", "[" or "+"
    // matches only this file.
    const filter = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ctx.log(`Run: npx playwright test ${filter} --reporter=line --workers=1`);
    const r = await ctx.run('npx', ['playwright', 'test', filter, '--reporter=line', '--workers=1'], {
      cwd: pwRoot,
      env: ctx.env({ ...creds, ECHOWP: 'false', BASE_URL: site }),
      onLine: (l) => ctx.log(l),
      quiet: true,
    });
    return { exit: r.code ?? r.signal ?? 'unknown', siteUrl: site, tail: r.out.trim().split('\n').slice(-15).join('\n') };
  } finally {
    process.off('exit', dropLock);
    dropLock();
  }
}

/**
 * Stops a run-spec command that still runs after its caller stopped (for example a mapping unit
 * that timed out). It stops only a run-spec of another process: it reads the command line of the
 * lock holder (Linux /proc). SIGTERM first: sync.ts turns it into process.exit, so the run-spec
 * stops its Playwright process groups and removes the lock. SIGKILL after 15 s.
 * Gives a line for the log, or null when no run-spec was left.
 */
export async function stopLeftoverRunSpec(): Promise<string | null> {
  let pid: number;
  try {
    pid = Number(JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null;
  let cmdline = '';
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    clearDeadLock();
    return null;
  }
  if (!/\brun-spec\b/.test(cmdline)) return null;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* gone */
  }
  for (let i = 0; i < 30 && alive(); i++) await new Promise((r) => setTimeout(r, 500));
  let how = 'stopped';
  if (alive()) {
    try {
      process.kill(pid, 'SIGKILL');
      how = 'killed (it did not stop in 15 s)';
    } catch {
      /* gone */
    }
  }
  clearDeadLock();
  return `A test run (run-spec, process ${pid}) still ran after the unit: ${how}.`;
}

/** Removes the test-run lock when the process that holds it is gone (a run that was killed). */
export function clearDeadLock() {
  try {
    const held = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    try {
      process.kill(held.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') fs.rmSync(LOCK, { force: true });
    }
  } catch {
    /* no lock, or a half-written one: takeLock handles it */
  }
}
