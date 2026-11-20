import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SOURCE_EXT, type ProjectConfig } from './projects.ts';
import { db } from './db.ts';
import { syncProject } from './scan.ts';
import { loadCoverage, runTestPath, type FunctionState, type LineState, type View } from './coverage.ts';
import { fileMarks, lineTexts } from './line-marks.ts';

// Folders that the file list and coverage/analyze.py leave out. Hidden folders (.git, .github) are always left out.
export const DEFAULT_EXCLUDE: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'coverage', 'exclude-dirs.json'), 'utf8'));
const LINE_STATES: LineState[] = ['library', 'tested', 'setup', 'background', 'never'];
const FN_STATES: FunctionState[] = [...LINE_STATES, 'unknown'];

/**
 * cypressOnly: "tested" lines that only Cypress tests ran ("both" view only, else 0).
 * markedLibrary, markedCovered: lines that a person's mark made "library" or "tested". They are in those counts too.
 */
export type LineCounts = Record<LineState | 'runnable' | 'runByTests' | 'cypressOnly' | 'markedLibrary' | 'markedCovered', number>;

export interface FileEntry {
  path: string;
  lang: 'php' | 'js';
  /** False when no coverage data exists for this kind of file (JS today). */
  measured: boolean;
  /** False when no request loaded this PHP file. Its lines are then counted without running it. */
  loaded: boolean;
  /** True when the file never loaded and its runnable lines could not be counted. */
  uncounted: boolean;
  lines: LineCounts;
  functions: Record<FunctionState | 'total', number>;
}

function walk(dir: string, root: string, exclude: Set<string>, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!exclude.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), root, exclude, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name);
      if (!SOURCE_EXT.has(ext) || e.name.endsWith('.min.js') || e.name.endsWith('.d.ts')) continue;
      out.push(path.relative(root, path.join(dir, e.name)));
    }
  }
}

/** Code files in the repo. Used by the scan (scan.ts). Null when the repo folder is missing. */
export function walkRepo(project: ProjectConfig): string[] | null {
  if (!fs.existsSync(project.path)) return null;
  const rels: string[] = [];
  walk(project.path, project.path, new Set(project.excludeDirs ?? DEFAULT_EXCLUDE), rels);
  return rels.sort();
}

/** Code files from the database, with coverage counts of one view (null: no coverage). */
export function listFiles(project: ProjectConfig, view: View | null): FileEntry[] {
  syncProject(project);
  const rels = (db.prepare('SELECT path FROM source_files WHERE project_id = ? ORDER BY path').all(project.id) as any[]).map((r) => r.path as string);
  const cov = view && loadCoverage(project, view);

  return rels.map((rel) => {
    const lang = rel.endsWith('.php') ? 'php' : 'js';
    const fns = cov?.functionsByFile.get(rel) ?? [];
    const fl = cov?.lines[rel];
    const lines = Object.fromEntries(LINE_STATES.map((s) => [s, fl?.[s]?.length ?? 0])) as LineCounts;
    lines.runnable = LINE_STATES.reduce((n, s) => n + lines[s], 0);
    lines.runByTests = fl?.runByTests?.length ?? 0;
    lines.cypressOnly = fl?.cypressOnly?.length ?? 0;
    lines.markedLibrary = fl?.markedLibrary?.length ?? 0;
    lines.markedCovered = fl?.markedCovered?.length ?? 0;
    const functions = Object.fromEntries(FN_STATES.map((s) => [s, fns.filter((f) => f.state === s).length])) as FileEntry['functions'];
    functions.total = fns.length;
    return {
      path: rel,
      lang,
      measured: lang === 'php' && !!cov?.files.has(rel),
      loaded: lang === 'php' && !!fl && !cov!.neverLoaded.has(rel),
      uncounted: lang === 'php' && !!cov?.unknown.has(rel),
      lines,
      functions,
    };
  });
}

export function fileDetail(project: ProjectConfig, rel: string, full: string, view: View | null) {
  const cov = view && loadCoverage(project, view);
  const source = fs.readFileSync(full, 'utf8');
  const testById = new Map((cov?.tests ?? []).map((t) => [t.id, t]));
  const functions = (cov?.functionsByFile.get(rel) ?? []).map((f) => ({
    name: f.function,
    start: f.start,
    end: f.end,
    state: f.state,
    lines: f.lines,
    cypressOnly: f.cypressOnly ?? 0,
    tests: f.tests.map((id) => {
      const t = testById.get(id);
      return { id, title: t ? runTestPath(t).slice(-1)[0] : id, file: t?.file ?? '', framework: t?.framework ?? null };
    }),
  }));
  const empty = { library: [], tested: [], setup: [], background: [], never: [], runByTests: [] };
  return {
    path: rel,
    source,
    measured: rel.endsWith('.php') && !!cov?.files.has(rel),
    loaded: !!cov?.lines[rel] && !cov.neverLoaded.has(rel),
    functions,
    lines: { cypressOnly: [], markedLibrary: [], markedCovered: [], ...(cov?.lines[rel] ?? empty) },
    /** All line marks of the file, stale ones too, so a person can remove them. */
    marks: fileMarks(project.id, rel, lineTexts(source)),
  };
}
