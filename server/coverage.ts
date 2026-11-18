import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, type Framework, type ProjectConfig, type RunRef } from './projects.ts';
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
  tests: string[]; // test IDs (from the run) that ran this function's feature lines
}

export type LineState = 'library' | 'tested' | 'setup' | 'background' | 'never';

export interface RunTest {
  id: string;
  /** Test tool of the run this test came from. */
  framework?: Framework;
  title: string;
  /** Playwright project name (newer runs only). "cypress" for Cypress runs. */
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

/**
 * Per file: runnable lines by state, plus all lines run by tests (library included).
 * cypressOnly (the "both" view only): "tested" lines that only Cypress tests ran.
 */
export type FileLines = Record<LineState | 'runByTests', number[]> & { cypressOnly?: number[] };
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

/** Which coverage the app shows: one test tool, or both runs together. */
export type View = Framework | 'both';

export interface CoverageData {
  view: View;
  label: string;
  tests: RunTest[];
  /** cypressOnly (the "both" view only): feature lines of the function that only Cypress tests ran. */
  functionsByFile: Map<string, (ReportFunction & { state: FunctionState; cypressOnly?: number })[]>;
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
const bothCache = new Map<string, { key: string; data: CoverageData }>();


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
export function runFreshness(project: ProjectConfig, framework: Framework): Freshness | null {
  const key = `${project.id}:${framework}`;
  const hit = freshCache.get(key);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.value;
  const value = computeFreshness(project, framework);
  freshCache.set(key, { at: Date.now(), value });
  return value;
}

function computeFreshness(project: ProjectConfig, framework: Framework): Freshness | null {
  const run = project.runs[framework];
  if (!run) return null;
  importRun(project, run);
  const info = db.prepare('SELECT plugin_commit, plugin_dirty FROM coverage_runs WHERE id = ?').get(run.id) as any;
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

export function importRun(project: ProjectConfig, run: RunRef) {
  const dir = path.resolve(ROOT, run.dir);
  const reportFile = path.join(dir, 'report.json');
  const linesFile = path.join(dir, 'lines.json');
  const mtimeOf = (f: string) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0);
  // run-info.json is often written after analyze.py, so its change also starts a new import.
  const mtime = `${mtimeOf(reportFile)}:${mtimeOf(linesFile)}:${mtimeOf(path.join(dir, 'run-info.json'))}`;
  const row = db.prepare('SELECT source_mtime FROM coverage_runs WHERE id = ?').get(run.id) as any;
  if (!row || row.source_mtime === mtime || failedImport.get(run.id) === mtime || !fs.existsSync(reportFile)) return;

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
    failedImport.set(run.id, mtime);
    console.warn(`Could not read coverage for ${project.id} (${run.dir}): ${(e as Error).message}`);
    return;
  }

