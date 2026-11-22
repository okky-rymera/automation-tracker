/**
 * Tests that are left out of each feature on purpose (docs/sync-plan.md phase 8).
 *
 * The map-features skill links each test of a file to the scopes it checks. A test that fits no
 * feature (a setup file, a helper, a test of something that is gone) goes into "leftOut" with a
 * reason. A feature delete of a person leaves its tests out too, so the AI does not make the
 * deleted feature again. "map next" gives a done test file again when one of its tests has no link
 * and is not left out. A person can remove a row: the file then comes back in the mapping loop.
 */
import { db, now } from './db.ts';
import { EditError } from './features.ts';

export interface LeftOutTest {
  testId: string;
  /** The test title and file, when the test is still in the last scan. */
  title: string | null;
  file: string | null;
  framework: string | null;
  reason: string;
  by: 'ai' | 'person';
  createdAt: string;
}

export function listLeftOut(projectId: string): LeftOutTest[] {
  return (db
    .prepare(
      `SELECT o.test_id, o.reason, o.by, o.created_at, t.title, t.file, t.framework
       FROM test_left_out o LEFT JOIN tests t ON t.project_id = o.project_id AND t.id = o.test_id AND t.removed_at IS NULL
       WHERE o.project_id = ? ORDER BY t.framework, t.file, t.line, o.test_id`,
    )
    .all(projectId) as any[]).map((r) => ({
    testId: r.test_id,
    title: r.title ?? null,
    file: r.file ?? null,
    framework: r.framework ?? null,
    reason: r.reason,
    by: r.by,
    createdAt: r.created_at,
  }));
}

/** The left-out test IDs of a project. */
export function leftOutIds(projectId: string): Set<string> {
  return new Set((db.prepare('SELECT test_id FROM test_left_out WHERE project_id = ?').all(projectId) as any[]).map((r) => r.test_id as string));
}

/** Saves left-out tests. Throws EditError for an unknown test or an empty reason. Returns the number saved. */
export function addLeftOut(projectId: string, items: { testId: string; reason: string }[], by: 'ai' | 'person'): number {
  const known = db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND id = ? AND removed_at IS NULL');
  const put = db.prepare(
    `INSERT INTO test_left_out (project_id, test_id, reason, by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project_id, test_id) DO UPDATE SET reason = excluded.reason, by = excluded.by, created_at = excluded.created_at`,
  );
  let n = 0;
  for (const it of items) {
    const id = typeof it?.testId === 'string' ? it.testId.trim() : '';
    if (!id || !known.get(projectId, id)) throw new EditError(`leftOut: unknown test "${it?.testId}". Use the test IDs that "next" gave`);
    if (typeof it.reason !== 'string' || !it.reason.trim()) throw new EditError(`leftOut: give a reason for ${id}`);
    put.run(projectId, id, it.reason.trim().slice(0, 1000), by, now());
    n++;
  }
  return n;
}

export function removeLeftOut(projectId: string, testId: string): boolean {
  return db.prepare('DELETE FROM test_left_out WHERE project_id = ? AND test_id = ?').run(projectId, testId).changes > 0;
}

/** A link to any feature, also one that a person removed (a decision too), removes the left-out row. */
export function clearLeftOutForLinked(projectId: string) {
  db.prepare('DELETE FROM test_left_out WHERE project_id = ? AND test_id IN (SELECT test_id FROM links WHERE project_id = ? AND removed = 0)').run(projectId, projectId);
}
