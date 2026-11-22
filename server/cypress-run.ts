/**
 * Cypress run job of a sync: one full Cypress run with PHP coverage on the echowp sites cy-1 … cy-n
 * (profile "cypress"). The Playwright job (server/test-run.ts) is the model. The differences:
 *
 *  - The site holds a real copy of the plugin, not a link to the tracker's copy. Some Cypress tests
 *    delete the plugin through WordPress ("Show activation status"), and a delete follows a link:
 *    on 21 Nov 2026 that deleted the tracker's copy. The job makes a fresh copy for each run, puts a
 *    marker file in it, and refuses to select the run when the marker is gone after the run.
 *  - The site has the Cypress Helper Plugin (from GitHub trunk) on, and the Playwright Test Helper
 *    Plugin off: both declare the PHP function json_basic_auth_handler().
 *  - The store and debug settings come from the literal "wp option update" and "wp config set" lines of the plugin's CI setup script
 *    (cypress/support/wpCliSetup.sh).
 *  - Tests that need other paid plugins, a GitHub token, or that delete or install a plugin are left out.
 *  - Cypress runs one test at a time. So the job starts one Cypress process for each site, at the
 *    same time, each with a part of the spec files (split by their time in the last run). The port
 *    of each request names its site (sites.json), as in the Playwright job.
 *  - The exit code of Cypress is the number of failed spec files.
 *
 * Steps: packages, spec split, sites, helper plugin, plugin copy and options on each site, baseline, Cypress, checks,
 * coverage/cypress-windows.py, coverage/analyze.py, select. The sites stop at the end, also after a
 * failure or a cancel. The test-run lock (data/test-run.lock) allows one test run at a time.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db } from './db.ts';
import { addCoverageRun, ROOT, type ProjectConfig } from './projects.ts';
import { CYPRESS_PROFILE, CYPRESS_SITE_NAME, removeSitePlugin, SITE_COPY_MARKER, startTestSites, stopTestSitesSync, trackerEchowp, type TestSites } from './echowp.ts';
import { DATA, fullRunInfo, LOCK, mergePlan, pluginAdminLogin, SITE_MARK, stamp, takeLock, testWorkers, type Ctx, type RunPlan, type TestResult } from './test-run.ts';

const CHP_REPO = 'Rymera-Web-Co/cypress-helper-plugin';
const CHP_SLUG = 'cypress-helper-plugin';
const THP_SLUG = 'test-helper-plugin';
/** In the site's plugin copy (server/echowp.ts useRealPluginCopy). When it is gone after the run, a test deleted or reinstalled the plugin. */
const MARKER = SITE_COPY_MARKER;
const CONFIGS = ['cypress.config.js', 'cypress.config.ts', 'cypress.config.mjs', 'cypress.config.cjs', 'cypress.config.mts', 'cypress.config.cts'];
/** A spec file with one of these steps deletes or installs a plugin. */
const PLUGIN_STEP = /plugins? (is|are) (deleted|not installed)|is downloaded, installed/i;

/**
 * The Cypress project folder: the folder of cypress.config.* at or above the project's Cypress
 * test folder, inside the copy. Null when there is none.
 */
export function cypressRoot(p: ProjectConfig): string | null {
  if (!p.cypressDir) return null;
  for (let dir = path.join(p.path, p.cypressDir); dir.startsWith(p.path); dir = path.dirname(dir)) {
    if (CONFIGS.some((c) => fs.existsSync(path.join(dir, c)))) return dir;
    if (dir === p.path) break;
  }
  return null;
}