  const id = run.id;
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

/**
 * The views the app can show: one per run that loaded, and "both" when both loaded.
 * A selected run whose folder cannot be read (no report.json) gives no view.
 */
export function availableViews(project: ProjectConfig): View[] {
  const has = (fw: Framework) => !!project.runs[fw] && !!loadRun(project, project.runs[fw]!, fw);
  const pw = has('playwright');
  const cy = has('cypress');
  return [...(pw ? ['playwright' as const] : []), ...(cy ? ['cypress' as const] : []), ...(pw && cy ? ['both' as const] : [])];
}

/** The asked view when the project has it. Else "both" when it has both runs, else the run it has. */
export function resolveView(project: ProjectConfig, asked: unknown): View | null {
  const views = availableViews(project);
  if (views.includes(asked as View)) return asked as View;
  return views.includes('both') ? 'both' : (views[0] ?? null);
}

/** Coverage of one view. Null when the project has no run for it. */
export function loadCoverage(project: ProjectConfig, view: View): CoverageData | null {
  if (view !== 'both') {
    const run = project.runs[view];
    return run ? loadRun(project, run, view) : null;
  }
  const pw = project.runs.playwright && loadRun(project, project.runs.playwright, 'playwright');
  const cy = project.runs.cypress && loadRun(project, project.runs.cypress, 'cypress');
  if (!pw || !cy) return pw || cy || null;
  // Merged again only when one of the runs was imported again.
  const stamp = (r: RunRef, d: CoverageData) => `${r.id}:${cache.get(r.id)?.importedAt}:${d.label}`;
  const key = `${stamp(project.runs.playwright!, pw)}|${stamp(project.runs.cypress!, cy)}`;
  const hit = bothCache.get(project.id);
  if (hit && hit.key === key) return hit.data;
  const data = mergeRuns(pw, cy);
  bothCache.set(project.id, { key, data });
  return data;
}

function loadRun(project: ProjectConfig, run: RunRef, framework: Framework): CoverageData | null {
  importRun(project, run);
  const id = run.id;
  const row = db.prepare('SELECT imported_at FROM coverage_runs WHERE id = ?').get(id) as any;
  if (!row?.imported_at) return null;
  const hit = cache.get(id);
  // The label can change without a new import (npm run project -- set-run), so take it from the project each time.
  const label = run.label ?? run.dir;
  if (hit && hit.importedAt === row.imported_at) return hit.data.label === label ? hit.data : { ...hit.data, label };

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
  const tests = (db.prepare('SELECT data FROM run_tests WHERE run_id = ? ORDER BY rowid').all(id) as any[]).map(
    (r) => ({ framework, ...json(r.data) }) as RunTest,
  );

  const data: CoverageData = {
    view: framework,
    label,
    tests,
    functionsByFile,
    lines,
    neverLoaded,
    unknown,
    functionsPerTest,
    files: new Set([...Object.keys(lines), ...neverLoaded, ...unknown]),
  };
  cache.set(id, { importedAt: row.imported_at, data });
  return data;
}

const STATES: LineState[] = ['library', 'tested', 'setup', 'background', 'never'];
/** For a line in both runs, the state that says the most wins. */
const RANK: Record<LineState, number> = { library: 4, tested: 3, setup: 2, background: 1, never: 0 };

function stateMap(fl: FileLines | undefined): Map<number, LineState> {
  const m = new Map<number, LineState>();
  if (fl) for (const s of STATES) for (const n of fl[s] ?? []) m.set(n, s);
  return m;
}

/**
 * Puts the Playwright run and the Cypress run together, line by line.
 * - library in either run: library (the two baselines can differ a little)
 * - else the state that says the most: tested, then setup, then background, then never
 * - cypressOnly: tested lines that the Playwright tests did not run
 * Line numbers only match when both runs used the same plugin code (see runFreshness).
 */
function mergeRuns(pw: CoverageData, cy: CoverageData): CoverageData {
  const lines: LinesByFile = {};
  const merged = new Map<string, Map<number, LineState>>();
  for (const file of new Set([...Object.keys(pw.lines), ...Object.keys(cy.lines)])) {
    const a = stateMap(pw.lines[file]);
    const b = stateMap(cy.lines[file]);
    const m = new Map<number, LineState>();
    const out: FileLines = { library: [], tested: [], setup: [], background: [], never: [], runByTests: [], cypressOnly: [] };
    for (const n of [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y)) {
      const sa = a.get(n);
      const sb = b.get(n);
      const st = sa === undefined ? sb! : sb === undefined ? sa : RANK[sa] >= RANK[sb] ? sa : sb;
      m.set(n, st);
      out[st].push(n);
      if (st === 'tested' && sa !== 'tested') out.cypressOnly!.push(n);
    }
    out.runByTests = [...new Set([...(pw.lines[file]?.runByTests ?? []), ...(cy.lines[file]?.runByTests ?? [])])].sort((x, y) => x - y);
    lines[file] = out;
    merged.set(file, m);
  }

  // A file is "never loaded" only when no run that knows it loaded it.
  const files = new Set([...pw.files, ...cy.files]);
  const notLoadedIn = (d: CoverageData, f: string) => !d.files.has(f) || d.neverLoaded.has(f);
  const neverLoaded = new Set([...files].filter((f) => notLoadedIn(pw, f) && notLoadedIn(cy, f)));
  const unknown = new Set([...files].filter((f) => (pw.unknown.has(f) || !pw.files.has(f)) && (cy.unknown.has(f) || !cy.files.has(f))));

  // Functions: the same function in both runs (file, name and first line) becomes one. Its state comes from the merged lines.
  const functionsByFile: CoverageData['functionsByFile'] = new Map();
  for (const file of new Set([...pw.functionsByFile.keys(), ...cy.functionsByFile.keys()])) {
    const byKey = new Map<string, ReportFunction>();
    for (const f of [...(pw.functionsByFile.get(file) ?? []), ...(cy.functionsByFile.get(file) ?? [])]) {
      const k = `${f.function}:${f.start}`;
      const have = byKey.get(k);
      byKey.set(k, have ? { ...have, tests: [...new Set([...have.tests, ...f.tests])] } : { ...f });
    }
    const st = merged.get(file);
    const cyOnly = new Set(lines[file]?.cypressOnly ?? []);
    const list = [...byKey.values()].map((f) => {
      const counts: Record<LineState, number> = { library: 0, tested: 0, setup: 0, background: 0, never: 0 };
      let feature = 0;
      let cypressOnly = 0;
      for (let n = f.start; n <= f.end; n++) {
        const s = st?.get(n);
        if (!s) continue;
        counts[s]++;
        if (s !== 'library') feature++;
        if (cyOnly.has(n)) cypressOnly++;
      }
      const any = STATES.some((s) => counts[s] > 0);
      // Same rules as coverage/analyze.py.
      const state: FunctionState = !any
        ? st ? 'never' : 'unknown'
        : !feature ? 'library'
        : counts.tested ? 'tested'
        : counts.setup ? 'setup'
        : counts.background ? 'background'
        : 'never';
      return { ...f, category: state, state, lines: counts, cypressOnly };
    });
    functionsByFile.set(file, list.sort((x, y) => x.start - y.start));
  }

  return {
    view: 'both',
    label: `${pw.label} + ${cy.label}`,
    tests: [...pw.tests, ...cy.tests],
    functionsByFile,
    lines,
    neverLoaded,
    unknown,
    functionsPerTest: new Map([...pw.functionsPerTest, ...cy.functionsPerTest]),
    files,
  };
}
