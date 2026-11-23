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

  // 12: scopes that a person deleted or moved to another feature. The AI skill finds scopes by title,
  //     so without this it makes the scope again on the old feature. One row per feature and title.
  //     moved_to = NULL: deleted. A person who adds the title to the feature again clears the row.
  `
  CREATE TABLE scope_tombstones (
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    title_key TEXT NOT NULL,          -- lower(trim(title))
    scope_id INTEGER NOT NULL,        -- no foreign key: a deleted scope is gone
    moved_to INTEGER REFERENCES features(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (feature_id, title_key)
  );
  CREATE INDEX scope_tombstones_scope ON scope_tombstones(scope_id);
  `,

  // 13: one row per old title of each scope, so a second delete of the same title keeps the first.
  //     Also for a rename. No moved_to: the scope's feature now says where it went (or that it is gone),
  //     also after a merge. A live scope with the title wins, so a person who adds it again needs no clear.
  `
  CREATE TABLE scope_titles_gone (
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    scope_id INTEGER NOT NULL,        -- no foreign key: a deleted scope is gone
    title_key TEXT NOT NULL,          -- lower(trim(title))
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (feature_id, scope_id, title_key)
  );
  CREATE INDEX scope_titles_gone_title ON scope_titles_gone(feature_id, title_key);
  INSERT INTO scope_titles_gone (feature_id, scope_id, title_key, created_at)
    SELECT feature_id, scope_id, title_key, created_at FROM scope_tombstones;
  DROP TABLE scope_tombstones;
  `,

  // 14: sync of the tracker's own plugin copy with the remote branch.
  //     sync_branch: NULL = sync is off. Sync changes the files of the copy (git merge --ff-only), so turn it on only for the tracker's copy.
  //     site_url: the local test site that the test run uses.
  //     synced_commit / synced_at: the commit of the last sync that got the code.
  //     syncs: one row for each sync, with its change report (JSON) and the coverage run it made.
  //     owner_pid: the process that runs the sync. A row that is "running" with a dead owner was interrupted.
  `
  ALTER TABLE projects ADD COLUMN sync_branch TEXT;
  ALTER TABLE projects ADD COLUMN site_url TEXT;
  ALTER TABLE projects ADD COLUMN synced_commit TEXT;
  ALTER TABLE projects ADD COLUMN synced_at TEXT;
  CREATE TABLE syncs (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,             -- running | done | failed | interrupted | cancelled
    step TEXT NOT NULL DEFAULT '',
    owner_pid INTEGER,
    from_commit TEXT,
    to_commit TEXT,
    report TEXT,                      -- JSON change report (server/changes.ts)
    tests TEXT,                       -- JSON result of the test run, or why it did not run
    run_dir TEXT,                     -- the coverage run folder that this sync made
    log TEXT NOT NULL DEFAULT '',
    error TEXT
  );
  CREATE INDEX syncs_project ON syncs(project_id, id);
  `,
  // 15: AI updates: one row for each feature that headless Claude checked after a code change
  //     (server/ai-update.ts). It keeps the answer, the cost, and what the save kept or changed.
  `
  CREATE TABLE ai_updates (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    feature_id INTEGER NOT NULL,      -- no foreign key: the row stays when the feature is deleted
    sync_id INTEGER,                  -- the sync whose change report started it, or NULL (command line)
    from_commit TEXT NOT NULL,
    to_commit TEXT NOT NULL,
    model TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,             -- running | no-change | applied | proposed | failed
    cost_usd REAL,
    duration_ms INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    proposal TEXT,                    -- JSON answer of the model
    apply_report TEXT,                -- JSON lines of "map apply": what it saved and what it kept
    error TEXT
  );
  CREATE INDEX ai_updates_project ON ai_updates(project_id, id);
  `,
  // 16: who runs an AI update, so that each process (server or command line) sees a running update,
  //     and a later process can mark an update as stopped and end its claude run.
  //     New status "waiting": a feature that waits for its turn in a running update.
  `
  ALTER TABLE ai_updates ADD COLUMN owner_pid INTEGER;   -- the process that runs the update
  ALTER TABLE ai_updates ADD COLUMN claude_pid INTEGER;  -- the claude run of this feature, while it runs
  UPDATE ai_updates SET status = 'failed', error = 'The update stopped before the end' WHERE status = 'running';
  `,
  // 17: open questions that an AI skill answered or removed (server/map.ts, removeAnswered and removeItems).
  //     The question row is deleted. Its text stays here, so the AI skills do not ask it again on this feature.
  `
  CREATE TABLE answered_questions (
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    text_key TEXT NOT NULL,           -- lower(trim(text))
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (feature_id, text_key)
  );
  `,
  // 18 and 19: empty. Drafts of the scope groups used them, and the tracker database ran them,
  // so the numbers stay. Step 20 makes the scope groups.
  'SELECT 1;',
  'SELECT 1;',
  // 20: scope groups: a feature's scopes show under their group, like the describe blocks of tests.
  //     A group belongs to one feature. A person can add a group before it has scopes.
  //     Deleting a group keeps its scopes, with no group (ON DELETE SET NULL).
  //     group_by_person = 1: a person chose the group of the scope, or chose no group.
  //       The AI skills do not change it (map.ts writeScopeGroup).
  //     scope_group_titles_gone: old titles of groups that a person renamed (group_id = the group now)
  //       or deleted (group_id NULL). A person who adds a group with the title again removes the row.
  `
  CREATE TABLE scope_groups (
    id INTEGER PRIMARY KEY,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX scope_groups_feature ON scope_groups(feature_id);
  ALTER TABLE scopes ADD COLUMN group_id INTEGER REFERENCES scope_groups(id) ON DELETE SET NULL;
  ALTER TABLE scopes ADD COLUMN group_by_person INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE scope_group_titles_gone (
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    title_key TEXT NOT NULL,          -- lower(trim(title))
    group_id INTEGER REFERENCES scope_groups(id) ON DELETE SET NULL,
    PRIMARY KEY (feature_id, title_key)
  );
  `,
  // 21: ai_made = 1: an AI skill made the group, and no person changed it.
  //     When the AI moves the last scope out of such a group, the group goes (features.ts dropEmptyAiGroup).
  //     A group that a person made or changed stays, also with no scopes.
  //     Groups from before: AI-made when each of their scopes has an AI draft group and no person renamed them.
  `
  ALTER TABLE scope_groups ADD COLUMN ai_made INTEGER NOT NULL DEFAULT 0;
  UPDATE scope_groups SET ai_made = 1
  WHERE EXISTS (SELECT 1 FROM scopes s WHERE s.group_id = scope_groups.id)
    AND NOT EXISTS (SELECT 1 FROM scopes s WHERE s.group_id = scope_groups.id AND instr(s.ai_fields, '"group"') = 0)
    AND NOT EXISTS (SELECT 1 FROM scope_group_titles_gone t WHERE t.group_id = scope_groups.id);
  `,
  // 22: review state of a feature, and the mapping loop (server/map-loop.ts).
  //     reviewed_at: when a person last reviewed the feature ("Mark as reviewed", or the last AI mark cleared).
  //       NULL: no person reviewed it yet. Features with no AI marks now count as reviewed.
  //     ai_changed_at: when an AI skill last saved something in the feature (map.ts apply).
  //     The state comes from these and the AI marks: new (never reviewed), changed (reviewed, and AI marks
  //     are open again), reviewed (no open AI marks).
  //     map_loops: one row for each start of the loop. map_runs: one row for each unit that headless Claude mapped.
  `
  ALTER TABLE features ADD COLUMN reviewed_at TEXT;
  ALTER TABLE features ADD COLUMN ai_changed_at TEXT;
  UPDATE features SET reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE ai_fields = '[]'
    AND NOT EXISTS (SELECT 1 FROM feature_items i WHERE i.feature_id = features.id AND i.ai_draft = 1)
    AND NOT EXISTS (SELECT 1 FROM scopes s WHERE s.feature_id = features.id AND s.ai_fields <> '[]')
    AND NOT EXISTS (SELECT 1 FROM links l WHERE l.feature_id = features.id AND l.source = 'ai' AND l.checked = 0 AND l.removed = 0)
    AND NOT EXISTS (SELECT 1 FROM feature_code c WHERE c.feature_id = features.id AND c.source = 'ai' AND c.checked = 0 AND c.removed = 0)
    AND NOT EXISTS (SELECT 1 FROM screenshots x WHERE x.feature_id = features.id AND x.source = 'ai' AND x.checked = 0 AND x.removed = 0);
  CREATE TABLE map_loops (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,             -- running | done | stopped | failed
    started_by TEXT NOT NULL,         -- app | cli | sync
    model TEXT NOT NULL,
    unit_budget_usd REAL NOT NULL,    -- spend limit for one unit (list price)
    total_budget_usd REAL NOT NULL,   -- spend limit for the whole loop (list price)
    max_units INTEGER NOT NULL,
    stop_reason TEXT,
    owner_pid INTEGER
  );
  CREATE INDEX map_loops_project ON map_loops(project_id, id);
  CREATE TABLE map_runs (
    id INTEGER PRIMARY KEY,
    loop_id INTEGER NOT NULL REFERENCES map_loops(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    unit_kind TEXT NOT NULL,          -- playwright | cypress | code
    unit_ref TEXT NOT NULL,           -- for code: the candidate file that "next" gave first
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,             -- running | done | skipped | failed
    cost_usd REAL,
    duration_ms INTEGER,
    features TEXT,                    -- JSON list of feature IDs the unit saved to
    report TEXT NOT NULL DEFAULT '',  -- the final message of the run (what it did, open questions)
    error TEXT,
    claude_pid INTEGER
  );
  CREATE INDEX map_runs_loop ON map_runs(loop_id, id);
  `,
  // 23: the first form of step 22 wrote reviewed_at as "YYYY-MM-DD HH:MM:SS" (UTC, no zone). The app
  //     reads such a value as local time. Write it in the ISO form of now(), with "Z".
  `
  UPDATE features SET reviewed_at = replace(reviewed_at, ' ', 'T') || '.000Z' WHERE reviewed_at NOT LIKE '%Z';
  `,
  // 24: the mapping loop uses the claude.ai plan, with no dollar limits. It stops at the plan limit.
  `
  ALTER TABLE map_loops DROP COLUMN unit_budget_usd;
  ALTER TABLE map_loops DROP COLUMN total_budget_usd;
  `,
  // 25: review_wanted = 1: a person used "Mark as not reviewed". The feature shows as not reviewed
  //     until a person uses "Mark as reviewed" again. A change that clears the last AI mark does not
  //     mark it as reviewed (sweepReviewed).
  `
  ALTER TABLE features ADD COLUMN review_wanted INTEGER NOT NULL DEFAULT 0;
  `,
  // 26: hand marks on code lines. A person marks a runnable line as library code (it runs on every
  //     request) or as covered (a test checks it, but coverage did not see it). text: the trimmed
  //     line when it was marked. When the line text is not the same now, the mark is stale and does not count.
  `
  CREATE TABLE line_marks (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('library', 'covered')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, file, line)
  );
  `,
  // 27: the value of a field before the AI skill changed it, so a person can see it and change it back.
  //     One row per field, kept until the AI mark of the field goes. kind: feature, scope or item.
  //     field: title, description, priority, group (group_id as text, NULL: no group), or text (items).
  `
  CREATE TABLE ai_before (
    kind TEXT NOT NULL CHECK (kind IN ('feature', 'scope', 'item')),
    row_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    before TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (kind, row_id, field)
  );
  `,
  // 28: the result of the Cypress test run of a sync (server/cypress-run.ts), as JSON. tests holds the Playwright result.
  `
  ALTER TABLE syncs ADD COLUMN cypress_tests TEXT;
  `,
  // 29: decisions on whole functions that no test runs (server/code-decisions.ts). kind library: the
  //     function is library code (startup, helpers, glue), not feature code. The coverage data counts
  //     its lines as library, as a library line mark does. by: ai (the map-features skill) or person.
  //     The function is kept by name, so a decision stays when the function moves.
  `
  CREATE TABLE code_decisions (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    function TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('library')),
    reason TEXT NOT NULL,
    by TEXT NOT NULL CHECK (by IN ('ai', 'person')),
    commit_sha TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, file, function)
  );
  `,
  // 30: the automatic AI flow (docs/sync-plan.md phase 8).
  //  test_left_out: tests that the AI (or a feature delete of a person) left out of each feature on
  //    purpose, with the reason. "map next" does not give their file again for them.
  //  code_scopes: the scopes of a mapped code entry, like link_scopes for a test link.
  //  parked_units: mapping units that failed 2 times in one loop. "map next" skips them while the
  //    hash of their files stays the same.
  //  ai_review_pending: features that the AI update could not check (failed, or stopped by the plan
  //    limit), with the commit to compare from. fails counts the failed days; at 2 the feature is parked.
  //  projects.ai_reviewed_commit: the commit up to which the AI update checked the changes.
  `
  CREATE TABLE test_left_out (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    test_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    by TEXT NOT NULL CHECK (by IN ('ai', 'person')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, test_id)
  );
  CREATE TABLE code_scopes (
    code_id INTEGER NOT NULL REFERENCES feature_code(id) ON DELETE CASCADE,
    scope_id INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    PRIMARY KEY (code_id, scope_id)
  );
  CREATE INDEX code_scopes_scope ON code_scopes(scope_id);
  CREATE TABLE parked_units (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    parked_at TEXT NOT NULL,
    PRIMARY KEY (project_id, kind, ref)
  );
  CREATE TABLE ai_review_pending (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    from_commit TEXT NOT NULL,
    fails INTEGER NOT NULL DEFAULT 0,
    last_fail_day TEXT,
    last_error TEXT,
    PRIMARY KEY (project_id, feature_id)
  );
  ALTER TABLE projects ADD COLUMN ai_reviewed_commit TEXT;
  `,
  // 31: settings of the whole tracker that a person changes on the Settings screen (server/settings.ts).
  //     value is JSON. An environment variable wins over the row.
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 32: the short coverage runs of the mapping loop (server/map-loop.ts coverageFirst). One row for
  //     each test file that had one, with the hash of its files then. "map next" does not ask for a
  //     run again while the hash stays the same, also when the run did not fill the gap.
  `
  CREATE TABLE coverage_tries (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    hash TEXT NOT NULL,
    tried_at TEXT NOT NULL,
    PRIMARY KEY (project_id, kind, ref)
  );
  `,
  // 33: "To remove" mark on a feature or a scope: it must go, with its tests, but its links stay until then.
  //     remove_reason NULL = no mark. remove_by = person | ai (an AI that a person asked to set the mark).
  //     A marked item is not in the coverage counts, and the AI skills do not add links or code to it.
  `
  ALTER TABLE features ADD COLUMN remove_reason TEXT;
  ALTER TABLE features ADD COLUMN remove_at TEXT;
  ALTER TABLE features ADD COLUMN remove_by TEXT;
  ALTER TABLE scopes ADD COLUMN remove_reason TEXT;
  ALTER TABLE scopes ADD COLUMN remove_at TEXT;
  ALTER TABLE scopes ADD COLUMN remove_by TEXT;
  `,
  // 34: scope sets. One check in several places (for example on 4 pages) is one sentence with a table
  //     of values. Each row is a normal scope with its own S-id, test links and coverage. The set is
  //     not a scope, so it never counts as a scope with no test.
  //     scope_sets.title: the shared sentence. column_name: the name of the value column ("Page").
  //     ai_made = 1: an AI skill made the set, and no person changed it.
  //     scopes.set_value: the value of the row, for example "Cart page".
  //     scopes.set_by_person = 1: a person put the scope in a set or took it out. The AI skills do not change it.
  `
  CREATE TABLE scope_sets (
    id INTEGER PRIMARY KEY,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    column_name TEXT NOT NULL DEFAULT 'Page',
    sort INTEGER NOT NULL DEFAULT 0,
    ai_made INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX scope_sets_feature ON scope_sets(feature_id);
  ALTER TABLE scopes ADD COLUMN set_id INTEGER REFERENCES scope_sets(id) ON DELETE SET NULL;
  ALTER TABLE scopes ADD COLUMN set_value TEXT;
  ALTER TABLE scopes ADD COLUMN set_by_person INTEGER NOT NULL DEFAULT 0;
  `,
  // 35: a scope set can have more than one column, with names that a person or the AI chooses.
  //     scope_sets.columns: the column names, in order, as a JSON list.
  //     scopes.set_values: the values of the row, one for each column, in column order, as a JSON list.
  //     An empty value means that the column does not apply to the row.
  `
  ALTER TABLE scope_sets ADD COLUMN columns TEXT NOT NULL DEFAULT '["Page"]';
  UPDATE scope_sets SET columns = json_array(column_name);
  ALTER TABLE scope_sets DROP COLUMN column_name;
  ALTER TABLE scopes ADD COLUMN set_values TEXT;
  UPDATE scopes SET set_values = json_array(set_value) WHERE set_value IS NOT NULL;
  ALTER TABLE scopes DROP COLUMN set_value;
  `,
  // 36: a scope set has the shared text of its rows: a description, and requirements that are true for
  //     each row (feature_items rows with kind 'set_requirement' and set_id). A row has no description of
  //     its own, and keeps only the requirements that the other rows do not have.
  //     scope_sets.ai_fields: ["description"] when the AI wrote the description and no person checked it.
  `
  ALTER TABLE scope_sets ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE scope_sets ADD COLUMN ai_fields TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE feature_items ADD COLUMN set_id INTEGER REFERENCES scope_sets(id) ON DELETE CASCADE;
  CREATE INDEX feature_items_set ON feature_items(set_id);
  `,
  // 37: one kind of thing: a scope. A scope can have variations (one check in several places, for example
  //     on 4 pages). The scope keeps the sentence, the description, the requirements and the group, and has
  //     the column names (scopes.columns, a JSON list; NULL: no variations). Each variation is a scopes row
  //     with parent_id and var_values (one value for each column). A variation has the test links,
  //     screenshots, code and coverage. Its ID shows as SV-<id>.
  //     Each scope set of step 34 becomes a scope with a new S-id, and its rows become its variations. The set
  //     description, AI mark and requirements go to that scope, and also the requirements of each row. Each
  //     variation gets the title "<scope title> (<values>)". The title of a variation comes from its scope, so
  //     "Change back" has no old title, group or description for a variation.
  //     scope_sets, scopes.set_id and feature_items.set_id are not used now. SQLite cannot drop them: a
  //     foreign key points to scope_sets. They stay empty.
  `
  ALTER TABLE scopes ADD COLUMN columns TEXT;
  ALTER TABLE scopes ADD COLUMN parent_id INTEGER REFERENCES scopes(id);
  CREATE INDEX scopes_parent ON scopes(parent_id);
  ALTER TABLE scopes RENAME COLUMN set_values TO var_values;
  CREATE TEMP TABLE set_parent AS
    SELECT ss.id AS set_id,
      (SELECT MAX(COALESCE((SELECT MAX(id) FROM scopes), 0), COALESCE((SELECT MAX(scope_id) FROM scope_titles_gone), 0))) + ROW_NUMBER() OVER (ORDER BY ss.id) AS scope_id
    FROM scope_sets ss;
  INSERT INTO scopes (id, feature_id, title, description, group_id, group_by_person, sort, ai_fields, columns)
    SELECT sp.scope_id, ss.feature_id, ss.title, ss.description,
      (SELECT r.group_id FROM scopes r WHERE r.set_id = ss.id ORDER BY r.sort, r.id LIMIT 1),
      COALESCE((SELECT MAX(r.group_by_person) FROM scopes r WHERE r.set_id = ss.id), 0),
      COALESCE((SELECT MIN(r.sort) FROM scopes r WHERE r.set_id = ss.id), 0),
      ss.ai_fields, ss.columns
    FROM scope_sets ss JOIN set_parent sp ON sp.set_id = ss.id;
  UPDATE scopes SET parent_id = (SELECT scope_id FROM set_parent WHERE set_id = scopes.set_id) WHERE set_id IS NOT NULL;
  UPDATE scopes SET columns = NULL WHERE columns IS NOT NULL AND NOT EXISTS (SELECT 1 FROM scopes v WHERE v.parent_id = scopes.id);
  UPDATE feature_items SET scope_id = (SELECT scope_id FROM set_parent WHERE set_id = feature_items.set_id), kind = 'requirement' WHERE set_id IS NOT NULL;
  UPDATE feature_items SET set_id = NULL WHERE set_id IS NOT NULL;
  -- A variation has no requirements: the requirements of a row go to its scope. The same text goes only one time.
  DELETE FROM feature_items WHERE scope_id IN (SELECT id FROM scopes WHERE parent_id IS NOT NULL) AND EXISTS (
    SELECT 1 FROM scopes v JOIN feature_items o ON o.kind = feature_items.kind AND lower(trim(o.text)) = lower(trim(feature_items.text))
      AND (o.scope_id = v.parent_id OR (o.id < feature_items.id AND o.scope_id IN (SELECT id FROM scopes w WHERE w.parent_id = v.parent_id)))
    WHERE v.id = feature_items.scope_id);
  UPDATE feature_items SET scope_id = (SELECT parent_id FROM scopes WHERE id = feature_items.scope_id)
    WHERE scope_id IN (SELECT id FROM scopes WHERE parent_id IS NOT NULL);
  -- The title of an AI-made set is an AI draft on its scope.
  UPDATE scopes SET ai_fields = (SELECT json_group_array(value) FROM (SELECT value FROM json_each(scopes.ai_fields) UNION SELECT 'title'))
    WHERE id IN (SELECT sp.scope_id FROM set_parent sp JOIN scope_sets ss ON ss.id = sp.set_id WHERE ss.ai_made = 1);
  -- A variation title is "<scope title> (<values>)". The old row title is remembered, as in a rename.
  CREATE TEMP TABLE var_title AS
    SELECT v.id, v.feature_id, v.title AS old, p.title || COALESCE(' (' || (SELECT group_concat(value, ', ') FROM json_each(COALESCE(v.var_values, '[]')) WHERE value <> '') || ')', '') AS new
    FROM scopes v JOIN scopes p ON p.id = v.parent_id;
  INSERT OR IGNORE INTO scope_titles_gone (feature_id, scope_id, title_key) SELECT feature_id, id, lower(trim(old)) FROM var_title WHERE lower(old) <> lower(new);
  UPDATE scopes SET title = (SELECT new FROM var_title WHERE var_title.id = scopes.id) WHERE id IN (SELECT id FROM var_title);
  DROP TABLE temp.var_title;
  UPDATE scopes SET set_id = NULL WHERE set_id IS NOT NULL;
  DELETE FROM scope_sets;
  DROP INDEX feature_items_set;
  ALTER TABLE scopes DROP COLUMN set_by_person;
  DROP TABLE temp.set_parent;
  UPDATE scopes SET ai_fields = COALESCE((SELECT json_group_array(value) FROM json_each(scopes.ai_fields) WHERE value <> 'group'), '[]') WHERE parent_id IS NOT NULL;
  DELETE FROM ai_before WHERE kind = 'scope' AND field IN ('group', 'title', 'description') AND row_id IN (SELECT id FROM scopes WHERE parent_id IS NOT NULL);
  `,
];

function open(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  // A step can delete data (for example a dropped column). The database is the only copy of the
  // tracker data, so make a backup before the steps of an existing database run.
  if (version > 0 && version < MIGRATIONS.length) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
    const backup = path.join(path.dirname(DB_FILE), `tracker-backup-${stamp}-before-migration-${version + 1}.db`);
    if (!fs.existsSync(backup)) db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
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
