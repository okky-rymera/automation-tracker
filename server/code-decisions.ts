/**
 * Decisions on whole functions that no test runs (phase 6, step 5 of docs/sync-plan.md).
 *
 * The map-features skill sorts the code that no test runs: feature code goes into a feature (the
 * feature's "code" field), library code (startup, helpers, glue) gets a decision here. The coverage
 * data counts the lines of a library function as library, as a library line mark of a person does
 * (coverage.ts withMarks), so the function is not "not run by tests" now and the skill does not
 * ask again. A person can remove a decision.
 *
 * The function is kept by its name, as the coverage report names it (for example "WWP_Foo::bar"),
 * so the decision stays when the function moves.
 */
import { db, now } from './db.ts';
import { EditError } from './features.ts';
import { safeRepoPath, type ProjectConfig } from './projects.ts';

export interface CodeDecision {
  file: string;
  function: string;
  kind: 'library';
  reason: string;
  by: 'ai' | 'person';
  commit: string | null;
  createdAt: string;
}

/** Changes with each decision change, so the coverage data with marks is made again. */
let version = 0;
export const decisionsVersion = () => version;

export function listDecisions(projectId: string): CodeDecision[] {
  return (db.prepare('SELECT file, function, kind, reason, by, commit_sha, created_at FROM code_decisions WHERE project_id = ? ORDER BY file, function').all(projectId) as any[]).map((r) => ({
    file: r.file,
    function: r.function,
    kind: r.kind,
    reason: r.reason,
    by: r.by,
    commit: r.commit_sha,
    createdAt: r.created_at,
  }));
}

/** Library decisions by file: function names. */
export function libraryFunctions(projectId: string): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const d of listDecisions(projectId)) {
    if (d.kind !== 'library') continue;
    const s = m.get(d.file) ?? new Set<string>();
    s.add(d.function);
    m.set(d.file, s);
  }
  return m;
}

/** Saves library decisions. Throws EditError for a bad file or an empty reason. Returns the number saved. */
export function addLibrary(p: ProjectConfig, items: { file: string; function: string; reason: string }[], by: 'ai' | 'person', commit: string | null): number {
  const put = db.prepare(`INSERT INTO code_decisions (project_id, file, function, kind, reason, by, commit_sha, created_at)
    VALUES (?, ?, ?, 'library', ?, ?, ?, ?)
    ON CONFLICT (project_id, file, function) DO UPDATE SET reason = excluded.reason, by = excluded.by, commit_sha = excluded.commit_sha, created_at = excluded.created_at`);
  let n = 0;
  for (const it of items) {
    if (!it || typeof it.file !== 'string' || !safeRepoPath(p, it.file)) throw new EditError(`library: "${it?.file}" is not a file of the plugin repo`);
    if (typeof it.function !== 'string' || !it.function.trim()) throw new EditError(`library: give the function name for ${it.file}`);
    if (typeof it.reason !== 'string' || !it.reason.trim()) throw new EditError(`library: give a reason for ${it.file} ${it.function}`);
    put.run(p.id, it.file, it.function.trim(), it.reason.trim(), by, commit, now());
    n++;
  }
  if (n) version++;
  return n;
}

export function removeDecision(p: ProjectConfig, file: string, fn: string): boolean {
  const r = db.prepare('DELETE FROM code_decisions WHERE project_id = ? AND file = ? AND function = ?').run(p.id, file, fn);
  if (r.changes) version++;
  return r.changes > 0;
}
