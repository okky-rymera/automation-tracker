import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, type Framework, type ProjectConfig, type RunRef } from './projects.ts';
import { db, json, now, tx } from './db.ts';
import { SCAN_TTL_MS } from './cache.ts';
import { isStale, marksByFile, marksVersion, repoLines } from './line-marks.ts';
import { decisionsVersion, libraryFunctions } from './code-decisions.ts';

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
 * markedLibrary, markedCovered: lines that a person's mark moved to "library" or "tested" (line-marks.ts).
 * A line that had that state already is not in these lists.
 */
export type FileLines = Record<LineState | 'runByTests', number[]> & { cypressOnly?: number[]; markedLibrary?: number[]; markedCovered?: number[] };
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

/** Coverage of one view, with the line marks of people (withMarks). Null when the project has no run for it. */
export function loadCoverage(project: ProjectConfig, view: View): CoverageData | null {
  const base = loadBase(project, view);
  return base && withMarks(project, view, base);
}

/** Coverage of one view as the runs saw it, without line marks. */
function loadBase(project: ProjectConfig, view: View): CoverageData | null {
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
 * Line counts and state of a function, from the states of the lines in it. Same rules as coverage/analyze.py.
 * st: line states of the file (undefined: the run has no lines of the file). cyOnly: the Cypress-only lines.
 */
function functionLines(f: { start: number; end: number }, st: Map<number, LineState> | undefined, cyOnly: Set<number>) {
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
  const state: FunctionState = !any
    ? st ? 'never' : 'unknown'
    : !feature ? 'library'
    : counts.tested ? 'tested'
    : counts.setup ? 'setup'
    : counts.background ? 'background'
    : 'never';
  return { counts, state, cypressOnly };
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
      const { counts, state, cypressOnly } = functionLines(f, st, cyOnly);
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

const markedCache = new Map<string, { key: string; base: CoverageData['lines']; data: CoverageData }>();

/**
 * The coverage data with the line marks of people. The cached base data does not change: files with
 * marks get new line lists, and the other files share the base lists.
 * Only a mark whose line text is the same now (not stale) counts, and only on a runnable line:
 *  - library: the line becomes "library". covered: it becomes "tested".
 *  - markedLibrary, markedCovered: the lines that a mark changed: a new state, or not Cypress-only now.
 *    A line that had that state already (for example a line that Playwright ran, marked "covered") is not
 *    in the list, so it stays in "run by tests" of the app and is not counted twice.
 *  - the marked lines count as run by tests. They are not Cypress-only now. A library mark counts too:
 *    "run by tests" includes library lines (they run on every request, so also in each test), and a
 *    library mark says that the line is such a line.
 *  - the functions with a changed line get new counts and a new state (functionLines).
 * Made again when a mark changes, a marked file changes, or the base data changes.
 */
function withMarks(project: ProjectConfig, view: View, base: CoverageData): CoverageData {
  const marks = marksByFile(project.id);
  // Library decisions on whole functions (code-decisions.ts) count as library marks on each runnable
  // line of the function. A person's mark on the same line wins.
  for (const [file, names] of libraryFunctions(project.id)) {
    const fl = base.lines[file];
    const fns = base.functionsByFile.get(file);
    if (!fl || !fns) continue;
    const texts = repoLines(project, file);
    if (!texts) continue;
    const runnable = [...stateMap(fl).keys()];
    const list = marks.get(file) ?? [];
    const have = new Set(list.map((m) => m.line));
    for (const f of fns) {
      if (!names.has(f.function)) continue;
      for (const n of runnable) if (n >= f.start && n <= f.end && !have.has(n) && texts[n - 1] !== undefined) list.push({ file, line: n, kind: 'library', text: texts[n - 1] });
    }
    if (list.length) marks.set(file, list);
  }
  if (!marks.size) return base;
  const mtime = (f: string) => {
    try {
      return fs.statSync(path.join(project.path, f)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const key = `${marksVersion()}|${decisionsVersion()}|${[...marks.keys()].map((f) => `${f}:${mtime(f)}`).join('|')}`;
  const cacheKey = `${project.id}:${view}`;
  const hit = markedCache.get(cacheKey);
  // base.lines is the same object while the run is not imported again (a new label copies only the top object).
  if (hit && hit.key === key && hit.base === base.lines) return hit.data.label === base.label ? hit.data : { ...hit.data, label: base.label };

  const lines: CoverageData['lines'] = { ...base.lines };
  const functionsByFile = new Map(base.functionsByFile);
  let any = false;
  for (const [file, list] of marks) {
    const fl = base.lines[file];
    if (!fl) continue;
    const texts = repoLines(project, file);
    const st = stateMap(fl);
    const library: number[] = [];
    const covered: number[] = [];
    // marked: all lines with a mark that counts.
    const marked = new Set<number>();
    // changed: lines whose state or Cypress-only mark changed. Only their functions get new counts.
    const changed = new Set<number>();
    const cyBefore = new Set(fl.cypressOnly ?? []);
    for (const m of list) {
      const was = st.get(m.line);
      if (was === undefined || isStale(m, texts)) continue; // not runnable, or the line changed
      const to: LineState = m.kind === 'library' ? 'library' : 'tested';
      st.set(m.line, to);
      marked.add(m.line);
      // A Cypress-only line is not Cypress-only after the mark, so the mark changes it too.
      if (was !== to || cyBefore.has(m.line)) {
        changed.add(m.line);
        (m.kind === 'library' ? library : covered).push(m.line);
      }
    }
    if (!marked.size) continue;
    any = true;
    const out: FileLines = { library: [], tested: [], setup: [], background: [], never: [], runByTests: [] };
    for (const n of [...st.keys()].sort((x, y) => x - y)) out[st.get(n)!].push(n);
    out.runByTests = [...new Set([...(fl.runByTests ?? []), ...marked])].sort((x, y) => x - y);
    if (fl.cypressOnly) out.cypressOnly = fl.cypressOnly.filter((n) => !marked.has(n));
    out.markedLibrary = library.sort((x, y) => x - y);
    out.markedCovered = covered.sort((x, y) => x - y);
    lines[file] = out;
    const cyOnly = new Set(out.cypressOnly ?? []);
    const fns = base.functionsByFile.get(file);
    if (fns) {
      functionsByFile.set(
        file,
        fns.map((f) => {
          if (![...changed].some((n) => n >= f.start && n <= f.end)) return f;
          const r = functionLines(f, st, cyOnly);
          return { ...f, category: r.state, state: r.state, lines: r.counts, ...(f.cypressOnly !== undefined ? { cypressOnly: r.cypressOnly } : {}) };
        }),
      );
    }
  }
  const data = any ? { ...base, lines, functionsByFile } : base;
  markedCache.set(cacheKey, { key, base: base.lines, data });
  return data;
}
