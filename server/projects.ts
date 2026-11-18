import fs from 'node:fs';
import path from 'node:path';
import { db, json, tx } from './db.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');

export interface ProjectConfig {
  id: string;
  name: string;
  /** Absolute path to the plugin repo. */
  path: string;
  /** Playwright specs folder, relative to the repo. */
  playwrightDir?: string;
  /** Cypress .feature folder, relative to the repo. */
  cypressDir?: string;
  /** Database ID of the coverage run shown in the app. */
  coverageRunId?: number;
  /** Coverage run folder (holds report.json and lines.json), relative to this tool. */
  coverageRun?: string;
  /** Text shown in the UI that says where the coverage numbers come from. */
  coverageLabel?: string;
  /** Folders to leave out of the file list (folder names, at any depth). */
  excludeDirs?: string[];
}

type Row = Record<string, any>;

const fromRow = (r: Row): ProjectConfig => ({
  id: r.id,
  name: r.name,
  path: r.path,
  playwrightDir: r.playwright_dir ?? undefined,
  cypressDir: r.cypress_dir ?? undefined,
  excludeDirs: r.exclude_dirs ? json(r.exclude_dirs) : undefined,
  coverageRunId: r.run_id ?? undefined,
  coverageRun: r.run_dir ?? undefined,
  coverageLabel: r.run_label ?? undefined,
});

const SELECT = `SELECT p.*, r.id AS run_id, r.dir AS run_dir, r.label AS run_label
  FROM projects p LEFT JOIN coverage_runs r ON r.id = p.coverage_run_id`;

export function loadProjects(): ProjectConfig[] {
  return (db.prepare(`${SELECT} ORDER BY p.name`).all() as Row[]).map(fromRow);
}

export function getProject(id: string): ProjectConfig | undefined {
  const r = db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
  return r ? fromRow(r) : undefined;
}

/** Adds a coverage run folder to a project (or finds it) and returns its ID. */
export function addCoverageRun(projectId: string, dir: string, label?: string): number {
  db.prepare(`INSERT INTO coverage_runs (project_id, dir, label) VALUES (?, ?, ?)
    ON CONFLICT (project_id, dir) DO UPDATE SET label = COALESCE(excluded.label, label)`).run(projectId, dir, label ?? null);
  return (db.prepare('SELECT id FROM coverage_runs WHERE project_id = ? AND dir = ?').get(projectId, dir) as Row).id;
}

/**
 * One time only: copies projects.json into the database when the database has
 * no projects. After that the database is the only source of projects.
 */
export function importProjectsJson() {
  const file = path.join(ROOT, 'projects.json');
  const count = (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as Row).n;
  if (count > 0 || !fs.existsSync(file)) return;
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as (ProjectConfig & { coverageRun?: string })[];
  tx(() => {
    for (const p of list) {
      db.prepare('INSERT INTO projects (id, name, path, playwright_dir, cypress_dir, exclude_dirs) VALUES (?, ?, ?, ?, ?, ?)').run(
        p.id, p.name, p.path, p.playwrightDir ?? null, p.cypressDir ?? null, p.excludeDirs ? JSON.stringify(p.excludeDirs) : null,
      );
      if (p.coverageRun) {
        const runId = addCoverageRun(p.id, p.coverageRun, p.coverageLabel);
        db.prepare('UPDATE projects SET coverage_run_id = ? WHERE id = ?').run(runId, p.id);
      }
    }
  });
  console.log(`Imported ${list.length} projects from projects.json into the database.`);
}

/** Code file types: shown in the file list, and the only types the source view serves. */
export const SOURCE_EXT = new Set(['.php', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

/**
 * Resolves a repo-relative path to a source file the app may show.
 * Refuses: paths that leave the repo (also through symlinks), hidden parts such
 * as .git or .env, and files that are not source code.
 */
export function safeRepoPath(project: ProjectConfig, rel: string): string | null {
  if (!rel || rel.split(/[\\/]/).some((part) => part.startsWith('.'))) return null;
  if (!SOURCE_EXT.has(path.extname(rel).toLowerCase())) return null;
  let root: string;
  let full: string;
  try {
    root = fs.realpathSync(project.path);
    full = fs.realpathSync(path.resolve(project.path, rel));
  } catch {
    return null; // missing file
  }
  return full.startsWith(root + path.sep) && fs.statSync(full).isFile() ? full : null;
}
