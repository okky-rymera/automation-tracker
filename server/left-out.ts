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
import { hashFiles, testRepoPath, type ProjectConfig } from './projects.ts';

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

/**
 * Why a test with no active link is not linked: the AI or a person decided it.
 * - "left-out": a row in test_left_out, with its reason.
 * - "file-skipped": the mapping loop skipped the whole test file (processed_units status "skipped"), with its note.
 * - "unlinked": a person removed its link, or a move took its last scope. The AI does not link it again.
 * The same rule as "map next" (server/map.ts): these tests are not given to the AI again.
 * A test that is not in this list and has no active link still waits for a decision.
 */
export interface TestDecision {
  testId: string;
  kind: 'left-out' | 'file-skipped' | 'unlinked';
  reason: string;
  by: 'ai' | 'person';
  at: string | null;
  /** For "unlinked": the features it was linked to. */
  features?: { id: number; title: string }[];
}

export function testDecisions(p: ProjectConfig): TestDecision[] {
  const projectId = p.id;
  const tests = db
    .prepare(
      `SELECT t.id, t.framework, t.file FROM tests t
       WHERE t.project_id = ? AND t.removed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM links l WHERE l.project_id = t.project_id AND l.test_id = t.id AND l.removed = 0)`,
    )
    .all(projectId) as { id: string; framework: 'playwright' | 'cypress'; file: string }[];
  const leftOut = new Map(listLeftOut(projectId).map((r) => [r.testId, r]));
  const skipped = new Map(
    (db.prepare(`SELECT kind, ref, files, hash, note, processed_at FROM processed_units WHERE project_id = ? AND status = 'skipped'`).all(projectId) as any[])
      .map((r) => [`${r.kind}\n${r.ref}`, r]),
  );
  // A skipped file counts only while its files have the hash the skip saved. A changed file goes back to the AI (server/map.ts testFiles).
  const skipStillValid = new Map<string, boolean>();
  const skipValid = (key: string, fw: 'playwright' | 'cypress', file: string, unit: any) => {
    if (!skipStillValid.has(key)) {
      let files: string[] = [];
      try { files = JSON.parse(unit.files || '[]'); } catch { /* bad JSON: use the test file */ }
      skipStillValid.set(key, hashFiles(p, files.length ? files : [testRepoPath(p, fw, file)]) === unit.hash);
    }
    return skipStillValid.get(key)!;
  };
  const removedBy = new Map<string, { id: number; title: string; at: string }[]>();
  for (const r of db
    .prepare(
      `SELECT l.test_id, f.id, f.title, l.created_at FROM links l JOIN features f ON f.id = l.feature_id
       WHERE l.project_id = ? AND l.removed = 1 ORDER BY f.id`,
    )
    .all(projectId) as any[]) removedBy.set(r.test_id, [...(removedBy.get(r.test_id) ?? []), { id: r.id, title: r.title, at: r.created_at }]);
  const out: TestDecision[] = [];
  for (const t of tests) {
    const lo = leftOut.get(t.id);
    if (lo) {
      out.push({ testId: t.id, kind: 'left-out', reason: lo.reason, by: lo.by, at: lo.createdAt });
      continue;
    }
    const key = `${t.framework}\n${t.file}`;
    const sk = skipped.get(key);
    if (sk && skipValid(key, t.framework, t.file, sk)) {
      out.push({ testId: t.id, kind: 'file-skipped', reason: sk.note || 'The AI skipped this test file. It gave no reason.', by: 'ai', at: sk.processed_at });
      continue;
    }
    const rm = removedBy.get(t.id);
    if (rm?.length) {
      const names = rm.map((f) => `F-${f.id} “${f.title}”`).join(', ');
      // The database keeps no date or person for the removal: only that the link is removed.
      out.push({
        testId: t.id, kind: 'unlinked', by: 'person', at: null, features: rm.map(({ id, title }) => ({ id, title })),
        reason: `Its link to ${names} was removed: a person unlinked it, or its scope moved to another feature. The AI does not link it again.`,
      });
    }
  }
  return out;
}
