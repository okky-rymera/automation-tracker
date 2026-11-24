/**
 * The code work of the mapping AI: the plugin code that the feature list does not account for yet.
 * It comes from the code itself, not from a list of files that the AI looked at. So a file is done
 * only when all its code is sorted, and after a sync only the code that changed comes back.
 *
 * Each PHP function of the coverage run, and the code outside all functions of each file (the "loose"
 * part, function ""), is one item:
 *  - sorted: a feature holds it (by name, or the whole file), or it has a decision (library or unused),
 *    or the run says it is library (it runs on every request), or all its lines are library lines
 *    (for example the ABSPATH guard, coverage.ts autoLibraryLines).
 *  - open: none of these. Tests can run it or not: code that tests run belongs in a feature too.
 *  - check: it is sorted, but its code changed since then (its fingerprint is not the same now,
 *    server/code-fingerprint.ts). The AI keeps it where it is, moves it, or decides again.
 * Code of a feature marked "To remove" is not "check": the AI skills do not write to that feature.
 *
 * A PHP file that the coverage run does not know (added after the run) has no items yet: the
 * function names come from the run. It gets them after the next coverage run.
 */
import { db } from './db.ts';
import { loadCoverage, resolveView, type CoverageData, type LineState } from './coverage.ts';
import { currentFingerprint } from './code-fingerprint.ts';
import type { ProjectConfig } from './projects.ts';

export interface WorkItem {
  file: string;
  /** "" = the code outside all functions of the file. */
  function: string;
  status: 'open' | 'check';
  /** Lines from the coverage run, for a function. */
  lines: string | null;
  /** Runnable lines that are not library. */
  featureLines: number;
  /** The coverage state of a function (tested, never, ...). */
  state: string | null;
  /** For "check": what holds the code now. */
  heldBy?: { featureId: number; feature: string; source: 'ai' | 'manual' }[];
  decision?: 'library' | 'unused';
}

const FEATURE_STATES: LineState[] = ['tested', 'setup', 'background', 'never'];

/** Sets the fingerprint of entries and decisions that have none (the baseline: the code now). */
export function fillFingerprints(p: ProjectConfig) {
  for (const r of db.prepare('SELECT id, file, function FROM feature_code WHERE project_id = ? AND removed = 0 AND fingerprint IS NULL').all(p.id) as any[]) {
    const fp = currentFingerprint(p, r.file, r.function, 'file');
    if (fp) db.prepare('UPDATE feature_code SET fingerprint = ? WHERE id = ?').run(fp, r.id);
  }
  for (const r of db.prepare('SELECT file, function FROM code_decisions WHERE project_id = ? AND fingerprint IS NULL').all(p.id) as any[]) {
    const fp = currentFingerprint(p, r.file, r.function, 'loose');
    if (fp) db.prepare('UPDATE code_decisions SET fingerprint = ? WHERE project_id = ? AND file = ? AND function = ?').run(fp, p.id, r.file, r.function);
  }
}

interface Held {
  id: number;
  featureId: number;
  feature: string;
  function: string;
  source: 'ai' | 'manual';
  fingerprint: string | null;
  toRemove: boolean;
}

/**
 * The open and "check" items of the project, or of some files only. cov: the coverage data to use
 * (default: both runs together, with marks and decisions).
 */
