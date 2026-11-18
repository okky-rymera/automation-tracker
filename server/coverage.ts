import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, type ProjectConfig } from './projects.ts';
import { db, json, now, tx } from './db.ts';
import { SCAN_TTL_MS } from './cache.ts';

/** One function from the analysis (coverage/analyze.py → report.json). */
interface ReportFunction {
  file: string;
  function: string;
  start: number;
  end: number;
  /** library, tested, setup, background, never, or unknown (file never loaded). */
  category: FunctionState;
  /** Runnable lines in the function, by line state. */
  lines: Record<LineState, number>;
  tests: string[]; // Playwright test IDs (from the run) that ran this function's feature lines
}

export type LineState = 'library' | 'tested' | 'setup' | 'background' | 'never';

export interface RunTest {
  id: string;
  title: string;
  /** Playwright project name (newer runs only). */
  project?: string;
  /** [file, ...describes, title] (newer runs only). */
  path?: string[];
  file: string;
  line: number;
  tags: string[];
  status: string;
}

interface Report {
  tests: RunTest[];
  functions: ReportFunction[];
  neverLoadedFiles: string[];
  unknownFiles?: string[];
}

/** Per file: runnable lines by state, plus all lines run by tests (library included). */
export type FileLines = Record<LineState | 'runByTests', number[]>;
type LinesByFile = Record<string, FileLines>;

export type FunctionState = LineState | 'unknown';

/**
 * Returns [file, ...describes, title] for a run test. Older runs only have the
 * joined title "project > file > ... > title"; then find the spec file part,
 * because a config without named projects has no project part.
 */
export function runTestPath(t: RunTest): string[] {
  if (t.path?.length) return t.path;
  const parts = t.title.split(' > ');
  const i = parts.findIndex((p) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(p) && t.file.endsWith(p));
  return i >= 0 ? parts.slice(i) : parts.slice(1);
}

/** True for tests of the Playwright "setup" project (site preparation, not a test). */
export const isSetupTest = (t: RunTest) => (t.project !== undefined ? t.project === 'setup' : t.title.startsWith('setup > '));

export interface CoverageData {
  label: string;
  tests: RunTest[];
  functionsByFile: Map<string, (ReportFunction & { state: FunctionState })[]>;
  lines: LinesByFile;
  neverLoaded: Set<string>;
  /** Never-loaded files whose runnable lines could not be counted. */
  unknown: Set<string>;
  /** Number of functions each run test ran. */
  functionsPerTest: Map<string, number>;
  /** All files the run knows (loaded, never loaded, or uncounted). A file added after the run is not in it. */
  files: Set<string>;
}

const cache = new Map<number, { importedAt: string; data: CoverageData }>();


export interface Freshness {
  runCommit: string | null;
  currentCommit: string | null;
  /** True when the line colors may point at the wrong lines. Null when it cannot be checked. */
  stale: boolean | null;
  /** Why: "run-dirty", "new-commit", "uncommitted", or "unchecked" (no run-info or git failed). */
  reasons: string[];
}

const freshCache = new Map<string, { at: number; value: Freshness | null }>();

/**
 * Compares the plugin commit saved with the run to the plugin now.
 * Line highlights are only exact when the code has not changed since the run.
 * Cached for 5 seconds, because it starts 2 git processes.
 */
export function runFreshness(project: ProjectConfig): Freshness | null {
  const hit = freshCache.get(project.id);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.value;
  const value = computeFreshness(project);
  freshCache.set(project.id, { at: Date.now(), value });
  return value;
}

function computeFreshness(project: ProjectConfig): Freshness | null {
  if (!project.coverageRunId) return null;
  importRun(project);
  const info = db.prepare('SELECT plugin_commit, plugin_dirty FROM coverage_runs WHERE id = ?').get(project.coverageRunId) as any;
  if (!info || info.plugin_commit === null) return { runCommit: null, currentCommit: null, stale: null, reasons: ['unchecked'] };
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', ['-C', project.path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const currentCommit = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain', '--untracked-files=no');
  if (currentCommit === null || status === null) {
    return { runCommit: info.plugin_commit, currentCommit: null, stale: null, reasons: ['unchecked'] };
  }
  const reasons: string[] = [];
  if (info.plugin_dirty) reasons.push('run-dirty');
  if (currentCommit !== info.plugin_commit) reasons.push('new-commit');
  if (status.length > 0) reasons.push('uncommitted');
  return { runCommit: info.plugin_commit, currentCommit, stale: reasons.length > 0, reasons };
}

/**
 * Copies a coverage run folder (written by analyze.py) into the database.
 * Runs again when report.json, lines.json or run-info.json changed since the last import.
 * A file that cannot be read keeps the data of the last import.
 */
const failedImport = new Map<number, string>();

