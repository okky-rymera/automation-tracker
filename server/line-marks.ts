/**
 * Hand marks on code lines. A person marks runnable lines of a file:
 *  - library: the line runs on every request. It is not feature code.
 *  - covered: a test checks the line, but the coverage run did not see it.
 * The coverage data applies the marks (coverage.ts withMarks), so every total counts them.
 *
 * A mark keeps the trimmed text of its line. When the line moved or changed, the text is not the
 * same now: the mark is "stale". It does not count, but it stays, so a person can see it and remove it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, now, tx } from './db.ts';
import { EditError } from './features.ts';
import { safeRepoPath, type ProjectConfig } from './projects.ts';

export type MarkKind = 'library' | 'covered';
export const MARK_KINDS: MarkKind[] = ['library', 'covered'];

export interface LineMark {
  file: string;
  line: number;
  kind: MarkKind;
  text: string;
}

/** The trimmed text of each line of a file. Line n is at index n - 1. All mark code uses it, so the texts match. */
export const lineTexts = (source: string) => source.split(/\r?\n/).map((l) => l.trim());

/** Changes with each mark change, so the coverage data with marks is made again. */
let version = 0;
export const marksVersion = () => version;

/** The marks of a project, by file. */
export function marksByFile(projectId: string): Map<string, LineMark[]> {
  const m = new Map<string, LineMark[]>();
  for (const r of db.prepare('SELECT file, line, kind, text FROM line_marks WHERE project_id = ? ORDER BY file, line').all(projectId) as any[]) {
    const list = m.get(r.file) ?? [];
    list.push(r);
    m.set(r.file, list);
  }
  return m;
}

/** The line texts of a repo file now, or null when the file is gone. */
export function repoLines(p: ProjectConfig, file: string): string[] | null {
  const full = safeRepoPath(p, file);
  if (!full) return null;
  try {
    return lineTexts(fs.readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

/** True when the line text is not the same now (or the file is gone). */
export const isStale = (m: LineMark, lines: string[] | null) => !lines || lines[m.line - 1] !== m.text;

/** The marks of one file, stale ones too. lines: the line texts now (lineTexts). */
export function fileMarks(projectId: string, file: string, lines: string[] | null) {
  return (marksByFile(projectId).get(file) ?? []).map((m) => ({ line: m.line, kind: m.kind, stale: isStale(m, lines) }));
}

/** All marks of a project, with the stale state. Each file is read one time. */
export function listMarks(p: ProjectConfig) {
  const out: { file: string; line: number; kind: MarkKind; stale: boolean }[] = [];
  for (const [file, marks] of marksByFile(p.id)) {
    const lines = repoLines(p, file);
    for (const m of marks) out.push({ file, line: m.line, kind: m.kind, stale: isStale(m, lines) });
  }
  return out;
}

/** File and line numbers from a request body. The file must be a code file in the repo. */
/** The same form as the coverage keys ("src/a.php", not "src//a.php" or "./src/a.php"), or the mark never counts. */
const cleanPath = (f: unknown) => (typeof f === 'string' && f ? path.posix.normalize(f.replace(/\\/g, '/')).replace(/^\.\//, '') : '');

function target(p: ProjectConfig, b: any): { file: string; full: string; lines: number[] } {
  const file = cleanPath(b?.file);
  const full = safeRepoPath(p, file);
  if (!full) throw new EditError('File not found in the repo');
  if (!Array.isArray(b.lines) || !b.lines.length) throw new EditError('lines must be a list of line numbers');
  if (b.lines.length > 20000) throw new EditError('Too many lines');
  const lines = [...new Set<number>(b.lines.map(Number))];
  if (lines.some((n) => !Number.isInteger(n) || n < 1)) throw new EditError('lines must be a list of line numbers');
  return { file, full, lines };
}

export const markEdits = {
  /**
   * Marks lines: body { file, lines, kind }. A blank line or a line after the end of the file is skipped.
   * A new mark on a marked line replaces the old one.
   */
  mark(p: ProjectConfig, b: any) {
    const { file, full, lines } = target(p, b);
    if (!MARK_KINDS.includes(b.kind)) throw new EditError(`kind must be one of: ${MARK_KINDS.join(', ')}`);
    const texts = lineTexts(fs.readFileSync(full, 'utf8'));
    const add = db.prepare(
      `INSERT INTO line_marks (project_id, file, line, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, file, line) DO UPDATE SET kind = excluded.kind, text = excluded.text, created_at = excluded.created_at`,
    );
    let marked = 0;
    tx(() => {
      for (const n of lines) {
        const t = texts[n - 1];
        if (!t) continue; // out of range, or blank
        add.run(p.id, file, n, b.kind, t, now());
        marked++;
      }
    });
    version++;
    return { marked };
  },
  /** Removes the marks of lines: body { file, lines }. The file can be gone from the repo. */
  unmark(p: ProjectConfig, b: any) {
    // The same clean-up as mark(), so the same path finds the marks. The file can be gone, so no check that it exists.
    const file = cleanPath(b?.file);
    if (!file) throw new EditError('File is empty');
    if (!Array.isArray(b.lines)) throw new EditError('lines must be a list of line numbers');
    const del = db.prepare('DELETE FROM line_marks WHERE project_id = ? AND file = ? AND line = ?');
    const removed = tx(() => b.lines.reduce((n: number, l: unknown) => n + Number(del.run(p.id, file, Number(l)).changes), 0));
    version++;
    return { removed };
  },
};
