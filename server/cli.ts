/**
 * Command line changes to the projects in the database.
 *
 *   npm run project -- add <id> <name> <plugin path> [--playwright <dir>] [--cypress <dir>]
 *   npm run project -- set-run <id> <run folder> [label] [--framework playwright|cypress]
 *   npm run project -- list
 */
import path from 'node:path';
import { db } from './db.ts';
import { addCoverageRun, FRAMEWORKS, importProjectsJson, loadProjects, ROOT, RUN_COLUMN, type Framework } from './projects.ts';

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
  const framework = (opt('framework') ?? 'playwright') as Framework;
  const [id, dir, label] = args;
  if (!id || !dir || !FRAMEWORKS.includes(framework)) throw new Error('Usage: set-run <id> <run folder> [label] [--framework playwright|cypress]');
  const rel = path.relative(ROOT, path.resolve(dir));
  const runId = addCoverageRun(id, rel, framework, label);
  db.prepare(`UPDATE projects SET ${RUN_COLUMN[framework]} = ? WHERE id = ?`).run(runId, id);
  console.log(`Project ${id} now shows ${framework} coverage run ${rel}. The app imports it on the next page load.`);
} else if (cmd === 'list') {
  for (const p of loadProjects()) {
    const runs = FRAMEWORKS.map((f) => `${f}: ${p.runs[f]?.dir ?? '(no run)'}`).join('\t');
    console.log(`${p.id}\t${p.name}\t${p.path}\t${runs}`);
  }
} else {
  console.log('Commands: add, set-run, list. See server/cli.ts.');
}