export function codeWork(p: ProjectConfig, onlyFiles?: string[], cov?: CoverageData | null): WorkItem[] {
  const data = cov ?? (() => {
    const view = resolveView(p, 'both');
    return view ? loadCoverage(p, view) : null;
  })();
  if (!data) return [];
  const held = new Map<string, Held[]>();
  for (const r of db
    .prepare(
      `SELECT c.id, c.feature_id AS featureId, f.title AS feature, c.file, c.function, c.source, c.fingerprint, f.remove_reason IS NOT NULL AS toRemove
       FROM feature_code c JOIN features f ON f.id = c.feature_id WHERE c.project_id = ? AND c.removed = 0`,
    )
    .all(p.id) as any[]) {
    const list = held.get(r.file) ?? [];
    list.push({ ...r, toRemove: !!r.toRemove });
    held.set(r.file, list);
  }
  const decided = new Map<string, Map<string, { kind: 'library' | 'unused'; fingerprint: string | null }>>();
  for (const r of db.prepare('SELECT file, function, kind, fingerprint FROM code_decisions WHERE project_id = ?').all(p.id) as any[]) {
    const m = decided.get(r.file) ?? new Map();
    m.set(r.function, { kind: r.kind, fingerprint: r.fingerprint });
    decided.set(r.file, m);
  }
  const php = onlyFiles ?? (db.prepare("SELECT path FROM source_files WHERE project_id = ? AND lang = 'php' ORDER BY path").all(p.id) as any[]).map((r) => r.path as string);
  const out: WorkItem[] = [];
  for (const file of php) {
    const fl = data.lines[file];
    if (!fl) continue; // not in the coverage run
    const fns = data.functionsByFile.get(file) ?? [];
    const featureLines = new Set(FEATURE_STATES.flatMap((s) => fl[s] ?? []));
    const h = held.get(file) ?? [];
    const whole = h.filter((x) => x.function === '');
    const dec = decided.get(file);
    // "check" for held entries: one entry per fingerprint test. An entry of a "To remove" feature is not checked.
    const changedHeld = (list: Held[], part: 'loose' | 'file') =>
      list.filter((x) => !x.toRemove && x.fingerprint !== null && (() => {
        const now = currentFingerprint(p, file, x.function, part);
        return now !== null && now !== x.fingerprint;
      })());
    const heldOut = (list: Held[]) => list.map((x) => ({ featureId: x.featureId, feature: x.feature, source: x.source }));

    // A whole-file entry holds all the code of the file. When the file changed, the file is one item.
    if (whole.length) {
      const ch = changedHeld(whole, 'file');
      if (ch.length) out.push({ file, function: '', status: 'check', lines: null, featureLines: featureLines.size, state: null, heldBy: heldOut(whole) });
      continue;
    }
    const items: { fn: string; lines: number[]; range: string | null; state: string | null; libraryRun: boolean }[] = [];
    // Functions with the same name (closures) are one item, as a feature entry by name holds all of them.
    const byName = new Map<string, typeof fns>();
    for (const f of fns) byName.set(f.function, [...(byName.get(f.function) ?? []), f]);
    // Lines inside a function that a feature or a decision holds are sorted, also when an inner function
    // (a closure) has its own name: a feature entry by name holds all lines of the function (feature-code.ts).
    const sortedNames = new Set([...h.map((x) => x.function), ...(dec ? [...dec.keys()] : [])].filter(Boolean));
    const sortedLines = new Set([...featureLines].filter((n) => fns.some((f) => sortedNames.has(f.function) && n >= f.start && n <= f.end)));
    // Each line counts for one item only: the innermost function that holds it (a closure inside a method
    // counts for the closure), so nested functions do not count a line two times.
    const owner = new Map<number, string>();
    for (const n of featureLines) {
      let best: (typeof fns)[number] | null = null;
      for (const f of fns) if (n >= f.start && n <= f.end && (!best || f.end - f.start < best.end - best.start)) best = f;
      if (best) owner.set(n, best.function);
    }
    for (const [name, list] of byName) {
      const lines = [...featureLines].filter((n) => owner.get(n) === name && (sortedNames.has(name) || !sortedLines.has(n)));
      items.push({
        fn: name,
        lines,
        range: list.map((f) => `${f.start}-${f.end}`).join(', '),
        state: list.length === 1 ? list[0].state : list.map((f) => f.state).join(', '),
        libraryRun: list.every((f) => f.state === 'library'),
      });
    }
    const loose = [...featureLines].filter((n) => !fns.some((f) => n >= f.start && n <= f.end));
    items.push({ fn: '', lines: loose, range: null, state: null, libraryRun: false });

    for (const it of items) {
      const d = dec?.get(it.fn);
      const mine = h.filter((x) => x.function === it.fn);
      if (d) {
        const now = d.fingerprint === null ? null : currentFingerprint(p, file, it.fn, 'loose');
        if (now !== null && now !== d.fingerprint) out.push({ file, function: it.fn, status: 'check', lines: it.range, featureLines: it.lines.length, state: it.state, decision: d.kind, ...(mine.length ? { heldBy: heldOut(mine) } : {}) });
        continue;
      }
      if (mine.length) {
        if (changedHeld(mine, 'loose').length) out.push({ file, function: it.fn, status: 'check', lines: it.range, featureLines: it.lines.length, state: it.state, heldBy: heldOut(mine) });
        continue;
      }
      // Library by the run (runs on every request), or no feature line left (all library lines): sorted.
      if (it.libraryRun || !it.lines.length) continue;
      out.push({ file, function: it.fn, status: 'open', lines: it.range, featureLines: it.lines.length, state: it.state });
    }
  }
  return out;
}

/** The work items by file, most feature lines first. */
export function workByFile(items: WorkItem[]) {
  const by = new Map<string, WorkItem[]>();
  for (const it of items) by.set(it.file, [...(by.get(it.file) ?? []), it]);
  return [...by.entries()]
    .map(([file, list]) => ({
      file,
      open: list.filter((x) => x.status === 'open').length,
      check: list.filter((x) => x.status === 'check').length,
      featureLines: list.reduce((n, x) => n + x.featureLines, 0),
      items: list,
    }))
    .sort((a, b) => b.featureLines - a.featureLines || a.file.localeCompare(b.file));
}
