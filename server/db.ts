/**
 * The SQLite database (data/tracker.db). It holds all data of the tool:
 *  - projects, and the files and tests found in each plugin repo (rebuilt by a scan)
 *  - imported coverage runs (rebuilt from the run folders)
 *  - features, abilities and links to tests (typed by people: the only copy)
 *
 * Schema changes go in MIGRATIONS. Never edit an old step: add a new one.
 * PRAGMA user_version holds the number of steps that ran.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
export const DB_FILE = process.env.TRACKER_DB ?? path.join(ROOT, 'data', 'tracker.db');

const MIGRATIONS: string[] = [
  // 1: projects, scanned data, coverage runs, features and links.
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    playwright_dir TEXT,
    cypress_dir TEXT,
    exclude_dirs TEXT,              -- JSON array, or NULL for the default list
    coverage_run_id INTEGER,        -- run shown in the app
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Code files in the plugin repo. Rebuilt by each scan.
  CREATE TABLE source_files (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    lang TEXT NOT NULL,
    PRIMARY KEY (project_id, path)
  );

  -- Playwright tests and Cypress scenarios. A scan never deletes a row: a test
  -- that is gone gets removed_at, so its links stay visible.
  CREATE TABLE tests (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    id TEXT NOT NULL,               -- PW-xxxxxxxx or CY-xxxxxxxx
    framework TEXT NOT NULL,        -- playwright | cypress
    file TEXT NOT NULL,
    title TEXT NOT NULL,
    line INTEGER NOT NULL,
    tags TEXT NOT NULL,             -- JSON array
    data TEXT NOT NULL,             -- JSON: the other fields of the scan
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    removed_at TEXT,
    PRIMARY KEY (project_id, id)
  );

  CREATE TABLE coverage_runs (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    dir TEXT NOT NULL,              -- run folder, relative to this tool
    label TEXT,
    plugin_commit TEXT,
    plugin_dirty INTEGER,
    source_mtime TEXT,              -- change times of report.json and lines.json at import
    imported_at TEXT,
    UNIQUE (project_id, dir)
  );

  CREATE TABLE run_tests (
    run_id INTEGER NOT NULL REFERENCES coverage_runs(id) ON DELETE CASCADE,
    id TEXT NOT NULL,               -- test ID from the Playwright reporter
    data TEXT NOT NULL,             -- JSON: title, project, path, file, line, tags, status
    PRIMARY KEY (run_id, id)
  );

  CREATE TABLE run_files (
    run_id INTEGER NOT NULL REFERENCES coverage_runs(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    never_loaded INTEGER NOT NULL DEFAULT 0,
    uncounted INTEGER NOT NULL DEFAULT 0,
    lines TEXT,                     -- JSON: line numbers by state
    PRIMARY KEY (run_id, path)
  );

  CREATE TABLE run_functions (
    run_id INTEGER NOT NULL REFERENCES coverage_runs(id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    name TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    state TEXT NOT NULL,
    lines TEXT NOT NULL,            -- JSON: runnable line counts by state
    tests TEXT NOT NULL             -- JSON: run test IDs
  );
  CREATE INDEX run_functions_file ON run_functions(run_id, file);

  -- Features: typed by people. IDs are numbers, so a new title keeps the ID.
  CREATE TABLE feature_groups (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE features (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES feature_groups(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Tag names of a feature: "@feature:<tag>" in a test links the test to it.
  CREATE TABLE feature_tags (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,              -- lower case, without "@feature:"
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, tag)
  );

  CREATE TABLE abilities (
    id INTEGER PRIMARY KEY,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  );

  -- Test to feature (and optional ability). No foreign key to tests on purpose:
  -- a scan can mark a test removed, and the link must stay.
  --   source  = tag (made from a feature tag) or manual (made or changed by a person)
  --   removed = 1 when a person removed a tag link (a scan must not add it again)
  CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    test_id TEXT NOT NULL,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    ability_id INTEGER REFERENCES abilities(id) ON DELETE SET NULL,
    source TEXT NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, test_id, feature_id)
  );
  CREATE INDEX links_feature ON links(feature_id);

  -- Projects whose features were made from tags once (seed runs one time only).
  CREATE TABLE feature_seeds (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    seeded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];

function open(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export const db = open();

let depth = 0;
/** Runs fn in one transaction. A nested call joins the outer transaction. */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

export const now = () => new Date().toISOString();
export const json = (s: unknown) => JSON.parse(String(s));
