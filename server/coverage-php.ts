/**
 * Coverage PHP for echowp sites.
 *
 * echowp serves its sites with FrankenPHP. The normal FrankenPHP binary cannot load Xdebug,
 * because it is fully static. FrankenPHP also publishes a "-gnu" binary of the same release
 * that can load add-on files. Xdebug cannot be built into PHP (static-php-cli builds it only
 * as an add-on), so this file makes the add-on:
 *
 *  1. download  frankenphp-linux-<arch>-gnu from the FrankenPHP release, check its sha256
 *               against the digest that GitHub gives for the file
 *  2. probe     read its PHP version and build ID ("API20250925,TS")
 *  3. xdebug    build Xdebug with pecl in the official php:<version>-zts-trixie Docker image,
 *               and check that the image has the same build ID
 *  4. verify    load Xdebug into the binary and record the coverage of a small script
 *  5. write     data/coverage-php/<name>/ with bin/frankenphp, xdebug.so and ini/coverage.ini,
 *               and point data/coverage-php/current to it
 *
 * Use it only through server/echowp.ts (`npm run project -- echowp <id> up`), never in the
 * user's shell: echowp shares one FrankenPHP process between all projects of an echowp home.
 * echowp uses a frankenphp that it finds on PATH before it downloads one (echowp
 * internal/runtimes/resolve.go), and its server gets the environment of echowp, so
 * PHP_INI_SCAN_DIR loads Xdebug and the tracker's coverage/prepend.php. If the site asks for
 * another PHP version than this binary has, echowp quietly uses its normal binary.
 *
 * Safety: each command runs without a terminal, under setpriv --no-new-privs, with the
 * coverage/no-sudo stubs first in PATH (the same as a sync). Docker must work without sudo.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './projects.ts';
import { childEnv, SETPRIV } from './sync.ts';

export const COVERAGE_PHP_DIR = path.join(ROOT, 'data', 'coverage-php');
/** The Xdebug version to build. Change it here to move to a new Xdebug. */
export const XDEBUG_VERSION = '3.5.3';

export interface CoveragePhpInfo {
  frankenphp: string;
  php: string;
  buildId: string;
  xdebug: string;
  binarySha256: string;
  dockerImage: string;
  dir: string;
  createdAt: string;
}

interface Options {
  /** FrankenPHP release, for example "1.12.4". Default: the version in echowp's download cache. */
  frankenphp?: string;
  xdebug?: string;
  /** Build again, also when the folder exists. */
  force?: boolean;
  onLine?: (line: string) => void;
  /** Stops the build: the download, the commands and the Docker container. */
  signal?: AbortSignal;
}

/** Docker containers of builds that run now. The exit of this process kills them. */
const containers = new Set<string>();

function dockerKill(name: string) {
  const [c, a] = SETPRIV ? [SETPRIV, ['--no-new-privs', '--', 'docker', 'kill', name]] : ['docker', ['kill', name]];
  spawnSync(c, a, { env: childEnv(), stdio: 'ignore', timeout: 15_000 });
}

// The docker client does not stop its container when it stops. So kill the containers here,
// also when the server stops (sync.ts calls process.exit on SIGINT, SIGTERM and SIGHUP).
process.on('exit', () => {
  for (const name of containers) dockerKill(name);
});

/**
 * Runs a command the safe way: no terminal (own session), no new privileges, no-sudo stubs first
 * in PATH. It does not block, so the app stays usable during a long Docker build.
 * Fails with an error that has .stderr when the exit code is not 0.
 */
function sh(cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal; container?: string } = {}): Promise<string> {
  if (!SETPRIV) throw new Error('setpriv is missing. The tracker runs these commands only with "setpriv --no-new-privs", so that they cannot ask for a password.');
  if (o.signal?.aborted) return Promise.reject(new Error('Cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(SETPRIV!, ['--no-new-privs', '--', cmd, ...args], { env: o.env ?? childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (o.container) containers.add(o.container);
    let out = '';
    let err = '';
    let stopped = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err = (err + b).slice(-100_000)));
    const stop = (why: string) => {
      stopped ||= why;
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {}
      if (o.container) dockerKill(o.container);
    };
    const timer = o.timeout ? setTimeout(() => stop(`timeout after ${Math.round(o.timeout! / 60_000)} minutes`), o.timeout) : null;
    const onAbort = () => stop('Cancelled');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (o.container) containers.delete(o.container);
      if (stopped === 'Cancelled') return reject(new Error('Cancelled'));
      if (code === 0) return resolve(out);
      reject(Object.assign(new Error(`${cmd} ended with ${stopped || code || signal}: ${err.trim().slice(-500)}`), { stderr: err }));
    });
  });
}

