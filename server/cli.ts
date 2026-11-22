/**
 * Command line changes to the projects in the database.
 *
 *   npm run project -- add <id> <name> <plugin path> [--playwright <dir>] [--cypress <dir>]
 *   npm run project -- set-run <id> <run folder> [label] [--framework playwright|cypress]
 *   npm run project -- set-path <id> <plugin path> [--rename]
 *   npm run project -- coverage-config
 *   npm run project -- coverage-php [--frankenphp <version>] [--xdebug <version>] [--force] [--check]
 *   npm run project -- echowp <id> <echowp command> [options]   (the tracker's own echowp home, with coverage)
 *   npm run project -- list
 *   npm run project -- changes <id> <old commit> <new commit> [--json]
 *   npm run project -- set-sync <id> [--branch <branch>] [--off]
 *   npm run project -- sync <id> [--tests auto|always|never]
 *   npm run project -- ai-update <id> [--from <commit> --to <commit>] [--feature 1,2] [--model opus] [--budget 1] [--bare] [--no-apply]
 *     (no --from/--to: the commits of the last sync that saved a change report)
 *   npm run project -- map-loop <id> [--units 10] [--model opus]   (headless map-features, one unit after the other; stops at the plan limit)
 *   npm run project -- run-spec <id> <unit ref>   (one Playwright spec on the tracker echowp site-1; the site stays on)
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { changeReport, reportText } from './changes.ts';
import { childEnv, run, startSync, type Job, type TestMode } from './sync.ts';
import { pluginAdminLogin, runSpec, testRunLockHolder } from './test-run.ts';
import { MapLoopError, startMapLoop } from './map-loop.ts';
import { aiUpdate, DEFAULTS } from './ai-update.ts';
import { checkCoveragePhp, prepareCoveragePhp } from './coverage-php.ts';
import { realCopiesForProfile, trackerEchowp } from './echowp.ts';
import { addCoverageRun, FRAMEWORKS, importProjectsJson, loadProjects, ROOT, RUN_COLUMN, writeCoverageConfig, type Framework } from './projects.ts';

importProjectsJson();
writeCoverageConfig(); // coverage/prepend.php reads it; it is not in git

const [cmd, ...args] = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};

if (cmd === 'add') {
  const pw = opt('playwright');
  const cy = opt('cypress');
  const [id, name, dir] = args;
  if (!id || !name || !dir) throw new Error('Usage: add <id> <name> <plugin path> [--playwright <dir>] [--cypress <dir>]');
  db.prepare('INSERT INTO projects (id, name, path, playwright_dir, cypress_dir) VALUES (?, ?, ?, ?, ?)').run(id, name, path.resolve(dir), pw, cy);
  console.log(`Added project ${id}.`);
  console.log(`Coverage: the test site must have the plugin in wp-content/plugins/${path.basename(path.resolve(dir))} (a link to this folder is OK).`);
  writeCoverageConfig(true);
} else if (cmd === 'set-run') {
  const framework = (opt('framework') ?? 'playwright') as Framework;
  const [id, dir, label] = args;
  if (!id || !dir || !FRAMEWORKS.includes(framework)) throw new Error('Usage: set-run <id> <run folder> [label] [--framework playwright|cypress]');
  const rel = path.relative(ROOT, path.resolve(dir));
  const runId = addCoverageRun(id, rel, framework, label);
  db.prepare(`UPDATE projects SET ${RUN_COLUMN[framework]} = ? WHERE id = ?`).run(runId, id);
  console.log(`Project ${id} now shows ${framework} coverage run ${rel}. The app imports it on the next page load.`);
} else if (cmd === 'set-path') {
  // Point a project at another copy of the plugin repo, for example the tracker's own copy on trunk.
  const rename = args.includes('--rename');
  if (rename) args.splice(args.indexOf('--rename'), 1);
  const [id, dir] = args;
  if (!id || !dir) throw new Error('Usage: set-path <id> <plugin path> [--rename]');
  const full = path.resolve(dir);
  if (!fs.existsSync(path.join(full, '.git'))) throw new Error(`${full} is not a git repo.`);
  // The coverage recorder finds the plugin by its folder name in the site's wp-content/plugins.
  const old = loadProjects().find((p) => p.id === id);
  if (old && path.basename(old.path) !== path.basename(full) && !rename) {
    throw new Error(
      `The folder name changes from "${path.basename(old.path)}" to "${path.basename(full)}". ` +
        `The coverage recorder finds a plugin by its folder name in the site, so the new copy must have the old name. ` +
        `If the plugin folder in the site has the new name, run the command again with --rename.`,
    );
  }
  const res = db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(full, id);
  if (!res.changes) throw new Error(`No project ${id}.`);
  console.log(`Project ${id} now reads the plugin at ${full}. The next scan reads the tests and files there.`);
  writeCoverageConfig(true);
} else if (cmd === 'coverage-config') {
  writeCoverageConfig(true);
} else if (cmd === 'list') {
  for (const p of loadProjects()) {
    const runs = FRAMEWORKS.map((f) => `${f}: ${p.runs[f]?.dir ?? '(no run)'}`).join('\t');
    console.log(`${p.id}\t${p.name}\t${p.path}\t${runs}`);
  }
} else if (cmd === 'changes') {
  // The change report between two commits of the project's repo (the same report as a sync).
  const asJson = args.includes('--json');
  const [id, from, to] = args.filter((a) => a !== '--json');
  const p = loadProjects().find((x) => x.id === id);
  if (!p || !from || !to) throw new Error('Usage: changes <id> <old commit> <new commit> [--json]');
  const r = changeReport(p, from, to);
  console.log(asJson ? JSON.stringify(r, null, 1) : reportText(r));
} else if (cmd === 'set-sync') {
  // Turns the sync on or off. Sync changes the files of the copy (git merge --ff-only), so only for the tracker's own copy.
  // --site is gone: each test run starts its own echowp site. Stop, so that an old command does not look like it worked.
  if (args.some((a) => a === '--site' || a.startsWith('--site='))) {
    throw new Error('set-sync has no --site option now. Each test run starts its own echowp site. Run the command again without --site.');
  }
  const branch = opt('branch');
  const off = args.includes('--off');
  const [id] = args.filter((a) => a !== '--off');
  const p = loadProjects().find((x) => x.id === id);
  if (!p) throw new Error('Usage: set-sync <id> [--branch <branch>] [--off]');
  if (off) {
    db.prepare('UPDATE projects SET sync_branch = NULL WHERE id = ?').run(id);
    console.log(`Sync is off for ${id}.`);
  } else {
    const b = branch ?? p.syncBranch ?? 'trunk';
    db.prepare('UPDATE projects SET sync_branch = ? WHERE id = ?').run(b, id);
    console.log(`Sync is on for ${id}: branch ${b}, copy ${p.path}. Test runs start their own echowp site.`);
    console.log('The copy must be the tracker\'s own copy: a sync stops when it has changed files or own commits.');
  }
} else if (cmd === 'sync') {
  const tests = (opt('tests') ?? 'auto') as TestMode;
  const [id] = args;
  if (!id || !['auto', 'always', 'never'].includes(tests)) throw new Error('Usage: sync <id> [--tests auto|always|never]');
  const { syncId, done } = startSync(id, tests, (line) => console.log(line));
  console.log(`Sync ${syncId} of ${id} started.`);
  const r = await done;
  if (r.report) console.log(reportText(r.report));
  for (const [name, t] of [['Playwright', r.tests], ['Cypress', r.cypressTests]] as const) {
    if (t) console.log(`${name}: ${t.ran ? `${t.passed ?? 0} passed, ${t.failed ?? 0} failed, ${t.skipped ?? 0} skipped${t.selected ? ' (run selected)' : ` (run not used: ${t.reason})`}` : `not run (${t.reason})`}`);
  }
  console.log(`Sync ${syncId}: ${r.status}${r.error ? ' - ' + r.error : ''}`);
  if (r.status !== 'done') process.exitCode = 1;
} else if (cmd === 'ai-update') {
  // Headless Claude checks the features that a change marks for review (server/ai-update.ts).
  const from = opt('from');
  const to = opt('to');
  const features = (opt('feature') ?? '').split(',').map((x) => Number(x.replace(/^F-/i, ''))).filter(Boolean);
  const model = opt('model') ?? DEFAULTS.model;
  const budget = Number(opt('budget') ?? DEFAULTS.budgetUsd);
  const bare = args.includes('--bare');
  const noApply = args.includes('--no-apply');
  const [id] = args.filter((a) => !a.startsWith('--'));
  const p = loadProjects().find((x) => x.id === id);
  if (!p || !(budget > 0) || !!from !== !!to) throw new Error('Usage: ai-update <id> [--from <commit> --to <commit>] [--feature 1,2] [--model opus] [--budget 1] [--bare] [--no-apply]');
  let range = from && to ? { from, to, syncId: null as number | null } : null;
  if (!range) {
    const s = db.prepare('SELECT id, from_commit, to_commit FROM syncs WHERE project_id = ? AND report IS NOT NULL ORDER BY id DESC LIMIT 1').get(id) as any;
    if (!s) throw new Error(`No sync of ${id} with a change report. Give --from and --to.`);
    range = { from: s.from_commit, to: s.to_commit, syncId: s.id };
  }
  const rows = await aiUpdate(p, { ...range, features, model, budgetUsd: budget, auth: bare ? 'bare' : 'login', apply: !noApply, onLine: (l) => console.log(l) });
  const total = rows.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  console.log(`${rows.length} features checked, $${total.toFixed(2)} in total.`);
  for (const r of rows) for (const line of r.applyReport ?? []) console.log(`  F-${r.featureId}: ${line}`);
  if (rows.some((r) => r.status === 'failed')) process.exitCode = 1;
} else if (cmd === 'coverage-php') {
  // FrankenPHP "-gnu" binary + Xdebug for echowp sites (server/coverage-php.ts).
  if (args.includes('--check')) {
    const info = await checkCoveragePhp();
    console.log(`Coverage PHP works: FrankenPHP ${info.frankenphp}, PHP ${info.php}, Xdebug ${info.xdebug}.`);
  } else {
    const frankenphp = opt('frankenphp') ?? undefined;
    const xdebug = opt('xdebug') ?? undefined;
    const info = await prepareCoveragePhp({ frankenphp, xdebug, force: args.includes('--force'), onLine: (l) => console.log(l) });
    console.log(`\nStart the sites with: npm run project -- echowp <id> up`);
    console.log(`The sites must use PHP ${info.php.split('.').slice(0, 2).join('.')} (or no php setting).`);
  }
} else if (cmd === 'echowp') {
  // echowp for the tracker's copy of a project, in the tracker's own echowp home, with coverage (server/echowp.ts).
  const [id, ...rest] = args;
  const p = loadProjects().find((x) => x.id === id);
  if (!p || !rest.length) throw new Error('Usage: echowp <id> <echowp command> [echowp options], for example: echowp wwp up');
  // echowp sets the admin login when it makes a site. Use the login of the plugin's Playwright
  // tests, so the tests and playwright-cli can log in. A login in the environment wins.
  const env: Record<string, string> = {};
  if (rest[0] === 'up' && !process.env.ECHOWP_ADMIN_USER && !process.env.ECHOWP_ADMIN_PASSWORD) {
    const login = pluginAdminLogin(p);
    env.ECHOWP_ADMIN_USER = login.user;
    env.ECHOWP_ADMIN_PASSWORD = login.password;
  }
  process.exitCode = await trackerEchowp(p, rest, console.log, { env });
  // A site that a person or the AI starts by hand gets a real plugin copy too, never echowp's link:
  // a delete in WordPress follows the link and deletes the tracker's copy (server/echowp.ts).
  // Also after a failed "up": it can start some sites. Not while a test run holds the lock: the copy
  // deletes the site's plugin folder for a moment, under the running tests.
  if (rest[0] === 'up' || rest[0] === 'reset' || rest[0] === 'start') {
    const opts = rest.slice(0, rest.includes('--') ? rest.indexOf('--') : rest.length);
    const opt = (k: string) => {
      const i = opts.indexOf(`--${k}`);
      const eq = opts.find((x) => x.startsWith(`--${k}=`));
      return i >= 0 ? opts[i + 1] : eq ? eq.slice(k.length + 3) : undefined;
    };
    // Words of the command that can be site names: "reset site-1", or "up --name x --count 2" (x-1,
    // x-2). realCopiesForProfile keeps only the words that are real site names, so an option value
    // (for example "--wp 6.5") does no harm.
    const prefix = opt('name');
    const count = Number(opt('count'));
    const words = opts.slice(1).filter((x) => !x.startsWith('-'));
    const names = [...words, ...(prefix || count ? Array.from({ length: count || 1 }, (_, i) => `${prefix ?? 'site'}-${i + 1}`) : [])];
    const lock = testRunLockHolder();
    if (lock) console.log(`WARNING: a test run (process ${lock}) uses the tracker sites now, so the plugin copy step did not run. A site that "${rest[0]}" made new can still have echowp's link to the tracker's copy: do not delete the plugin in WordPress there. The next test run puts a real copy in.`);
    else await realCopiesForProfile(p, { profile: opt('profile'), config: opt('config'), names }, console.log);
  }
} else if (cmd === 'daily-sync') {
  // The daily sync now, of each project that is due (server/daily-sync.ts). The server does this by
  // itself; this command shows the due state, and syncs the due projects.
  const { dailySyncState, runDue } = await import('./daily-sync.ts');
  for (const d of dailySyncState().projects) console.log(`${d.project}: ${d.due ? 'due now' : `due at ${d.dueAt}`} (last sync ${d.lastSyncAt ?? 'never'})`);
  await runDue(console.log);
} else if (cmd === 'map-loop') {
  // Headless Claude maps one unit after the other with the map-features skill (server/map-loop.ts).
  const [id] = args;
  const p = loadProjects().find((x) => x.id === id);
  const usage = 'Usage: map-loop <id> [--units 10] [--model opus]';
  if (!p) throw new Error(usage);
  // The dollar limits are gone: the loop uses the claude.ai plan, and it stops at the plan limit.
  for (const gone of ['--budget', '--unit-budget']) {
    if (args.includes(gone)) {
      console.error(`${gone} is gone: the loop uses your Claude plan, and it stops at the 5-hour or weekly limit.\n${usage}`);
      process.exit(1);
    }
  }
  // A flag with no value (or a bad value) becomes NaN, and startMapLoop refuses it.
  const num = (k: string) => {
    if (!args.includes(`--${k}`)) return undefined;
    const v = opt(k);
    return v ? Number(v) : NaN;
  };
  let started: ReturnType<typeof startMapLoop>;
  try {
    started = startMapLoop(p, {
      model: opt('model') ?? undefined,
      maxUnits: num('units'),
      startedBy: 'cli',
      onLine: (l) => console.log(l),
    });
  } catch (e) {
    // A bad limit or a running job: a short message, not a stack trace.
    if (!(e instanceof MapLoopError)) throw e;
    console.error(`${e.message}\n${usage}`);
    process.exit(1);
  }
  const { done } = started;
  await done;
  const loop = db.prepare('SELECT * FROM map_loops WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(p.id) as any;
  for (const r of db.prepare('SELECT * FROM map_runs WHERE loop_id = ? ORDER BY id').all(loop.id) as any[]) {
    console.log(`\n=== ${r.unit_kind} ${r.unit_ref}: ${r.status}${r.cost_usd !== null ? `, $${r.cost_usd.toFixed(2)}` : ''}${r.error ? ` (${r.error})` : ''}\n${r.report}`);
  }
  if (loop.status === 'failed') process.exitCode = 1;
} else if (cmd === 'run-spec') {
  // One Playwright spec file on the tracker's echowp site-1, for the map-features skill (test-run.ts runSpec).
  // The site stays on after the run. Stop it with: npm run project -- echowp <id> stop site-1 --profile test (not "down": it deletes the sites)
  const [id, ref] = args;
  const p = loadProjects().find((x) => x.id === id);
  if (!p || !ref) throw new Error('Usage: run-spec <id> <unit ref>, for example: run-spec wwp backend/settings/x.spec.js');
  const job: Job = { syncId: 0, child: null, cancelled: false, abort: new AbortController() };
  // The commands run in their own process group. Stop them when this command stops (a timeout of the caller).
  const stop = () => {
    job.cancelled = true;
    job.abort.abort();
    for (const c of new Set([...(job.children ?? []), ...(job.child ? [job.child] : [])])) {
      try {
        if (c.pid) process.kill(-c.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };
  process.on('exit', stop);
  const r = await runSpec(p, ref, {
    run: (c, a, o) => run(job, c, a, o),
    env: (extra) => childEnv(extra),
    log: (l) => console.log(l),
    cancelled: () => job.cancelled,
    signal: job.abort.signal,
  });
  console.log(`\nPlaywright exit code: ${r.exit} (0 = all passed). The test site ${r.siteUrl} is still on.`);
  if (r.copyGone) console.log('WARNING: the site has no real plugin copy now (a test deleted or replaced the plugin). The tracker\'s copy was not touched. Run run-spec again to get a new copy.');
  process.exitCode = r.exit === 0 ? 0 : 1;
} else {
  console.log('Commands: add, set-run, set-path, coverage-config, coverage-php, echowp, list, changes, set-sync, sync, daily-sync, ai-update, map-loop, run-spec. See server/cli.ts.');
}
