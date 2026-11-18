/**
 * The plugin code of each feature ("mapped code"). The AI skill puts code in a feature:
 * a whole file, or one function by name. The app shows how much of that code the tests run.
 *
 * A function name can occur more than once in a file (closures, or a function that is
 * declared in two if-branches). An entry by name holds all of them.
 * One line can be in more than one feature, so feature totals are not added together:
 * the project totals count each line one time.
 */
import fs from 'node:fs';
import { db } from './db.ts';
import { loadCoverage, type CoverageData, type LineState, type View } from './coverage.ts';
import { safeRepoPath, type ProjectConfig } from './projects.ts';
import type { LineCounts } from './files.ts';

const STATES: LineState[] = ['library', 'tested', 'setup', 'background', 'never'];

export interface CodeRow {
  id: number;
  featureId: number;
  file: string;
  function: string;
  source: 'ai' | 'manual';
  checked: boolean;
}

export function codeRows(projectId: string, featureId?: number): CodeRow[] {
  const rows = db
    .prepare(
      `SELECT id, feature_id AS featureId, file, function, source, checked FROM feature_code
       WHERE project_id = ? AND removed = 0 ${featureId ? 'AND feature_id = ?' : ''} ORDER BY file, function`,
    )
    .all(...(featureId ? [projectId, featureId] : [projectId])) as any[];
  return rows.map((r) => ({ ...r, checked: !!r.checked }));
}

const zero = (): LineCounts => ({ runnable: 0, library: 0, tested: 0, setup: 0, background: 0, never: 0, runByTests: 0, cypressOnly: 0 });

/** Line numbers of an entry: all runnable lines of the file, or the lines of the functions with that name. Null: not in the code now. */
function entryLines(cov: CoverageData, file: string, fn: string): Set<number> | null {
  const fl = cov.lines[file];
  if (!fl) return null;
  const all = STATES.flatMap((s) => fl[s] ?? []);
  if (!fn) return new Set(all);
  const fns = (cov.functionsByFile.get(file) ?? []).filter((f) => f.function === fn);
  if (!fns.length) return null;
  return new Set(all.filter((n) => fns.some((f) => n >= f.start && n <= f.end)));
}

function count(cov: CoverageData, file: string, lines: Set<number>): LineCounts {
  const fl = cov.lines[file];
  const c = zero();
  for (const s of STATES) c[s] = (fl[s] ?? []).filter((n) => lines.has(n)).length;
  c.runnable = STATES.reduce((n, s) => n + c[s], 0);
  c.runByTests = (fl.runByTests ?? []).filter((n) => lines.has(n)).length;
  c.cypressOnly = (fl.cypressOnly ?? []).filter((n) => lines.has(n)).length;
  return c;
}

const add = (a: LineCounts, b: LineCounts) => {
  for (const k of Object.keys(a) as (keyof LineCounts)[]) a[k] += b[k];
};

/** Feature lines (not library) of the union of the given line sets by file. */
function unionCounts(cov: CoverageData, byFile: Map<string, Set<number>>): LineCounts {
  const c = zero();
  for (const [file, lines] of byFile) add(c, count(cov, file, lines));
  return c;
}

/**
 * Mapped code of every feature, with line counts in one coverage view.
 * Also the code in no feature: per file, the feature lines that no entry holds.
 */
export function featureCodeCoverage(p: ProjectConfig, view: View | null) {
  const cov = view && loadCoverage(p, view);
  const rows = codeRows(p.id);
  const byFeature = new Map<number, ReturnType<typeof entryOut>[]>();
  const featureLines = new Map<number, Map<string, Set<number>>>();
  const mapped = new Map<string, Set<number>>(); // all features together

  function entryOut(r: CodeRow) {
    const lines = cov ? entryLines(cov, r.file, r.function) : null;
    // Not in the code now: the file is gone, or the coverage run has no function with that name.
    const inRepo = !!safeRepoPath(p, r.file) && fs.existsSync(safeRepoPath(p, r.file)!);
    return { ...r, inRepo, measured: !!lines, lines: cov && lines ? count(cov, r.file, lines) : null, _set: lines };
  }

  for (const r of rows) {
    const e = entryOut(r);
    byFeature.set(r.featureId, [...(byFeature.get(r.featureId) ?? []), e]);
    if (!e._set) continue;
    const fl = featureLines.get(r.featureId) ?? new Map<string, Set<number>>();
    featureLines.set(r.featureId, fl);
    for (const m of [fl, mapped]) {
      const s = m.get(r.file) ?? new Set<number>();
      for (const n of e._set) s.add(n);
      m.set(r.file, s);
    }
  }

  const features = [...byFeature.entries()].map(([featureId, entries]) => ({
    featureId,
    lines: cov ? unionCounts(cov, featureLines.get(featureId) ?? new Map()) : null,
    entries: entries.map(({ _set, ...e }) => e),
  }));

  // Code in no feature: each measured PHP file with feature lines outside every entry.
  const unmapped: { file: string; lines: LineCounts }[] = [];
  if (cov) {
    for (const file of Object.keys(cov.lines)) {
      const fl = cov.lines[file];
      const taken = mapped.get(file) ?? new Set<number>();
      const rest = new Set(STATES.filter((s) => s !== 'library').flatMap((s) => (fl[s] ?? []).filter((n) => !taken.has(n))));
      if (!rest.size) continue;
      unmapped.push({ file, lines: count(cov, file, rest) });
    }
    unmapped.sort((a, b) => b.lines.runnable - a.lines.runnable || a.file.localeCompare(b.file));
  }
  const unmappedTotal = zero();
  for (const u of unmapped) add(unmappedTotal, u.lines);

  return {
    view,
    features,
    /** Each line one time, also when it is in more than one feature. */
    mapped: cov ? unionCounts(cov, mapped) : null,
    unmapped,
    unmappedTotal,
  };
}

/** Short totals for the project summary. */
export function mappedCodeTotals(p: ProjectConfig, view: View | null) {
  const d = featureCodeCoverage(p, view);
  return { features: d.features.length, entries: d.features.reduce((n, f) => n + f.entries.length, 0), lines: d.mapped, unmapped: d.unmappedTotal };
}

/** Function names of a file in the coverage run (for the skill's checks). Null: the run does not know the file. */
export function functionNames(p: ProjectConfig, file: string): Set<string> | null {
  // Each run alone: the merged view would put the two runs together only to read names.
  for (const v of ['playwright', 'cypress'] as View[]) {
    const cov = loadCoverage(p, v);
    if (cov?.files.has(file)) return new Set((cov.functionsByFile.get(file) ?? []).map((f) => f.function));
  }
  return null;
}