/** The FrankenPHP version that echowp uses: the newest folder in its download cache. */
function echowpFrankenVersion(): string | null {
  const home = process.env.ECHOWP_HOME || path.join(os.homedir(), '.echowp');
  const base = path.join(home, 'bin', 'frankenphp');
  const found: string[] = [];
  // Only folders: the cache can also have files, such as a lock or a partial download.
  for (const series of fs.existsSync(base) ? fs.readdirSync(base, { withFileTypes: true }) : []) {
    if (!series.isDirectory()) continue;
    for (const v of fs.readdirSync(path.join(base, series.name), { withFileTypes: true })) if (v.isDirectory() && /^\d+\.\d+\.\d+$/.test(v.name)) found.push(v.name);
  }
  const num = (v: string) => v.split('.').map(Number);
  found.sort((x, y) => {
    const [a, b] = [num(x), num(y)];
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  return found.at(-1) ?? null;
}

function gnuAssetName(): string {
  if (process.platform !== 'linux') throw new Error('Coverage PHP works only on Linux: the Xdebug file is built in a Linux Docker image.');
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch as string];
  if (!arch) throw new Error(`No FrankenPHP "-gnu" binary for ${process.arch}.`);
  return `frankenphp-linux-${arch}-gnu`;
}

async function download(version: string, asset: string, dest: string, log: (l: string) => void, signal?: AbortSignal) {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'automation-tracker' };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const rel = await fetch(`https://api.github.com/repos/php/frankenphp/releases/tags/v${version}`, { headers, signal });
  if (!rel.ok) throw new Error(`FrankenPHP release v${version}: HTTP ${rel.status}.`);
  const a = ((await rel.json()) as any).assets?.find((x: any) => x.name === asset);
  if (!a) throw new Error(`FrankenPHP v${version} has no file ${asset}.`);
  const want = String(a.digest ?? '').replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error(`GitHub gives no sha256 for ${asset}, so the download cannot be checked.`);
  log(`Download ${asset} (${Math.round(a.size / 1e6)} MB)…`);
  const res = await fetch(a.browser_download_url, { headers: { 'user-agent': 'automation-tracker' }, signal });
  if (!res.ok) throw new Error(`Download of ${asset}: HTTP ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error(`The sha256 of ${asset} is ${got}, not ${want}. The file was not saved.`);
  fs.writeFileSync(dest, buf, { mode: 0o755 });
  return got;
}

/** The PHP version and build ID of a FrankenPHP binary, with optional PHP settings. */
async function probe(bin: string, iniDir?: string): Promise<{ php: string; buildId: string; xdebug: string | null }> {
  const env = childEnv(iniDir ? { PHP_INI_SCAN_DIR: iniDir } : {});
  if (!iniDir) delete env.PHP_INI_SCAN_DIR;
  // FrankenPHP's php-cli prints phpinfo as HTML; other PHPs print text with "=>".
  const code = `ob_start(); phpinfo(INFO_GENERAL); preg_match('/PHP Extension Build\\s*(?:=>)?\\s*(API\\S+)/', strip_tags(ob_get_clean()), $m);
echo json_encode(['php' => PHP_VERSION, 'buildId' => $m[1] ?? '', 'xdebug' => phpversion('xdebug') ?: null]);`;
  const out = await sh(bin, ['php-cli', '-r', code], { env });
  return JSON.parse(out.trim().split('\n').pop()!);
}

/** Builds xdebug.so in the official PHP image that matches the binary, and copies it to dest. */
async function buildXdebug(php: string, buildId: string, xdebug: string, dest: string, log: (l: string) => void, signal?: AbortSignal): Promise<string> {
  const image = `php:${php}-zts-trixie`;
  log(`Build Xdebug ${xdebug} in ${image} (about 1 minute)…`);
  const out = path.dirname(dest);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  // The image must make add-ons for the same PHP: the same build ID. pecl needs root in the
  // container, so the file is given to the user at the end.
  const script = [
    'set -e',
    `id=$(php -i | sed -n 's/^PHP Extension Build => //p')`,
    `[ "$id" = "${buildId}" ] || { echo "The image has build ID $id, the binary has ${buildId}." >&2; exit 3; }`,
    `pecl install xdebug-${xdebug} > /tmp/pecl.log 2>&1 || { tail -30 /tmp/pecl.log >&2; exit 4; }`,
    `cp "$(php-config --extension-dir)/xdebug.so" /out/xdebug.so.new`,
    `chown ${uid}:${gid} /out/xdebug.so.new`,
  ].join('\n');
  try {
    // A name, so that a cancel or the timeout can kill the container. --init: the container's
    // first process then stops on a signal (a plain "sh" as process 1 does not).
    const container = `atcov-xdebug-${process.pid}-${Date.now()}`;
    await sh('docker', ['run', '--rm', '--init', '--name', container, '-v', `${out}:/out`, image, 'sh', '-c', script], { timeout: 15 * 60_000, signal, container });
  } catch (e: any) {
    if (e.message === 'Cancelled') throw e;
    throw new Error(`The Xdebug build failed: ${String(e.stderr || e.message).trim().slice(-2000)}`);
  }
  fs.renameSync(path.join(out, 'xdebug.so.new'), dest);
  return image;
}

function iniText(xdebugSo: string): string {
  return [
    '; Written by "npm run project -- coverage-php". Loads Xdebug and the tracker\'s coverage recorder.',
    `zend_extension=${xdebugSo}`,
    'xdebug.mode=coverage',
    `auto_prepend_file=${path.join(ROOT, 'coverage', 'prepend.php')}`,
    // coverage/prepend.php records with OPcache on (2.2 times faster than off). The optimizer
    // can merge or remove lines (constant arrays, call arguments), so turn it off. OPcache still
    // keeps the compiled files. Check the file times on each request: a sync changes the plugin files.
    'opcache.optimization_level=0',
    'opcache.validate_timestamps=1',
    'opcache.revalidate_freq=0',
    // A new echowp site has the plugin as a link to the tracker's copy. The Cypress job then puts a
    // real copy at the same path. Without this, OPcache kept the code it found through the link
    // (in the tracker's copy) until the server restarted, and the site recorded no plugin lines.
    'opcache.revalidate_path=1',
    '',
  ].join('\n');
}

/**
 * Writes the ini of an existing coverage PHP again when this version of the tracker writes other
 * settings. A PHP server that runs now keeps the old settings until all tracker sites stop.
 */
export function syncCoverageIni(info: CoveragePhpInfo): void {
  const file = path.join(info.dir, 'ini', 'coverage.ini');
  const want = iniText(path.join(info.dir, 'xdebug.so'));
  if (fs.existsSync(path.join(info.dir, 'xdebug.so')) && (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== want)) fs.writeFileSync(file, want);
}

/** Records the coverage of a small script with the binary and the ini folder. Throws when it is wrong. */
async function verify(bin: string, iniDir: string, tmp: string) {
  const testIni = path.join(tmp, 'ini');
  fs.mkdirSync(testIni, { recursive: true });
  // Only the Xdebug lines: the coverage recorder skips the command line anyway.
  const ini = fs.readFileSync(path.join(iniDir, 'coverage.ini'), 'utf8').split('\n').filter((l) => !l.startsWith('auto_prepend_file')).join('\n');
  fs.writeFileSync(path.join(testIni, 'coverage.ini'), ini);
  const script = path.join(tmp, 'check.php');
  fs.writeFileSync(
    script,
    `<?php
function f($x) {
    if ($x > 1) {
        return 'big';
    }
    return 'small';
}
xdebug_start_code_coverage(XDEBUG_CC_UNUSED | XDEBUG_CC_DEAD_CODE);
f(5);
$c = xdebug_get_code_coverage()[__FILE__];
xdebug_stop_code_coverage();
echo json_encode([$c[4] ?? null, $c[6] ?? null]);
`,
  );
  const env = childEnv({ PHP_INI_SCAN_DIR: testIni });
  const out = (await sh(bin, ['php-cli', script], { env })).trim();
  // Line 4 ran (1). Line 6 can run but did not (-1).
  if (out !== '[1,-1]') throw new Error(`Xdebug loaded, but the coverage check gave ${out}, not [1,-1].`);
}

/** Makes or reuses the coverage PHP. Returns its info. */
export async function prepareCoveragePhp(o: Options = {}): Promise<CoveragePhpInfo> {
  const log = o.onLine ?? (() => {});
  const signal = o.signal;
  const check = () => {
    if (signal?.aborted) throw new Error('Cancelled');
  };
  const frankenphp = o.frankenphp ?? echowpFrankenVersion();
  if (!frankenphp) throw new Error('echowp has no FrankenPHP in its download cache yet. Run "echowp up" once, or give --frankenphp <version>.');
  const xdebug = o.xdebug ?? XDEBUG_VERSION;
  const asset = gnuAssetName();
  const current = path.join(COVERAGE_PHP_DIR, 'current');
  fs.mkdirSync(COVERAGE_PHP_DIR, { recursive: true });

  // Reuse a finished folder for the same FrankenPHP and Xdebug.
  for (const name of fs.readdirSync(COVERAGE_PHP_DIR)) {
    const infoFile = path.join(COVERAGE_PHP_DIR, name, 'info.json');
    if (name === 'current' || !fs.existsSync(infoFile)) continue;
    const info = JSON.parse(fs.readFileSync(infoFile, 'utf8')) as CoveragePhpInfo;
    if (info.frankenphp === frankenphp && info.xdebug === xdebug && !o.force) {
      log(`Coverage PHP exists: ${info.dir} (FrankenPHP ${frankenphp}, PHP ${info.php}, Xdebug ${xdebug}).`);
      syncCoverageIni(info);
      setCurrent(current, name);
      return info;
    }
  }

  const tmp = fs.mkdtempSync(path.join(COVERAGE_PHP_DIR, '.build-'));
  fs.chmodSync(tmp, 0o755); // mkdtemp makes it owner-only
  try {
    fs.mkdirSync(path.join(tmp, 'bin'));
    const bin = path.join(tmp, 'bin', 'frankenphp');
    const sha = await download(frankenphp, asset, bin, log, signal).catch((e) => {
      throw signal?.aborted ? new Error('Cancelled') : e;
    });
    check();
    const p = await probe(bin);
    check();
    if (!/,TS$/.test(p.buildId)) throw new Error(`The binary has build ID "${p.buildId}". Xdebug needs a thread-safe (TS) PHP.`);
    log(`The binary has PHP ${p.php}, build ID ${p.buildId}.`);

    const so = path.join(tmp, 'xdebug.so');
    const image = await buildXdebug(p.php, p.buildId, xdebug, so, log, signal);
    check();

    const name = `frankenphp-${frankenphp}-php${p.php}-xdebug-${xdebug}`;
    const dir = path.join(COVERAGE_PHP_DIR, name);
    // Check with the Xdebug file in the build folder. Then write the ini for the final folder.
    fs.mkdirSync(path.join(tmp, 'ini'));
    fs.writeFileSync(path.join(tmp, 'ini', 'coverage.ini'), iniText(so));
    const loaded = await probe(bin, path.join(tmp, 'ini'));
    if (loaded.xdebug !== xdebug) throw new Error(`The binary did not load Xdebug ${xdebug} (it reports ${loaded.xdebug ?? 'no Xdebug'}).`);
    await verify(bin, path.join(tmp, 'ini'), path.join(tmp, 'check'));
    log('Check passed: Xdebug loads and records the correct lines.');
    fs.writeFileSync(path.join(tmp, 'ini', 'coverage.ini'), iniText(path.join(dir, 'xdebug.so')));
    fs.rmSync(path.join(tmp, 'check'), { recursive: true, force: true });

    const info: CoveragePhpInfo = { frankenphp, php: p.php, buildId: p.buildId, xdebug, binarySha256: sha, dockerImage: image, dir, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(tmp, 'info.json'), JSON.stringify(info, null, 1) + '\n');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    setCurrent(current, name);
    log(`Coverage PHP is ready: ${dir}`);
    return info;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function setCurrent(link: string, name: string) {
  const tmpLink = `${link}.new`;
  fs.rmSync(tmpLink, { force: true });
  fs.symlinkSync(name, tmpLink);
  fs.renameSync(tmpLink, link);
}

/** Checks the current coverage PHP again: it loads Xdebug and records the correct lines. */
export async function checkCoveragePhp(): Promise<CoveragePhpInfo> {
  const dir = path.join(COVERAGE_PHP_DIR, 'current');
  if (!fs.existsSync(path.join(dir, 'info.json'))) throw new Error('No coverage PHP yet. Run "npm run project -- coverage-php".');
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf8')) as CoveragePhpInfo;
  const bin = path.join(dir, 'bin', 'frankenphp');
  const loaded = await probe(bin, path.join(dir, 'ini'));
  if (loaded.xdebug !== info.xdebug) throw new Error(`The binary did not load Xdebug ${info.xdebug} (it reports ${loaded.xdebug ?? 'no Xdebug'}).`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-php-check-'));
  try {
    await verify(bin, path.join(dir, 'ini'), tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return info;
}
