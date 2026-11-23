import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, json, tx } from './db.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');

export type Framework = 'playwright' | 'cypress';
export const FRAMEWORKS: Framework[] = ['playwright', 'cypress'];

/** A coverage run selected for one test tool. */
export interface RunRef {
  /** Database ID of the run. */
  id: number;
  /** Run folder (holds report.json and lines.json), relative to this tool. */
  dir: string;
  /** Text shown in the UI that says where the coverage numbers come from. */
  label?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  /** Absolute path to the plugin repo. */
  path: string;
  /** Playwright specs folder, relative to the repo. */
  playwrightDir?: string;
  /** Cypress .feature folder, relative to the repo. */
  cypressDir?: string;
  /** The coverage run of each test tool that has one. */
  runs: Partial<Record<Framework, RunRef>>;
  /** Folders to leave out of the file list (folder names, at any depth). */
  excludeDirs?: string[];
  /** The remote branch that a sync gets. Unset: sync is off (only the tracker's own copy may sync). */
  syncBranch?: string;
  /** The local test site that the sync's test run uses. */
  siteUrl?: string;
  /** The commit and time of the last sync that got the code. */
  syncedCommit?: string;
  syncedAt?: string;
}

type Row = Record<string, any>;

const fromRow = (r: Row): ProjectConfig => ({
  id: r.id,
  name: r.name,
  path: r.path,
  playwrightDir: r.playwright_dir ?? undefined,
  cypressDir: r.cypress_dir ?? undefined,
  excludeDirs: r.exclude_dirs ? json(r.exclude_dirs) : undefined,
  syncBranch: r.sync_branch ?? undefined,
  siteUrl: r.site_url ?? undefined,
  syncedCommit: r.synced_commit ?? undefined,
  syncedAt: r.synced_at ?? undefined,
  runs: {
    ...(r.pw_id ? { playwright: { id: r.pw_id, dir: r.pw_dir, label: r.pw_label ?? undefined } } : {}),
    ...(r.cy_id ? { cypress: { id: r.cy_id, dir: r.cy_dir, label: r.cy_label ?? undefined } } : {}),
  },
});

const SELECT = `SELECT p.*, pr.id AS pw_id, pr.dir AS pw_dir, pr.label AS pw_label, cr.id AS cy_id, cr.dir AS cy_dir, cr.label AS cy_label
  FROM projects p
  LEFT JOIN coverage_runs pr ON pr.id = p.coverage_run_id
  LEFT JOIN coverage_runs cr ON cr.id = p.cypress_run_id`;

/** Column in projects that holds the selected run of each test tool. */
export const RUN_COLUMN: Record<Framework, string> = { playwright: 'coverage_run_id', cypress: 'cypress_run_id' };

export function loadProjects(): ProjectConfig[] {
  return (db.prepare(`${SELECT} ORDER BY p.name`).all() as Row[]).map(fromRow);
}

export function getProject(id: string): ProjectConfig | undefined {
  const r = db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
  return r ? fromRow(r) : undefined;
}

/**
 * Adds a coverage run folder to a project (or finds it) and returns its ID.
 * A run folder holds the run of one test tool, so a folder of the other tool is refused.
 */
export function addCoverageRun(projectId: string, dir: string, framework: Framework, label?: string): number {
  const have = db.prepare('SELECT framework FROM coverage_runs WHERE project_id = ? AND dir = ?').get(projectId, dir) as Row | undefined;
  if (have && have.framework !== framework) {
    throw new Error(`The run folder ${dir} is the ${have.framework} run of ${projectId}. Make a separate run folder for each test tool.`);
  }
  db.prepare(`INSERT INTO coverage_runs (project_id, dir, framework, label) VALUES (?, ?, ?, ?)
    ON CONFLICT (project_id, dir) DO UPDATE SET label = COALESCE(excluded.label, label)`).run(projectId, dir, framework, label ?? null);
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
  type JsonProject = Omit<ProjectConfig, 'runs'> & { coverageRun?: string; coverageLabel?: string; cypressRun?: string; cypressLabel?: string };
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonProject[];
  tx(() => {
    for (const p of list) {
      db.prepare('INSERT INTO projects (id, name, path, playwright_dir, cypress_dir, exclude_dirs) VALUES (?, ?, ?, ?, ?, ?)').run(
        p.id, p.name, p.path, p.playwrightDir ?? null, p.cypressDir ?? null, p.excludeDirs ? JSON.stringify(p.excludeDirs) : null,
      );
      if (p.coverageRun) {
        const runId = addCoverageRun(p.id, p.coverageRun, 'playwright', p.coverageLabel);
        db.prepare('UPDATE projects SET coverage_run_id = ? WHERE id = ?').run(runId, p.id);
      }
      if (p.cypressRun) {
        // A bad Cypress run (the same folder as the Playwright run) must not stop the start: skip it and say why.
        try {
          const runId = addCoverageRun(p.id, p.cypressRun, 'cypress', p.cypressLabel);
          db.prepare('UPDATE projects SET cypress_run_id = ? WHERE id = ?').run(runId, p.id);
        } catch (e) {
          console.error(`projects.json, project "${p.id}": Cypress run not set. ${(e as Error).message}`);
        }
      }
    }
  });
  console.log(`Imported ${list.length} projects from projects.json into the database.`);
}

/**
 * Writes coverage/plugins.json: the folder names of the tracked plugins. coverage/prepend.php
 * records only these plugins, and finds each one in the site's wp-content/plugins.
 * So the tracker's copy of a repo must have the same folder name as the plugin.
 * The file is not in git, so the server and the project commands write it each time they start.
 * Writes only when the list changed. With log, prints the list.
 */
export function writeCoverageConfig(log = false) {
  const names = [...new Set(loadProjects().map((p) => path.basename(p.path)))].sort();
  const file = path.join(ROOT, 'coverage', 'plugins.json');
  const text = JSON.stringify(names, null, 2) + '\n';
  let old = '';
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {
    /* missing: write it */
  }
  if (old !== text) fs.writeFileSync(file, text);
  if (log || old !== text) console.log(`coverage/plugins.json: ${names.join(', ') || '(no plugins)'}`);
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

/** Repo-relative path of a test file (the tests table keeps it relative to the framework folder). */
/** One hash of the files' contents. A missing file counts as empty. The mapping loop (server/map.ts) saves it on each unit. */
export function hashFiles(p: ProjectConfig, files: string[]) {
  const h = crypto.createHash('sha1');
  for (const f of [...files].sort()) {
    const full = repoFile(p, f);
    h.update(f + '\0');
    if (full && fs.existsSync(full) && fs.statSync(full).isFile()) h.update(fs.readFileSync(full));
    h.update('\0');
  }
  return h.digest('hex');
}

export function testRepoPath(p: ProjectConfig, kind: 'playwright' | 'cypress', file: string) {
  const dir = kind === 'playwright' ? p.playwrightDir : p.cypressDir;
  return dir ? path.posix.join(dir, file) : file;
}

/**
 * Absolute path of a repo-relative file the skill may read: any file type, but
 * inside the repo and not hidden (.git, .env). The file can be missing.
 */
export function repoFile(p: ProjectConfig, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part.startsWith('.'))) return null;
  const root = path.resolve(p.path);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return null;
  try {
    const real = fs.realpathSync(full);
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) return null; // symlink that leaves the repo
  } catch {
    /* missing file: allowed, it hashes as empty */
  }
  return full;
}
