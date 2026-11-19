/**
 * echowp for the tracker's own plugin copies, with coverage.
 *
 * echowp runs one FrankenPHP process for all projects that use the same PHP version
 * (echowp docs/DESIGN.md §5). So the tracker must not share the echowp of the user:
 * then the user's own sites could get Xdebug, or the tracker's sites could lose it.
 * The tracker therefore runs echowp with its own home (ECHOWP_HOME = data/echowp-home).
 * That home has its own registry, FrankenPHP process, MariaDB and download cache.
 *
 * Each echowp command from here gets:
 *  - ECHOWP_HOME            data/echowp-home
 *  - PATH                   the coverage PHP (server/coverage-php.ts) first, then the no-sudo stubs
 *  - PHP_INI_SCAN_DIR       loads Xdebug and coverage/prepend.php
 *  - --dir                  the project's plugin copy
 * The user's shell and the user's echowp do not change.
 *
 * "up" also: makes the coverage PHP when it is missing, serves plain HTTP (the tracker's home
 * has its own certificate, which browsers do not trust), picks ports from 8801 that neither
 * echowp home uses, and checks that the server runs the coverage PHP.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { COVERAGE_PHP_DIR, prepareCoveragePhp, type CoveragePhpInfo } from './coverage-php.ts';
import { ROOT, type ProjectConfig } from './projects.ts';
import { childEnv, NO_SUDO, SETPRIV } from './sync.ts';

export const TRACKER_ECHOWP_HOME = path.join(ROOT, 'data', 'echowp-home');
/** The tracker's sites start here, away from the user's sites (echowp starts at 8001). */
export const PORT_BASE = 8801;

/** The real echowp program (not the stub in coverage/no-sudo), or null. */
export function findEchowp(): string | null {
  try {
    return echowpBin();
  } catch {
    return null;
  }
}

function echowpBin(): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === NO_SUDO) continue;
    const p = path.join(dir, 'echowp');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  throw new Error('echowp is not on PATH.');
}

function userEchowpHome(): string {
  const h = process.env.ECHOWP_HOME;
  return h && path.resolve(h) !== TRACKER_ECHOWP_HOME ? h : path.join(os.homedir(), '.echowp');
}

/** The environment of each echowp command of the tracker. */
export function trackerEchowpEnv(cov: CoveragePhpInfo): NodeJS.ProcessEnv {
  const env = childEnv({
    ECHOWP_HOME: TRACKER_ECHOWP_HOME,
    PHP_INI_SCAN_DIR: path.join(cov.dir, 'ini'),
  });
  env.PATH = `${path.join(cov.dir, 'bin')}${path.delimiter}${env.PATH}`;
  // Settings of the user's shell must not change the tracker's sites.
  for (const k of ['ECHOWP_DIR', 'ECHOWP_CONFIG', 'ECHOWP_PROFILE', 'ECHOWP_PHP', 'ECHOWP_WORDPRESS', 'ECHOWP_PLUGINS', 'ECHOWP_THEMES']) delete env[k];
  return env;
}

/** The current coverage PHP, or null when it is not made yet. */
function currentCoveragePhp(): CoveragePhpInfo | null {
  const infoFile = path.join(COVERAGE_PHP_DIR, 'current', 'info.json');
  return fs.existsSync(infoFile) ? JSON.parse(fs.readFileSync(infoFile, 'utf8')) : null;
}

/** The coverage PHP, made when it is missing. signal: a cancel stops the download and the Docker build. */
async function coveragePhp(log: (l: string) => void, signal?: AbortSignal): Promise<CoveragePhpInfo> {
  const cur = currentCoveragePhp();
  if (cur) return cur;
  log('No coverage PHP yet. Make it first (a download and a Docker build, about 1 minute)…');
  return prepareCoveragePhp({ onLine: log, signal });
}

