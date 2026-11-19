/**
 * Command line changes to the projects in the database.
 *
 *   npm run project -- add <id> <name> <plugin path> [--playwright <dir>] [--cypress <dir>]
 *   npm run project -- set-run <id> <run folder> [label] [--framework playwright|cypress]
 *   npm run project -- set-path <id> <plugin path> [--rename]
 *   npm run project -- coverage-config
 *   npm run project -- list
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
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
} else {
  console.log('Commands: add, set-run, set-path, coverage-config, list. See server/cli.ts.');
}
