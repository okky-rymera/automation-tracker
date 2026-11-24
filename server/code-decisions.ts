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
 * so the decision stays when the function moves. Function "" is the code outside all functions of the
 * file: guard lines, start-up code, or a whole template.
 *
 * kind "unused": no plugin code loads or calls the code. The coverage data counts it like library
 * (it is not a test gap), but the overview shows it apart, so the team can delete it.
 * fingerprint: the content of the code when the decision was made (server/code-fingerprint.ts). When
 * it is not the same now, the AI checks the decision again.
 */
import { db, now } from './db.ts';
import { currentFingerprint } from './code-fingerprint.ts';
import { EditError } from './features.ts';
import { safeRepoPath, type ProjectConfig } from './projects.ts';

export type DecisionKind = 'library' | 'unused';
export const DECISION_KINDS: DecisionKind[] = ['library', 'unused'];

export interface CodeDecision {
  file: string;
  function: string;
  kind: DecisionKind;
  reason: string;
  by: 'ai' | 'person';
  commit: string | null;
  createdAt: string;
  fingerprint: string | null;
}

/** Changes with each decision change, so the coverage data with marks is made again. */
let version = 0;
export const decisionsVersion = () => version;

/**
 * A value that changes when the decisions of the project change, read from the database. The counter
 * above is not enough: a save that fails undoes its decisions in the database, but not the counter. A
 * cache entry made inside that save would then stay with decisions that are not in the database.
 */
export function decisionsState(projectId: string): string {
  const r = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(created_at), '') AS m, COALESCE(SUM(kind = 'unused'), 0) AS u, COALESCE(SUM(LENGTH(file) + LENGTH(function)), 0) AS l FROM code_decisions WHERE project_id = ?")
    .get(projectId) as any;
  return `${r.n}.${r.m}.${r.u}.${r.l}`;
}

export function listDecisions(projectId: string): CodeDecision[] {
  return (db.prepare('SELECT file, function, kind, reason, by, commit_sha, created_at, fingerprint FROM code_decisions WHERE project_id = ? ORDER BY file, function').all(projectId) as any[]).map((r) => ({
    file: r.file,
    function: r.function,
    kind: r.kind,
    reason: r.reason,
    by: r.by,
    commit: r.commit_sha,
    createdAt: r.created_at,
    fingerprint: r.fingerprint,
  }));
}

/** Decisions by file: function names ("" = the code outside functions), with their kind. */
export function decidedFunctions(projectId: string): Map<string, Map<string, DecisionKind>> {
  const m = new Map<string, Map<string, DecisionKind>>();
  for (const d of listDecisions(projectId)) {
    const s = m.get(d.file) ?? new Map<string, DecisionKind>();
    s.set(d.function, d.kind);
    m.set(d.file, s);
  }
  return m;
}

/**
 * Saves decisions of one kind. Throws EditError for a bad file or an empty reason. Returns the number saved.
 * function "" is the code outside all functions of the file. Saving a decision again (the same, or a new
 * kind) sets its fingerprint to the code now: the AI checked it again.
 */
export function addDecisions(
  p: ProjectConfig,
  kind: DecisionKind,
  items: { file: string; function?: string; reason: string }[],
  by: 'ai' | 'person',
  commit: string | null,
): number {
  const put = db.prepare(`INSERT INTO code_decisions (project_id, file, function, kind, reason, by, commit_sha, created_at, fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, file, function) DO UPDATE SET kind = excluded.kind, reason = excluded.reason, by = excluded.by,
      commit_sha = excluded.commit_sha, created_at = excluded.created_at, fingerprint = excluded.fingerprint`);
  let n = 0;
  for (const it of items) {
    if (!it || typeof it.file !== 'string' || !safeRepoPath(p, it.file)) throw new EditError(`${kind}: "${it?.file}" is not a file of the plugin repo`);
    if (it.function !== undefined && typeof it.function !== 'string') throw new EditError(`${kind}: the function of ${it.file} must be a name, or "" for the code outside functions`);
    if (typeof it.reason !== 'string' || !it.reason.trim()) throw new EditError(`${kind}: give a reason for ${it.file} ${it.function || '(code outside functions)'}`);
    const fn = (it.function ?? '').trim();
    put.run(p.id, it.file, fn, kind, it.reason.trim(), by, commit, now(), currentFingerprint(p, it.file, fn, 'loose'));
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
