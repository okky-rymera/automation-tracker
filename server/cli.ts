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
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { changeReport, reportText } from './changes.ts';
import { startSync, type TestMode } from './sync.ts';
import { aiUpdate, DEFAULTS } from './ai-update.ts';
import { checkCoveragePhp, prepareCoveragePhp } from './coverage-php.ts';
import { trackerEchowp } from './echowp.ts';
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
  process.exitCode = await trackerEchowp(p, rest);
} else {
  console.log('Commands: add, set-run, set-path, coverage-config, coverage-php, echowp, list, changes, set-sync, sync, ai-update. See server/cli.ts.');
}