export function importRun(project: ProjectConfig) {
  if (!project.coverageRunId || !project.coverageRun) return;
  const dir = path.resolve(ROOT, project.coverageRun);
  const reportFile = path.join(dir, 'report.json');
  const linesFile = path.join(dir, 'lines.json');
  const mtimeOf = (f: string) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0);
  // run-info.json is often written after analyze.py, so its change also starts a new import.
  const mtime = `${mtimeOf(reportFile)}:${mtimeOf(linesFile)}:${mtimeOf(path.join(dir, 'run-info.json'))}`;
  const row = db.prepare('SELECT source_mtime FROM coverage_runs WHERE id = ?').get(project.coverageRunId) as any;
  if (!row || row.source_mtime === mtime || failedImport.get(project.coverageRunId) === mtime || !fs.existsSync(reportFile)) return;

  let report: Report;
  let lines: LinesByFile;
  let info: { pluginCommit?: string; pluginDirty?: boolean } = {};
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    lines = fs.existsSync(linesFile) ? JSON.parse(fs.readFileSync(linesFile, 'utf8')) : {};
    const infoFile = path.join(dir, 'run-info.json');
    if (fs.existsSync(infoFile)) info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  } catch (e) {
    // Try again only after one of the files changes.
    failedImport.set(project.coverageRunId, mtime);
    console.warn(`Could not read coverage for ${project.id}: ${(e as Error).message}`);
    return;
  }

  const id = project.coverageRunId;
  tx(() => {
    for (const t of ['run_tests', 'run_files', 'run_functions']) db.prepare(`DELETE FROM ${t} WHERE run_id = ?`).run(id);
    const addTest = db.prepare('INSERT OR REPLACE INTO run_tests (run_id, id, data) VALUES (?, ?, ?)');
    for (const t of report.tests) addTest.run(id, t.id, JSON.stringify(t));
    const never = new Set(report.neverLoadedFiles ?? []);
    const unknown = new Set(report.unknownFiles ?? []);
    const addFile = db.prepare('INSERT INTO run_files (run_id, path, never_loaded, uncounted, lines) VALUES (?, ?, ?, ?, ?)');
    for (const f of new Set([...Object.keys(lines), ...never, ...unknown])) {
      addFile.run(id, f, never.has(f) ? 1 : 0, unknown.has(f) ? 1 : 0, lines[f] ? JSON.stringify(lines[f]) : null);
    }
    const addFn = db.prepare(
      'INSERT INTO run_functions (run_id, file, name, start_line, end_line, state, lines, tests) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const f of report.functions) {
      addFn.run(id, f.file, f.function, f.start, f.end, f.category, JSON.stringify(f.lines), JSON.stringify(f.tests));
    }
    db.prepare('UPDATE coverage_runs SET source_mtime = ?, imported_at = ?, plugin_commit = ?, plugin_dirty = ? WHERE id = ?').run(
      mtime, now(), info.pluginCommit ?? null, info.pluginDirty === undefined ? null : info.pluginDirty ? 1 : 0, id,
    );
  });
}

export function loadCoverage(project: ProjectConfig): CoverageData | null {
  if (!project.coverageRunId) return null;
  importRun(project);
  const id = project.coverageRunId;
  const run = db.prepare('SELECT imported_at FROM coverage_runs WHERE id = ?').get(id) as any;
  if (!run?.imported_at) return null;
  const hit = cache.get(id);
  // The label can change without a new import (npm run project -- set-run), so take it from the project each time.
  const label = project.coverageLabel ?? project.coverageRun ?? '';
  if (hit && hit.importedAt === run.imported_at) return hit.data.label === label ? hit.data : { ...hit.data, label };

  const functionsByFile = new Map<string, (ReportFunction & { state: FunctionState })[]>();
  const functionsPerTest = new Map<string, number>();
  for (const r of db.prepare('SELECT * FROM run_functions WHERE run_id = ? ORDER BY rowid').all(id) as any[]) {
    const f = {
      file: r.file, function: r.name, start: r.start_line, end: r.end_line,
      category: r.state, state: r.state, lines: json(r.lines), tests: json(r.tests) as string[],
    };
    const list = functionsByFile.get(f.file) ?? [];
    list.push(f);
    functionsByFile.set(f.file, list);
    for (const t of f.tests) functionsPerTest.set(t, (functionsPerTest.get(t) ?? 0) + 1);
  }
  const lines: LinesByFile = {};
  const neverLoaded = new Set<string>();
  const unknown = new Set<string>();
  for (const r of db.prepare('SELECT * FROM run_files WHERE run_id = ?').all(id) as any[]) {
    if (r.lines) lines[r.path] = json(r.lines);
    if (r.never_loaded) neverLoaded.add(r.path);
    if (r.uncounted) unknown.add(r.path);
  }
  const tests = (db.prepare('SELECT data FROM run_tests WHERE run_id = ? ORDER BY rowid').all(id) as any[]).map((r) => json(r.data) as RunTest);

  const data: CoverageData = {
    label,
    tests,
    functionsByFile,
    lines,
    neverLoaded,
    unknown,
    functionsPerTest,
    files: new Set([...Object.keys(lines), ...neverLoaded, ...unknown]),
  };
  cache.set(id, { importedAt: run.imported_at, data });
  return data;
}
