/**
 * Scans a plugin repo and writes what it finds into the database:
 * code files, Playwright tests and Cypress scenarios.
 *
 * Runs again when the last scan is older than SCAN_TTL_MS, so code changes show
 * up within a few seconds without a manual step.
 * A test that is gone is not deleted: it gets removed_at, so its links stay.
 * A scan never makes links: people or the AI skill make them.
 */
import { db, now, tx } from './db.ts';
import type { ProjectConfig } from './projects.ts';
import { SCAN_TTL_MS } from './cache.ts';
import { parsePlaywrightRepo } from './playwright.ts';
import { parseCypressRepo } from './cypress.ts';
import { walkRepo } from './files.ts';

const lastScan = new Map<string, number>();

export function syncProject(project: ProjectConfig, force = false) {
  const at = lastScan.get(project.id);
  if (!force && at && Date.now() - at < SCAN_TTL_MS) return;
  lastScan.set(project.id, Date.now());

  const files = walkRepo(project);
  const pw = parsePlaywrightRepo(project);
  const cy = parseCypressRepo(project);
  const stamp = now();

  tx(() => {
    if (files) {
      db.prepare('DELETE FROM source_files WHERE project_id = ?').run(project.id);
      const add = db.prepare('INSERT INTO source_files (project_id, path, lang) VALUES (?, ?, ?)');
      for (const f of files) add.run(project.id, f, f.endsWith('.php') ? 'php' : 'js');
    }

    const upsert = db.prepare(`
      INSERT INTO tests (project_id, id, framework, file, title, line, tags, data, first_seen, last_seen, removed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (project_id, id) DO UPDATE SET
        framework = excluded.framework, file = excluded.file, title = excluded.title, line = excluded.line,
        tags = excluded.tags, data = excluded.data, last_seen = excluded.last_seen, removed_at = NULL`);
    const save = (
      framework: string,
      list: { id: string; file: string; title: string; line: number; tags: string[] }[] | null,
      keepFiles: string[] = [],
    ) => {
      if (!list) return; // folder missing: keep the old rows as they are
      // Files that could not be read this time: keep their tests as they were.
      const keep = db.prepare('UPDATE tests SET last_seen = ? WHERE project_id = ? AND framework = ? AND file = ? AND removed_at IS NULL');
      for (const f of keepFiles) keep.run(stamp, project.id, framework, f);
      for (const { id, file, title, line, tags, ...rest } of list) {
        upsert.run(project.id, id, framework, file, title, line, JSON.stringify(tags), JSON.stringify(rest), stamp, stamp);
      }
      db.prepare('UPDATE tests SET removed_at = ? WHERE project_id = ? AND framework = ? AND last_seen <> ? AND removed_at IS NULL').run(
        stamp, project.id, framework, stamp,
      );
    };
    save('playwright', pw?.tests ?? null, pw?.errors.map((e) => e.file));
    save('cypress', cy, cy?.filter((s) => s.parseError).map((s) => s.file));
  });
}