/** The top-level PHP file with a "Plugin Name:" header, or null. */
function mainFile(dir: string): string | null {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.php'));
  } catch {
    return null;
  }
  for (const f of names) {
    try {
      if (/^[ \t\/*#@]*Plugin Name:/im.test(fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 8192))) return f;
    } catch {
      /* unreadable */
    }
  }
  return null;
}

/** Splits a shell line into words. Handles '…' and "…" quotes. Null for anything else ($, `, \). */
export function shellWords(line: string): string[] | null {
  if (/[$`\\|&<>]/.test(line)) return null;
  const words: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) words.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return null;
  if (has || cur) words.push(cur);
  return words;
}

/**
 * The store and debug settings of the plugin's CI setup script: its "wp option update" and "wp config set"
 * lines, as wp-cli words, plus the lines that are left out (not literal: $, quotes that do not close).
 */
export function setupOptions(cyRoot: string): { apply: string[][]; skipped: string[] } {
  const file = path.join(cyRoot, 'cypress', 'support', 'wpCliSetup.sh');
  const apply: string[][] = [];
  const skipped: string[] = [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { apply, skipped };
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/;+\s*$/, '');
    if (!line.startsWith('wp option update ') && !line.startsWith('wp config set ')) continue;
    const w = shellWords(line);
    if (w && w.length >= 4 && w[0] === 'wp') apply.push(w.slice(1));
    else skipped.push(line);
  }
  return { apply, skipped };
}

/** Escapes the glob characters of a file path for excludeSpecPattern (minimatch). */
const globEscape = (s: string) => s.replace(/[[\]*?{}()!+@\\]/g, '\\$&');

/**
 * The tests to leave out:
 *  - tags that start with @integration (they need other plugins) and @zip-test (it needs a GitHub token)
 *  - spec files in a top-level Integration/ folder (other paid plugins)
 *  - spec files with a step that deletes or installs a plugin
 * Spec paths are relative to the Cypress project folder, with "/".
 */
export function cypressExclusions(p: ProjectConfig, cyRoot: string): { tags: string[]; specs: string[]; integration: number; pluginSteps: string[] } {
  const specRoot = path.join(p.path, p.cypressDir!);
  const tags = new Set<string>();
  const specs: string[] = [];
  const pluginSteps: string[] = [];
  let integration = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.feature')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim().startsWith('@')) continue;
          for (const t of line.match(/@[^\s@]+/g) ?? []) if (t.startsWith('@integration') || t === '@zip-test') tags.add(t);
        }
        const rel = path.relative(cyRoot, full).split(path.sep).join('/');
        const inSpecRoot = path.relative(specRoot, full).split(path.sep);
        if (inSpecRoot[0] === 'Integration') {
          specs.push(rel);
          integration++;
        } else if (PLUGIN_STEP.test(text)) {
          specs.push(rel);
          pluginSteps.push(path.relative(specRoot, full));
        }
      }
    }
  };
  walk(specRoot);
  return { tags: [...tags].sort(), specs, integration, pluginSteps };
}

/** sha1 of the package files, to install the packages again only when they changed. */
function packageHash(cyRoot: string): string {
  const h = crypto.createHash('sha1');
  for (const f of ['package.json', 'package-lock.json']) {
    try {
      h.update(f).update(fs.readFileSync(path.join(cyRoot, f)));
    } catch {
      /* no file */
    }
  }
  return h.digest('hex');
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The project of the Cypress run that runs in this process, for the exit handler. */
let active: ProjectConfig | null = null;

// The "finally" of runCypress does not run when the process exits (sync.ts calls process.exit on
// SIGINT, SIGTERM and SIGHUP). Stop the site here, synchronously.
process.on('exit', () => {
  if (!active) return;
  const p = active;
  active = null;
  try {
    for (const e of stopTestSitesSync(p, CYPRESS_PROFILE)) console.error(`Could not stop the Cypress site: ${e}`);
  } catch (e) {
    console.error(`Could not stop the Cypress site: ${(e as Error).message}`);
  }
  fs.rmSync(SITE_MARK, { force: true });
  fs.rmSync(LOCK, { force: true });
});

/**
 * Sites (and Cypress processes) for a run: the same number as the Playwright workers (half the
 * CPUs, at most 4). TRACKER_CYPRESS_WORKERS changes it (for trials).
 */
export function cypressWorkers(): number {
  const env = Number.parseInt(process.env.TRACKER_CYPRESS_WORKERS ?? '', 10);
  return env > 0 ? env : testWorkers();
}

/** Seconds of one spec file outside its scenarios (start of the browser, the spec bundle). */
const SPEC_OVERHEAD_S = 10;

/**
 * Seconds of each spec file in a Cypress run folder (its test-windows.json), or an empty map.
 * Keys are spec paths relative to the Cypress project folder, as in the windows.
 */
export function specSeconds(runDir: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!runDir) return out;
  try {
    for (const w of JSON.parse(fs.readFileSync(path.join(ROOT, runDir, 'test-windows.json'), 'utf8')) as any[]) {
      if (!w.file || !w.start || !w.end) continue;
      out.set(w.file, (out.get(w.file) ?? 0) + (w.end - w.start));
    }
  } catch {
    /* no windows */
  }
  return out;
}

/**
 * Splits the spec files into n groups with about the same time: the longest file first, into the
 * group with the least time. A file with no time from the last run gets the median time.
 */
export function splitSpecs(specs: string[], seconds: Map<string, number>, n: number): string[][] {
  const known = specs.map((f) => seconds.get(f)).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 60;
  const time = (f: string) => (seconds.get(f) ?? median) + SPEC_OVERHEAD_S;
  const groups = Array.from({ length: Math.max(1, n) }, () => ({ specs: [] as string[], t: 0 }));
  for (const f of [...specs].sort((a, b) => time(b) - time(a) || a.localeCompare(b))) {
    const g = groups.reduce((a, b) => (b.t < a.t ? b : a));
    g.specs.push(f);
    g.t += time(f);
  }
  return groups.map((g) => g.specs.sort()).filter((g) => g.length);
}

/** The spec files to run, relative to the Cypress project folder: all .feature files in the test folder, minus the left-out files. */
function specList(p: ProjectConfig, cyRoot: string, leftOut: string[]): string[] {
  const only = (process.env.TRACKER_CYPRESS_SPECS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (only.length) return only;
  const skip = new Set(leftOut);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.feature')) {
        const rel = path.relative(cyRoot, full).split(path.sep).join('/');
        if (!skip.has(rel)) out.push(rel);
      }
    }
  };
  walk(path.join(p.path, p.cypressDir!));
  return out.sort();
}

export async function runCypress(p: ProjectConfig, commit: string, ctx: Ctx, plan?: RunPlan): Promise<TestResult> {
  const cyRoot = cypressRoot(p);
  if (!cyRoot) return { ran: false, reason: `no cypress.config.* at or above ${p.cypressDir}` };
  const trackerMain = mainFile(p.path);
  if (!trackerMain || !fs.existsSync(path.join(p.path, '.git'))) return { ran: false, reason: `the copy ${p.path} has no plugin file or no .git` };
  takeLock(p.id);
  active = p;
  // A run that was stopped leaves its progress. The sync panel must not show it for this run.
  fs.rmSync(path.join(DATA, 'progress.json'), { force: true });
  const started = Date.now();
  let runDir: string | null = null;
  let site: TestSites | null = null;
  const runner = async (cmd: string, args: string[], env: NodeJS.ProcessEnv, onLine: (l: string) => void) =>
    (await ctx.run(cmd, args, { cwd: ROOT, env, quiet: true, onLine })).code ?? 1;
  const cancelled = () => {
    if (ctx.cancelled()) throw new Error('Cancelled');
  };
  try {
    const login = pluginAdminLogin(p);

    // 1. Packages: again when package.json or the lock file changed, or node_modules is missing.
    const hashFile = path.join(cyRoot, 'node_modules', '.tracker-package-hash');
    const hash = packageHash(cyRoot);
    let have = '';
    try {
      have = fs.readFileSync(hashFile, 'utf8').trim();
    } catch {
      /* not installed by the tracker yet */
    }
    if (have !== hash) {
      const lock = fs.existsSync(path.join(cyRoot, 'package-lock.json'));
      ctx.log(`Cypress packages: npm ${lock ? 'ci' : 'install'} in ${path.relative(p.path, cyRoot)}`);
      const r = await ctx.run('npm', [lock ? 'ci' : 'install', '--no-audit', '--no-fund'], { cwd: cyRoot, env: ctx.env() });
      cancelled();
      if (r.code !== 0) return { ran: false, reason: `the Cypress package install failed (exit ${r.code ?? r.signal})` };
      // npm install can write a lock file: take the fingerprint after the install.
      fs.writeFileSync(hashFile, packageHash(cyRoot) + '\n');
    }

    // 2. The spec files, split over the sites by their time in the last Cypress run.
    const ex = cypressExclusions(p, cyRoot);
    ctx.log(`Left out: tags ${ex.tags.join(' ') || '(none)'}; ${ex.integration} spec files in Integration/; ${ex.pluginSteps.length} spec files that delete or install a plugin${ex.pluginSteps.length ? ` (${ex.pluginSteps.join(', ')})` : ''}`);
    // A partial run: only the planned spec files (minus the left-out ones). It can be empty: then
    // the job makes only the baseline on one site, and keeps all tests from the last run.
    const leftOut = new Set(ex.specs);
    const specs = plan ? plan.files.filter((f) => !leftOut.has(f)) : specList(p, cyRoot, ex.specs);
    if (process.env.TRACKER_CYPRESS_SPECS) ctx.log(`TRACKER_CYPRESS_SPECS: only ${specs.join(', ')}`);
    if (plan) ctx.log(`Partial run: ${specs.length} spec file${specs.length === 1 ? '' : 's'}${specs.length ? `: ${specs.join(', ')}` : ' (only the baseline: no test touches the changed code)'}`);
    if (!specs.length && !plan) return { ran: false, nothingToRun: true, reason: 'no Cypress spec files to run (all are left out)' };
    // Each Cypress process needs its own hidden screen (Xvfb). Without xvfb-run, every process starts
    // Xvfb on display 99: the process that ends first closes it, and the others stop in the middle of a spec.
    const xvfbRun = haveXvfbRun();
    let want = Math.max(1, Math.min(cypressWorkers(), specs.length));
    if (want > 1 && !xvfbRun) {
      ctx.log('xvfb-run is not installed: Cypress runs on 1 site. Install the xvfb package to run on more sites.');
      want = 1;
    }
    const groups = specs.length ? splitSpecs(specs, specSeconds(p.runs.cypress?.dir), want) : [[]];
    const n = groups.length;

    // 3. The sites: cy-1 … cy-n in their own profile, each with a clean database.
    ctx.log(`Start ${n} echowp site${n === 1 ? '' : 's'} ${CYPRESS_SITE_NAME}-1${n > 1 ? ` … ${CYPRESS_SITE_NAME}-${n}` : ''} (profile ${CYPRESS_PROFILE})`);
    site = await startTestSites(p, n, login, ctx.log, runner, ctx.signal, { profile: CYPRESS_PROFILE, name: CYPRESS_SITE_NAME });
    cancelled();
    const sites = site.sites;

    // 4. The Cypress Helper Plugin from GitHub trunk, once for all sites. Keep the old one when the download fails.
    const tmp = path.join(DATA, 'cypress-helper');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const zip = path.join(tmp, 'chp.zip');
    const dl = await ctx.run('bash', ['-c', 'gh api "$1" > "$2"', '_', `repos/${CHP_REPO}/zipball/trunk`, zip], { cwd: ROOT, env: ctx.env(), quiet: true });
    cancelled();
    let chpSource: string | null = null;
    if (dl.code === 0 && (await ctx.run('unzip', ['-q', zip, '-d', path.join(tmp, 'x')], { cwd: ROOT, env: ctx.env(), quiet: true })).code === 0) {
      const top = fs.readdirSync(path.join(tmp, 'x'));
      if (top.length !== 1) return { ran: false, reason: `the ${CHP_REPO} zip has ${top.length} top folders` };
      chpSource = path.join(tmp, 'x', top[0]);
      ctx.log(`Cypress Helper Plugin: ${CHP_REPO} trunk`);
    } else {
      ctx.log(`Could not download ${CHP_REPO} (gh api, exit ${dl.code}). Each site keeps its old copy.`);
    }
    cancelled();

    // 5. Each site: a fresh real copy of the plugin with the marker, the helper plugin, and the options.
    const slug = path.basename(p.path);
    const opts = setupOptions(cyRoot);
    for (const l of opts.skipped) ctx.log(`Option line skipped (not a literal value): ${l}`);
    const setupSite = async (s: (typeof sites)[number]): Promise<string> => {
      const say = (l: string) => ctx.log(`[${s.name}] ${l}`);
      const wp = async (args: string[], onLine: (l: string) => void = say) =>
        trackerEchowp(p, ['wp', s.name, '--profile', CYPRESS_PROFILE, '--', ...args], onLine, { run: runner, signal: ctx.signal });
      // startTestSites put a real copy of the plugin in the site, with the marker.
      const sitePlugin = s.plugin;
      const pluginDir = path.dirname(sitePlugin);
      if (!sitePlugin || fs.lstatSync(sitePlugin).isSymbolicLink() || !fs.existsSync(path.join(sitePlugin, MARKER))) throw new SetupError(`the plugin of ${s.name} is not a real copy with the marker`);
      const chpDir = path.join(pluginDir, CHP_SLUG);
      if (chpSource) {
        removeSitePlugin(chpDir);
        fs.cpSync(chpSource, chpDir, { recursive: true, verbatimSymlinks: true });
      } else if (!fs.existsSync(chpDir)) {
        throw new SetupError(`could not download the Cypress Helper Plugin (${CHP_REPO}) with gh api. Is gh logged in?`);
      }
      await wp(['--skip-plugins', 'plugin', 'deactivate', THP_SLUG]);
      if ((await wp(['--skip-plugins', 'plugin', 'activate', CHP_SLUG, slug])) !== 0) throw new SetupError(`could not activate the Cypress Helper Plugin on ${s.name}`);
      cancelled();
      const failed: string[] = [];
      for (const a of opts.apply) if ((await wp(a, () => {})) !== 0) failed.push(a[2]);
      say(`${opts.apply.length - failed.length} of ${opts.apply.length} options and config settings set${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
      cancelled();
      return sitePlugin;
    };
    // Wait for all site setups, also when one fails: the job must not stop the sites and free the
    // lock while other setups still run.
    const setups = await Promise.allSettled(sites.map(setupSite));
    const bad = setups.find((x): x is PromiseRejectedResult => x.status === 'rejected');
    if (bad) {
      if (bad.reason instanceof SetupError) return { ran: false, reason: bad.reason.message };
      throw bad.reason;
    }
    const sitePlugins = setups.map((x) => (x as PromiseFulfilledResult<string>).value);
    fs.rmSync(tmp, { recursive: true, force: true });

    // 6. Record only these sites. A clean request folder, then the baseline page loads on each site
    //    (their code is library code, and a new site's first admin visit goes to a setup page).
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(SITE_MARK, JSON.stringify({ ports: sites.map((s) => s.port), pid: process.pid, project: p.id }) + '\n');
    const raw = path.join(DATA, 'raw');
    fs.mkdirSync(raw, { recursive: true });
    for (const f of fs.readdirSync(raw)) if (f.endsWith('.json') || f.endsWith('.json.tmp')) fs.rmSync(path.join(raw, f));
    for (const f of ['test-windows.json', 'progress.json']) fs.rmSync(path.join(DATA, f), { force: true });
    const env = ctx.env({ ADMIN_USERNAME: login.user, ADMIN_PASSWORD: login.password });
    for (const s of sites) {
      ctx.log(`Baseline page loads on ${s.url}`);
      const base = await ctx.run('bash', [path.join(ROOT, 'coverage', 'baseline.sh'), s.url], { cwd: ROOT, env });
      cancelled();
      if (base.code !== 0) return { ran: false, reason: `the baseline page loads on ${s.name} failed (exit ${base.code ?? base.signal})` };
    }
    if (!fs.readdirSync(raw).some((f) => f.endsWith('.json'))) return { ran: false, reason: `the sites wrote no coverage files. Check that ${sites[0].url} runs with coverage/prepend.php` };
    // Each site must record lines of the plugin. On 21 Nov 2026 three new sites recorded none: PHP ran
    // cached code from the tracker's copy (through the link of the new site), not the site's copy.
    const silent = sitesWithoutPluginLines(raw, sites, slug);
    if (silent.length) return { ran: false, reason: `the baseline page loads on ${silent.join(', ')} recorded no lines of ${slug}. PHP may run cached code from another folder: stop all tracker sites, and run the sync again` };

    // 7. The tests: one Cypress process for each site, at the same time.
    const runRel = path.join('data', 'projects', p.id, 'runs', `${stamp()}-sync-cypress-${commit.slice(0, 8)}`);
    runDir = path.join(ROOT, runRel);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'sites.json'), JSON.stringify(sites.map((s, slot) => ({ slot, name: s.name, port: s.port })), null, 2) + '\n');
    const tags = ex.tags.map((t) => `not ${t}`).join(' and ');
    // Last check before tests that can delete the plugin: each site's plugin must be a real folder.
    for (const sp of sitePlugins) {
      if (fs.lstatSync(sp).isSymbolicLink() || !fs.existsSync(path.join(sp, MARKER))) return { ran: false, reason: `STOP: the site's plugin ${sp} is a link or has no marker` };
    }
    const progressFile = path.join(DATA, 'progress.json');
    const per = sites.map((_, i) => ({ total: groups[i].length, done: 0, failed: 0 }));
    const progress = { total: specs.length, done: 0, failed: 0, current: '' };
    const saveProgress = () => {
      progress.done = per.reduce((a, x) => a + x.done, 0);
      progress.failed = per.reduce((a, x) => a + x.failed, 0);
      fs.writeFileSync(progressFile, JSON.stringify(progress) + '\n');
    };
    saveProgress();
    let buildErrors = 0;
    const messages = sites.map((s) => path.join(runDir!, `cucumber-messages-${s.name}.ndjson`));
    ctx.log(`Cypress run: ${specs.length} spec files on ${n} site${n === 1 ? '' : 's'} (${groups.map((g) => g.length).join(' + ')}), one test at a time on each site.`);
    const runOne = async (i: number) => {
      const s = sites[i];
      const config = {
        excludeSpecPattern: ex.specs.map(globEscape),
        // Own folders for each process, so that the processes do not clean or overwrite each other's files.
        screenshotsFolder: `cypress/screenshots/tracker-${s.name}`,
        downloadsFolder: `cypress/downloads/tracker-${s.name}`,
        e2e: { video: false },
      };
      const args = [
        'cypress', 'run', '--config', JSON.stringify(config),
        '--env', `${tags ? `tags=${tags},` : ''}messagesEnabled=true,messagesOutput=${messages[i]},jsonEnabled=false`,
        '--spec', groups[i].map(globEscape).join(','),
      ];
      const logFile = fs.openSync(path.join(runDir!, `full-run-${s.name}.log`), 'w');
      try {
        // xvfb-run -d: Xvfb picks a free display number itself. The cookie file stays out of the plugin copy.
        const [cmd, cmdArgs] = n > 1 ? ['xvfb-run', ['-d', '-f', path.join(DATA, `xauth-${s.name}`), '-s', '-screen 0 1920x1080x24', 'npx', ...args]] : ['npx', args];
        const r = await ctx.run(cmd, cmdArgs, {
          cwd: cyRoot,
          env: ctx.env({ TEST_SITE_URL: s.url, TEST_SITE_ADMIN_USER: login.user, TEST_SITE_ADMIN_PASSWORD: login.password }),
          quiet: true,
          onLine: (l) => {
            fs.writeSync(logFile, l + '\n');
            const t = stripAnsi(l);
            const found = t.match(/Specs:\s+(\d+) found/);
            const running = t.match(/Running:\s+(.*?)\s+\((\d+) of (\d+)\)/);
            const failing = t.match(/^\s+(\d+) failing/);
            if (found) per[i].total = Number(found[1]);
            if (running) {
              progress.current = running[1];
              per[i].done = Number(running[2]) - 1;
            }
            if (failing) per[i].failed += Number(failing[1]);
            if (found || running || failing) saveProgress();
            if (/we found an error preparing this test file/.test(t)) buildErrors++;
          },
        });
        // The last spec has no "Running:" line after it: count the site's specs as done.
        per[i].done = per[i].total;
        saveProgress();
        return r;
      } finally {
        fs.closeSync(logFile);
      }
    };
    const results = specs.length ? await Promise.all(sites.map((_, i) => runOne(i))) : [];
    cancelled();
    const minutes = Math.round((Date.now() - started) / 6000) / 10;
    const exit = results.some((r) => r.code === null) ? null : results.reduce((a, r) => a + (r.code ?? 0), 0);
    ctx.log(`Cypress ended (exit ${results.map((r, i) => `${sites[i].name} ${r.code ?? r.signal}`).join(', ')}) after ${minutes} minutes`);

    // 8. Checks. A test must not have touched the tracker's copy or replaced a site's plugin.
    if (!fs.existsSync(path.join(p.path, '.git')) || !fs.existsSync(path.join(p.path, trackerMain))) {
      return { ran: true, selected: false, runDir: runRel, minutes, reason: `STOP: the tracker's copy ${p.path} lost files during the Cypress run. Restore it before the next sync.` };
    }
    for (const sp of sitePlugins) {
      let siteOk = false;
      try {
        siteOk = !fs.lstatSync(sp).isSymbolicLink() && fs.existsSync(path.join(sp, MARKER));
      } catch {
        /* gone */
      }
      if (!siteOk) return { ran: true, selected: false, runDir: runRel, minutes, reason: `a test deleted or replaced the site's plugin copy (${sp}), so the later tests did not test this commit` };
    }
    if (exit === null) return { ran: true, selected: false, runDir: runRel, minutes, reason: `Cypress did not finish (${results.map((r) => r.signal).filter(Boolean).join(', ')})` };
    if (buildErrors) return { ran: true, selected: false, runDir: runRel, minutes, reason: `Cypress could not build ${buildErrors} spec files. See full-run-*.log` };
    const missing = specs.length ? messages.filter((m) => !fs.existsSync(m)) : [];
    if (missing.length) return { ran: true, selected: false, runDir: runRel, minutes, reason: `Cypress wrote no Cucumber messages file for ${missing.length} site(s)` };

    // 9. Windows (each with the slot of its site), copy, analyze.
    const windows: any[] = [];
    for (const [slot, m] of (specs.length ? messages : []).entries()) {
      const out = path.join(DATA, `test-windows-${slot}.json`);
      const w = await ctx.run('python3', [path.join(ROOT, 'coverage', 'cypress-windows.py'), m, out], { cwd: ROOT, env: ctx.env() });
      cancelled();
      if (w.code !== 0 || !fs.existsSync(out)) return { ran: true, selected: false, runDir: runRel, minutes, reason: `cypress-windows.py failed for ${sites[slot].name}` };
      for (const x of JSON.parse(fs.readFileSync(out, 'utf8')) as any[]) windows.push({ ...x, slot });
      fs.rmSync(out, { force: true });
    }
    const windowsFile = path.join(DATA, 'test-windows.json');
    fs.writeFileSync(windowsFile, JSON.stringify(windows, null, 1) + '\n');
    const last = new Map<string, any>();
    for (const x of windows) if (!last.has(x.id) || (last.get(x.id).retry ?? 0) < (x.retry ?? 0)) last.set(x.id, x);
    const all = [...last.values()];
    const counts = {
      total: all.length,
      passed: all.filter((x) => x.status === 'passed').length,
      skipped: all.filter((x) => x.status === 'skipped').length,
      failed: all.filter((x) => x.status !== 'passed' && x.status !== 'skipped').length,
    };
    fs.cpSync(raw, path.join(runDir, 'raw'), { recursive: true });
    fs.copyFileSync(windowsFile, path.join(runDir, 'test-windows.json'));
    let partial: TestResult['partial'];
    if (plan) {
      // Do not keep old tests of the spec files that ran now, nor of the left-out spec files (for
      // example a spec that deletes the plugin, which an older run still had).
      const mg = await mergePlan(p, { ...plan, files: [...specs, ...ex.specs] }, runDir, commit, ctx);
      cancelled();
      if (mg.error) return { ran: true, selected: false, runDir: runRel, minutes, ...counts, reason: mg.error };
      partial = { files: specs.length, keptTests: mg.summary?.keptTests ?? 0 };
    }
    const exclude = p.excludeDirs ? ['--exclude', p.excludeDirs.join(',')] : [];
    ctx.log('Coverage analysis (analyze.py)');
    const an = await ctx.run('python3', [path.join(ROOT, 'coverage', 'analyze.py'), p.path, runDir, ...exclude], { cwd: ROOT, env: ctx.env() });
    cancelled();
    const extra: Record<string, unknown> = plan ? plan.info : fullRunInfo();
    const untested = Array.isArray(extra.untested) ? extra.untested.length : 0;
    const result: TestResult = { ran: true, runDir: runRel, exit, minutes, ...counts, ...(partial ? { partial } : {}), untested };
    if (an.code !== 0) return { ...result, selected: false, reason: `analyze.py failed: ${an.out.trim().split('\n').slice(-2).join(' | ')}` };

    // 10. Select the run only when the report has the tests and some passed.
    let reportTests = 0;
    try {
      reportTests = (JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8')).tests ?? []).length;
    } catch {
      /* no report */
    }
    if (!reportTests || (counts.passed === 0 && !plan)) return { ...result, selected: false, reason: `the report has ${reportTests} tests and ${counts.passed} passed: not a good run` };
    const dirty = execFileSync('git', ['-C', p.path, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() !== '';
    fs.writeFileSync(
      path.join(runDir, 'run-info.json'),
      JSON.stringify({ pluginCommit: commit, pluginDirty: dirty, recordedAt: new Date().toISOString().slice(0, 10), note: `Sync of ${p.syncBranch} (Cypress, ${n} sites${plan ? ', partial' : ''})`, minutes, ...counts, ...extra, ...(partial ? { partial: { ...(extra.partial as object), ...partial } } : {}) }, null, 2) + '\n',
    );
    const label = `Cypress, ${p.syncBranch ?? 'sync'} ${commit.slice(0, 7)}, ${new Date().toISOString().slice(0, 10)}`;
    const runId = addCoverageRun(p.id, runRel, 'cypress', label);
    db.prepare('UPDATE projects SET cypress_run_id = ? WHERE id = ?').run(runId, p.id);
    ctx.log(`Selected the new Cypress run: ${runRel} (${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped)`);
    return { ...result, selected: true };
  } catch (e) {
    if ((e as Error).message === 'Cancelled' && runDir) fs.rmSync(runDir, { recursive: true, force: true });
    throw e;
  } finally {
    try {
      if (site) await site.stop();
    } catch (e) {
      ctx.log(`Could not stop the Cypress sites: ${(e as Error).message}`);
    }
    fs.rmSync(path.join(DATA, 'cypress-helper'), { recursive: true, force: true });
    for (const f of fs.existsSync(DATA) ? fs.readdirSync(DATA) : []) if (f.startsWith('xauth-')) fs.rmSync(path.join(DATA, f), { force: true });
    fs.rmSync(SITE_MARK, { force: true });
    fs.rmSync(LOCK, { force: true });
    active = null;
  }
}

/** Sites whose baseline requests (in the raw folder) hold no line of the plugin. */
function sitesWithoutPluginLines(raw: string, sites: { name: string; port: number }[], slug: string): string[] {
  const ok = new Set<number>();
  for (const f of fs.readdirSync(raw)) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(raw, f), 'utf8'));
      const files = r?.plugins?.[slug]?.files;
      if (r?.kind === 'baseline' && files && Object.keys(files).length) ok.add(r.port);
    } catch {
      /* a file that is not complete */
    }
  }
  return sites.filter((s) => !ok.has(s.port)).map((s) => s.name);
}

function haveXvfbRun(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A site setup problem: the run is not made, with this reason. */
class SetupError extends Error {}