/** Ports in an echowp registry: services, sites and the portless front. */
function registryPorts(home: string): Set<number> {
  const ports = new Set<number>();
  let r: any;
  try {
    r = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));
  } catch {
    return ports;
  }
  const walk = (v: any, key = '') => {
    if (typeof v === 'number' && /port|admin|https?$/i.test(key)) ports.add(v);
    else if (typeof v === 'string' && key === 'url') {
      const m = v.match(/:(\d+)(\/|$)/);
      if (m) ports.add(Number(m[1]));
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(r);
  return ports;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** True when port p is free: not in either echowp registry, and nothing listens on it. */
async function portUsable(p: number, used: Set<number>): Promise<boolean> {
  return !used.has(p) && (await portFree(p));
}

/** The lowest base from PORT_BASE with n free ports in a row, used by neither echowp home. */
async function pickPortBase(n: number): Promise<number> {
  const used = new Set([...registryPorts(userEchowpHome()), ...registryPorts(TRACKER_ECHOWP_HOME)]);
  for (let base = PORT_BASE; base < PORT_BASE + 1000; base++) {
    let ok = true;
    for (let p = base; p < base + n && ok; p++) ok = await portUsable(p, used);
    if (ok) return base;
  }
  throw new Error(`No ${n} free ports from ${PORT_BASE}.`);
}

/** The port of a site in "echowp ls --json": the port in its URL. */
function sitePort(s: any): number | null {
  const m = String(s?.tooling ?? s?.url ?? '').match(/:(\d+)(\/|$)/);
  return m ? Number(m[1]) : null;
}

/** A new site cannot get the port that comes after the ports of the existing sites. */
export class PortClash extends Error {}

/**
 * The start port for an "up" that adds sites to sites that exist. echowp gives the k-th site
 * of the "up" the port base+k-1, and it refuses to move a site that exists (echowp
 * internal/engine/engine.go, applyRequestedPorts and errPortMoved). So the base must keep the
 * ports of the existing sites: base = port of the k-th site minus (k-1).
 * target: the names of all sites of the "up", in order. mine: the sites of target that exist.
 */
async function portBaseForMore(mine: any[], target: string[]): Promise<number> {
  const bases = new Set<number>();
  for (const s of mine) {
    const port = sitePort(s);
    if (!port) throw new Error(`The tracker cannot read the port of site ${s.name}. Give --port, or remove the sites with "down" first.`);
    bases.add(port - target.indexOf(s.name));
  }
  if (bases.size !== 1) throw new PortClash(`The sites of this project do not have ports in a row. Give --port, or remove the sites with "down" first.`);
  const base = [...bases][0];
  const own = new Set(mine.map(sitePort));
  const used = new Set([...registryPorts(userEchowpHome()), ...registryPorts(TRACKER_ECHOWP_HOME)]);
  for (let p = base; p < base + target.length; p++) {
    if (own.has(p)) continue;
    if (!(await portUsable(p, used))) throw new PortClash(`Port ${p} is in use, so a new site cannot get it. Remove the sites with "down" first. The next "up" then picks new ports.`);
  }
  return base;
}

/** The PHP version that the project's echowp.yml asks for ("" when none). */
function configPhp(configFile: string): string[] {
  const text = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  return [...text.matchAll(/^\s*php:\s*["']?([^"'\s#]*)/gm)].map((m) => m[1]).filter(Boolean);
}

/** The names in the "sites:" list of the project's echowp.yml, in order. */
function siteNames(configFile: string): string[] {
  const text = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const sites = text.split(/^sites:\s*$/m)[1];
  return sites ? [...sites.split(/^\S/m)[0].matchAll(/^\s*-\s*name:\s*["']?([^"'\s#]+)/gm)].map((m) => m[1]) : [];
}

/** Sites of this project in the tracker's echowp home (echowp ls --json). */
async function trackerSites(p: ProjectConfig, env: NodeJS.ProcessEnv, extra: string[] = []): Promise<any[]> {
  let out = '';
  try {
    const code = await spawnRunner(echowpBin(), ['ls', '--json', '--dir', p.path, ...extra], env, () => {}, (b) => (out += b));
    if (code !== 0) return [];
    const v = JSON.parse(out);
    return Array.isArray(v) ? v : (v.instances ?? []);
  } catch {
    return [];
  }
}

/** Runs one command and returns its exit code. The default adds setpriv and its own process group. */
export type EchowpRunner = (cmd: string, args: string[], env: NodeJS.ProcessEnv, onLine: (l: string) => void) => Promise<number>;

/** stdout: when given, it gets stdout and onLine gets only stderr. */
const spawnRunner = (bin: string, args: string[], env: NodeJS.ProcessEnv, onLine: (l: string) => void, stdout?: (b: Buffer) => void) =>
  new Promise<number>((resolve, reject) => {
    if (!SETPRIV) throw new Error('setpriv is missing. The tracker runs echowp only with "setpriv --no-new-privs", so that it cannot ask for a password.');
    const child = spawn(SETPRIV, ['--no-new-privs', '--', bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let partial = '';
    const take = (b: Buffer) => {
      const lines = (partial + b.toString()).split('\n');
      partial = lines.pop() ?? '';
      for (const l of lines) onLine(l.replace(/\r$/, ''));
    };
    child.stdout.on('data', stdout ?? take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (n) => {
      if (partial) onLine(partial);
      resolve(n ?? 1);
    });
  });

/** The value of an option: "--name value" or "--name=value". Fails when the value is missing. */
function optValue(a: string[], name: string): string | null {
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(`--${name}=`)) return a[i].slice(name.length + 3);
    if (a[i] === `--${name}`) {
      const v = a[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value.`);
      return v;
    }
  }
  return null;
}

export interface EchowpOptions {
  /** More environment for echowp, for example ECHOWP_ADMIN_USER. */
  env?: Record<string, string>;
  /** Runs the command. A sync gives its own runner, so that a cancel stops echowp too. */
  run?: EchowpRunner;
  /** A cancel of the sync. It stops a build of the coverage PHP. */
  signal?: AbortSignal;
}

/** Runs echowp for a project in the tracker's home, with its output to log. Returns the exit code. */
export async function trackerEchowp(p: ProjectConfig, args: string[], log: (l: string) => void = console.log, o: EchowpOptions = {}): Promise<number> {
  const cov = await coveragePhp(log, o.signal);
  const env = { ...trackerEchowpEnv(cov), ...o.env };
  fs.mkdirSync(TRACKER_ECHOWP_HOME, { recursive: true });
  const a = [...args];
  const sub = a[0];
  const configName = optValue(a, 'config') ?? 'echowp.yml';
  const configFile = path.resolve(p.path, configName);

  if (sub === 'up') {
    const series = cov.php.split('.').slice(0, 2).join('.');
    const php = optValue(a, 'php');
    const asks = [...configPhp(configFile), ...(php ? [php] : [])];
    const wrong = asks.filter((v) => v !== series && v !== cov.php); // "8.5" or "8.5.8" fit
    if (wrong.length) throw new Error(`${configName} asks for PHP ${wrong.join(', ')}, but the coverage PHP has ${cov.php}. echowp would use its normal PHP, with no coverage.`);
    if (!a.some((x) => x === '--https' || x.startsWith('--https=') || x === '--portless')) a.push('--https=false');
    if (!a.some((x) => x === '--port' || x.startsWith('--port='))) {
      // The sites that "up" makes (echowp internal/engine/engine.go, sitesToConverge): with --count
      // or --name, the clones <name>-1 … <name>-N (default name "site", count 1); else the
      // "sites:" list of the config.
      const count = Number(optValue(a, 'count'));
      const prefix = optValue(a, 'name');
      const target = count || prefix ? Array.from({ length: count || 1 }, (_, i) => `${prefix ?? 'site'}-${i + 1}`) : siteNames(configFile);
      const profile = optValue(a, 'profile');
      const known = await trackerSites(p, env, profile ? ['--profile', profile] : []);
      const mine = known.filter((s) => target.includes(s.name));
      // Always give a start port when "up" makes a site: without one, echowp gives new sites its
      // default ports from 8001, which the user's sites use. An existing site keeps its port.
      if (!target.length) {
        // The tracker cannot read the site list: keep 10 ports free for a first start.
        if (!known.length) a.push('--port', String(await pickPortBase(10)));
      } else if (mine.length === target.length) {
        // No new site.
      } else if (!mine.length) a.push('--port', String(await pickPortBase(target.length)));
      else a.push('--port', String(await portBaseForMore(mine, target)));
    }
  }
  // echowp down takes no site names, and it needs --all (echowp internal/cli/commands.go, "down").
  if (sub === 'down' && !a.includes('--all')) a.push('--all');

  const code = await (o.run ?? spawnRunner)(echowpBin(), [...a, '--dir', p.path], env, log);

  if (sub === 'up' && code === 0) {
    const bad = serversWithoutCoverage(cov);
    if (bad.length) throw new Error(`The echowp server does not run the coverage PHP: ${bad.join(', ')}. The sites record no coverage.`);
    log('Coverage: the server runs the coverage PHP with Xdebug.');
  }
  return code;
}

/** FrankenPHP servers of the tracker's echowp home that do not run the coverage binary. */
export function serversWithoutCoverage(cov: CoveragePhpInfo): string[] {
  let r: any;
  try {
    r = JSON.parse(fs.readFileSync(path.join(TRACKER_ECHOWP_HOME, 'registry.json'), 'utf8'));
  } catch {
    return ['(no registry)'];
  }
  const want = fs.realpathSync(path.join(cov.dir, 'bin', 'frankenphp'));
  const bad: string[] = [];
  let found = 0;
  for (const [name, s] of Object.entries<any>(r.services ?? {})) {
    if (name === 'mariadb' || !s?.pid) continue;
    // A pid of a server that stopped (for example after a crash) stays in the registry. Skip it.
    let exe = '';
    try {
      exe = fs.readlinkSync(`/proc/${s.pid}/exe`);
    } catch {
      continue;
    }
    found++;
    // "<path> (deleted)": the binary was made again (coverage-php --force) after the server started.
    if (exe.endsWith(' (deleted)')) {
      bad.push(`${name} (pid ${s.pid}) runs an old coverage PHP that was made again. To restart it, stop all running tracker sites (npm run project -- echowp <id> stop <site>), then start them again`);
      continue;
    }
    try {
      exe = fs.realpathSync(exe);
    } catch {}
    let scan = '';
    try {
      scan = (fs.readFileSync(`/proc/${s.pid}/environ`, 'utf8').split('\0').find((x) => x.startsWith('PHP_INI_SCAN_DIR=')) ?? '').slice(17);
    } catch {}
    if (exe !== want || path.resolve(scan) !== path.join(cov.dir, 'ini')) bad.push(`${name} (pid ${s.pid}, ${exe}). To restart it, stop all running tracker sites (npm run project -- echowp <id> stop <site>), then start them again`);
  }
  return found ? bad : ['(no running FrankenPHP server)'];
}

/** The test site of a sync test run: profile "test", like the plugin's own echowp runs (site-1 … site-N). */
export const TEST_PROFILE = 'test';

export interface TestSite {
  name: string;
  url: string;
  /** echowp clone number: site-1 is 1. Playwright worker slot k uses the site with index k+1. */
  index: number;
  port: number;
}

export interface TestSites {
  /** Sorted by index: sites[k] is the site of worker slot k. */
  sites: TestSite[];
  /** Stops all sites and keeps their data. The next run starts them again in about 1 second each. */
  stop: () => Promise<void>;
}

/**
 * Starts n test sites of the project (site-1 … site-n, profile "test") in the tracker's echowp
 * home, resets the database of each to the echowp template, and gives their URLs. Sites with a
 * higher number from an earlier run stay stopped. The first start of a project downloads
 * WordPress and plugins, and each new site is a clone of the first.
 * admin: the login that the tests use. echowp puts it into the template when it makes the site.
 */
export async function startTestSites(
  p: ProjectConfig,
  n: number,
  admin: { user: string; password: string },
  log: (l: string) => void,
  run?: EchowpRunner,
  signal?: AbortSignal,
): Promise<TestSites> {
  const o: EchowpOptions = { env: { ECHOWP_ADMIN_USER: admin.user, ECHOWP_ADMIN_PASSWORD: admin.password }, run, signal };
  const prof = ['--profile', TEST_PROFILE];
  const cov = await coveragePhp(log, signal);
  const env = trackerEchowpEnv(cov);
  // Stops every running site of the test profile. Not with the sync's runner: after a cancel,
  // that runner starts nothing, but the sites must stop.
  const stopAll = async () => {
    for (const s of await trackerSites(p, env, prof)) {
      if (s.status !== 'running') continue;
      const code = await trackerEchowp(p, ['stop', s.name, ...prof], log, { env: o.env });
      if (code !== 0) log(`echowp stop ${s.name} failed (exit ${code}).`);
    }
  };
  try {
    let up: number;
    try {
      up = await trackerEchowp(p, ['up', '--count', String(n), ...prof], log, o);
    } catch (e) {
      // New sites must get the ports right after the ports of the existing sites (portBaseForMore).
      // Another project's site can have one of those ports, for example after one-site runs.
      // Then remove the test sites of this project, and start all n on a new block of free ports.
      // The tests reset the database of each site, so no data is lost.
      if (!(e instanceof PortClash)) throw e;
      log(`${(e as Error).message} Remove the test sites of this project and start ${n} new sites on free ports.`);
      await stopAll();
      for (const s of await trackerSites(p, env, prof)) {
        const rm = await trackerEchowp(p, ['rm', s.name, ...prof], log, o);
        if (rm !== 0) throw new Error(`echowp rm ${s.name} failed (exit ${rm}).`);
      }
      up = await trackerEchowp(p, ['up', '--count', String(n), ...prof], log, o);
    }
    if (up !== 0) throw new Error(`echowp up failed (exit ${up}).`);
    const want = Array.from({ length: n }, (_, i) => `site-${i + 1}`);
    const running = (await trackerSites(p, env, prof)).filter((s) => s.status === 'running' && s.url);
    const sites: TestSite[] = [];
    for (const [i, name] of want.entries()) {
      const s = running.find((x) => x.name === name);
      const port = s && sitePort(s);
      if (!s || !port) throw new Error(`echowp up ended, but echowp ls shows no running site ${name} with a port in profile "${TEST_PROFILE}".`);
      sites.push({ name, url: String(s.url).replace(/\/+$/, ''), index: i + 1, port });
    }
    // A clean database for each run, so that the data of the last run does not change the result.
    for (const s of sites) {
      const reset = await trackerEchowp(p, ['reset', s.name, ...prof], log, o);
      if (reset !== 0) throw new Error(`echowp reset ${s.name} failed (exit ${reset}).`);
    }
    return { sites, stop: stopAll };
  } catch (e) {
    // A failed or cancelled start must not leave a site on.
    try {
      await stopAll();
    } catch (e2) {
      log(`Could not stop the test sites: ${(e2 as Error).message}`);
    }
    throw e;
  }
}

/**
 * Stops the running test sites of a project, and waits for it. For the exit of the server,
 * where async code does not run. It does not make the coverage PHP. Gives the errors.
 */
export function stopTestSitesSync(p: ProjectConfig): string[] {
  const cov = currentCoveragePhp();
  const bin = findEchowp();
  if (!cov || !bin || !SETPRIV) return [];
  const env = trackerEchowpEnv(cov);
  const go = (args: string[]) =>
    spawnSync(SETPRIV!, ['--no-new-privs', '--', bin, ...args, '--profile', TEST_PROFILE, '--dir', p.path], { env, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const ls = go(['ls', '--json']);
  let sites: any[] = [];
  try {
    const v = JSON.parse(ls.stdout);
    sites = Array.isArray(v) ? v : (v.instances ?? []);
  } catch {
    return [`echowp ls failed: ${String(ls.stderr || ls.error?.message || '').trim().slice(-300)}`];
  }
  const errors: string[] = [];
  for (const s of sites) {
    if (s.status !== 'running') continue;
    const r = go(['stop', s.name]);
    if (r.status !== 0) errors.push(`echowp stop ${s.name} failed: ${String(r.stderr || r.error?.message || '').trim().slice(-300)}`);
  }
  return errors;
}
