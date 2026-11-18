/**
 * Command line changes to the projects in the database.
 *
 *   npm run project -- add <id> <name> <plugin path> [--playwright <dir>] [--cypress <dir>]
 *   npm run project -- set-run <id> <run folder> [label]
 *   npm run project -- list
 */
import path from 'node:path';
import { db } from './db.ts';
import { addCoverageRun, importProjectsJson, loadProjects, ROOT } from './projects.ts';

importProjectsJson();
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
} else if (cmd === 'set-run') {
  const [id, dir, label] = args;
  if (!id || !dir) throw new Error('Usage: set-run <id> <run folder> [label]');
  const rel = path.relative(ROOT, path.resolve(dir));
  const runId = addCoverageRun(id, rel, label);
  db.prepare('UPDATE projects SET coverage_run_id = ? WHERE id = ?').run(runId, id);
  console.log(`Project ${id} now shows coverage run ${rel}. The app imports it on the next page load.`);
} else if (cmd === 'list') {
  for (const p of loadProjects()) console.log(`${p.id}\t${p.name}\t${p.path}\t${p.coverageRun ?? '(no coverage run)'}`);
} else {
  console.log('Commands: add, set-run, list. See server/cli.ts.');
}
