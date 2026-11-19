/**
 * The SQLite database (data/tracker.db). It holds all data of the tool:
 *  - projects, and the files and tests found in each plugin repo (rebuilt by a scan)
 *  - imported coverage runs (rebuilt from the run folders)
 *  - features, scopes, lists, labels and links to tests (typed by people or the AI skill: the only copy)
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
    coverage_run_id INTEGER,        -- run shown in the app (step 6: the Playwright run)
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

  -- Test to feature (step 3 moves the abilities to link_abilities). No foreign key to tests on purpose:
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

  // 2: more feature fields, AI draft marks, and the units the feature-mapping skill did.
  //   ai_draft = 1: the skill wrote or changed the row, and no person checked it yet.
  `
  ALTER TABLE features ADD COLUMN out_of_scope TEXT NOT NULL DEFAULT '';
  ALTER TABLE features ADD COLUMN user_roles TEXT NOT NULL DEFAULT '';
  ALTER TABLE features ADD COLUMN location TEXT NOT NULL DEFAULT '';      -- where in the UI or settings
  ALTER TABLE features ADD COLUMN dependencies TEXT NOT NULL DEFAULT '';  -- settings, plugins, other features
  ALTER TABLE features ADD COLUMN business_rules TEXT NOT NULL DEFAULT '';
  ALTER TABLE features ADD COLUMN open_questions TEXT NOT NULL DEFAULT '';
  ALTER TABLE features ADD COLUMN priority TEXT NOT NULL DEFAULT '';      -- high | medium | low | ''
  ALTER TABLE features ADD COLUMN ai_draft INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE abilities ADD COLUMN ai_draft INTEGER NOT NULL DEFAULT 0;

  -- One row for each test file or code area the skill processed.
  -- No foreign key to source_files or tests: a scan rebuilds those.
  CREATE TABLE processed_units (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,             -- playwright | cypress | code
    ref TEXT NOT NULL,              -- test file path, or a code area name
    status TEXT NOT NULL,           -- done | skipped
    files TEXT NOT NULL DEFAULT '[]',     -- JSON: repo files the unit read
    hash TEXT NOT NULL DEFAULT '',        -- of those files at that time
    features TEXT NOT NULL DEFAULT '[]',  -- JSON: feature IDs it wrote to
    note TEXT NOT NULL DEFAULT '',
    processed_at TEXT NOT NULL,
    PRIMARY KEY (project_id, kind, ref)
  );
  `,

  // 3: a link can hold more than one ability (a test often checks several).
  //    The links table is rebuilt without ability_id; link_abilities holds the abilities.
  //    No table points at links before this step, so the rebuild is safe.
  `
  CREATE TABLE link_abilities_tmp AS SELECT id AS link_id, ability_id FROM links WHERE ability_id IS NOT NULL;
  CREATE TABLE links_new (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    test_id TEXT NOT NULL,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, test_id, feature_id)
  );
  INSERT INTO links_new (id, project_id, test_id, feature_id, source, removed, created_at)
    SELECT id, project_id, test_id, feature_id, source, removed, created_at FROM links;
  DROP TABLE links;
  ALTER TABLE links_new RENAME TO links;
  CREATE INDEX links_feature ON links(feature_id);
  CREATE TABLE link_abilities (
    link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    ability_id INTEGER NOT NULL REFERENCES abilities(id) ON DELETE CASCADE,
    PRIMARY KEY (link_id, ability_id)
  );
  CREATE INDEX link_abilities_ability ON link_abilities(ability_id);
  INSERT INTO link_abilities SELECT link_id, ability_id FROM link_abilities_tmp;
  DROP TABLE link_abilities_tmp;
  `,

  // 4: abilities are now "scopes" (like the scenarios in tests). Lists and labels
  //    replace the free text fields. Tag links go: people or the AI skill make links.
  `
  ALTER TABLE abilities RENAME TO scopes;
  ALTER TABLE link_abilities RENAME TO link_scopes;
  ALTER TABLE link_scopes RENAME COLUMN ability_id TO scope_id;
  DROP INDEX link_abilities_ability;
  CREATE INDEX link_scopes_scope ON link_scopes(scope_id);

  -- Lists of sentences on a feature.
  CREATE TABLE feature_items (
    id INTEGER PRIMARY KEY,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,              -- rule | out_of_scope | where | question
    text TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    ai_draft INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX feature_items_feature ON feature_items(feature_id, kind, sort);

  -- Short values that repeat across features. A value exists while one feature uses it.
  CREATE TABLE feature_labels (
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,              -- role | needs
    value TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (feature_id, kind, value)
  );

  -- Move the old text fields: each non-empty field becomes one item or label.
  INSERT INTO feature_items (feature_id, kind, text, ai_draft) SELECT id, 'rule', business_rules, ai_draft FROM features WHERE business_rules <> '';
  INSERT INTO feature_items (feature_id, kind, text, ai_draft) SELECT id, 'out_of_scope', out_of_scope, ai_draft FROM features WHERE out_of_scope <> '';
  INSERT INTO feature_items (feature_id, kind, text, ai_draft) SELECT id, 'where', location, ai_draft FROM features WHERE location <> '';
  INSERT INTO feature_items (feature_id, kind, text, ai_draft) SELECT id, 'question', open_questions, ai_draft FROM features WHERE open_questions <> '';
  INSERT INTO feature_labels (feature_id, kind, value) SELECT id, 'role', user_roles FROM features WHERE user_roles <> '';
  INSERT INTO feature_labels (feature_id, kind, value) SELECT id, 'needs', dependencies FROM features WHERE dependencies <> '';
  ALTER TABLE features DROP COLUMN out_of_scope;
  ALTER TABLE features DROP COLUMN user_roles;
  ALTER TABLE features DROP COLUMN location;
  ALTER TABLE features DROP COLUMN dependencies;
  ALTER TABLE features DROP COLUMN business_rules;
  ALTER TABLE features DROP COLUMN open_questions;

  -- No more automatic links from @feature: tags: people or the AI skill make every link.
  -- Old tag links stay, marked as AI links, so a person reviews them.
  DROP TABLE feature_tags;
  DROP TABLE feature_seeds;
  UPDATE links SET source = 'ai' WHERE source = 'tag';
  `,

  // 5: the "AI draft" mark is kept for each field, not for the whole row.
  //    ai_fields = JSON list of the fields the AI skill wrote and no person checked yet.
  //    So filling one empty field does not give the skill the right to change the others.
  `
  ALTER TABLE features ADD COLUMN ai_fields TEXT NOT NULL DEFAULT '[]';
  UPDATE features SET ai_fields = '["title","description","priority","group"]' WHERE ai_draft = 1;
  ALTER TABLE features DROP COLUMN ai_draft;
  ALTER TABLE scopes ADD COLUMN ai_fields TEXT NOT NULL DEFAULT '[]';
  UPDATE scopes SET ai_fields = '["title","description"]' WHERE ai_draft = 1;
  ALTER TABLE scopes DROP COLUMN ai_draft;
  -- checked = 1: a person checked an AI link ("Mark as checked"). The "linked by AI" mark goes.
  ALTER TABLE links ADD COLUMN checked INTEGER NOT NULL DEFAULT 0;
  `,

  // 6: one coverage run per test tool. projects.coverage_run_id is now the Playwright run,
  //    and projects.cypress_run_id is the Cypress run. Old runs are Playwright runs.
  `
  ALTER TABLE coverage_runs ADD COLUMN framework TEXT NOT NULL DEFAULT 'playwright';  -- playwright | cypress
  ALTER TABLE projects ADD COLUMN cypress_run_id INTEGER;
  `,

  // 7: the plugin code of each feature: a whole file, or one function in a file (by name, as the
  //    coverage run names it). The AI skill adds rows (source "ai"); a person removes them.
  //    A removed row stays with removed = 1, so the skill does not add it again.
  //    No foreign key to source_files: a scan rebuilds that table.
  `
  CREATE TABLE feature_code (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    file TEXT NOT NULL,               -- relative to the plugin repo
    function TEXT NOT NULL DEFAULT '', -- '' = the whole file
    source TEXT NOT NULL DEFAULT 'ai', -- ai | manual
    checked INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    UNIQUE (feature_id, file, function)
  );
  CREATE INDEX feature_code_project ON feature_code(project_id);
  `,

  // 8: screenshots of a feature. The image is in the database, so the one-file backup keeps it.
  //    A screenshot belongs to a feature, and can show one or more of its scopes.
  //    When a scope goes, the screenshot stays on the feature.
  //    AUTOINCREMENT: a deleted screenshot's ID never comes back, so a browser cache cannot show its old image.
  //    The image bytes are in their own table, so the feature list does not read them.
  `
  CREATE TABLE screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    caption TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL,               -- image/png | image/jpeg | image/webp | image/gif
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX screenshots_project ON screenshots(project_id, sort);
  CREATE INDEX screenshots_feature ON screenshots(feature_id);
  CREATE TABLE screenshot_images (
    screenshot_id INTEGER PRIMARY KEY REFERENCES screenshots(id) ON DELETE CASCADE,
    data BLOB NOT NULL
  );
  CREATE TABLE screenshot_scopes (
    screenshot_id INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
    scope_id INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    PRIMARY KEY (screenshot_id, scope_id)
  );
  CREATE INDEX screenshot_scopes_scope ON screenshot_scopes(scope_id);
  `,

  // 9: the AI skill can add screenshots too.
  //    source = manual (a person) or ai (the map-features skill). checked = 1: a person checked an AI screenshot.
  //    match_key: AI screenshots only. The first caption the skill sent, in a fixed form (captionKey).
  //      The skill finds its screenshots by this key, so a person can change the caption.
  //    removed = 1: a person deleted an AI screenshot. The row stays without its image and scope tags,
  //      so the skill does not add it again. A person's own upload is deleted fully.
  `
  ALTER TABLE screenshots ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE screenshots ADD COLUMN checked INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE screenshots ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE screenshots ADD COLUMN match_key TEXT;
  CREATE INDEX screenshots_match ON screenshots(feature_id, match_key);
  `,

  // 10: requirements: what must be true before a tester checks the feature (settings, data, the user).
  //     A feature's requirements apply to all its scopes. A scope has its own requirements too:
  //     feature_items rows with kind 'requirement' and scope_id set. Other kinds have no scope_id.
  //     The "needs" labels become feature requirements. A label was one or two words, and a requirement
  //     is a full sentence, so each item gets the AI mark: a person checks it, and the skill can correct it.
  `
  ALTER TABLE feature_items ADD COLUMN scope_id INTEGER REFERENCES scopes(id) ON DELETE CASCADE;
  CREATE INDEX feature_items_scope ON feature_items(scope_id);
  INSERT INTO feature_items (feature_id, kind, text, sort, ai_draft)
    SELECT feature_id, 'requirement', value, -1, 1 FROM feature_labels WHERE kind = 'needs' ORDER BY value COLLATE NOCASE;
  DELETE FROM feature_labels WHERE kind = 'needs';
  `,

  // 11: "rules" become "notes". A rule that a test can check belongs in a scope, so the
  //     app shows it as automated or not. Notes keep only what no test can check: reasons,
  //     facts about the code, known limits. Old rules keep their text. Each one gets the AI mark, also
  //     if a person checked it as a rule: a person checks it again as a note, and the skill can move a
  //     rule that a test can check to a scope and remove the note.
  `
  UPDATE feature_items SET kind = 'note', ai_draft = 1 WHERE kind = 'rule';
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
