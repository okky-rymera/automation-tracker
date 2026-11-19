# Automation Tracker

Shows which plugin code the automated tests run, lists the Cypress and Playwright tests, and links the tests to a feature list.

## Data

All data is in one SQLite file: `data/tracker.db`.

- Projects, code files, Playwright tests and Cypress scenarios. The app scans the plugin repo again when the last scan is older than 5 seconds.
- Coverage runs: one Playwright run and one Cypress run per project. The app imports a run folder again when `report.json` or `lines.json` changes.
- Features, scopes, screenshots and links to tests. People type these in the app, or the AI skill writes a draft.

WARNING: The database holds the only copy of the feature list and the links. Make a backup copy of `data/tracker.db` before large changes.

To make a backup while the app runs, use `sqlite3 data/tracker.db ".backup data/tracker-backup.db"`.

A scan never deletes a test. A test that is gone from the repo stays in the database as "removed", so its links stay visible. The feature page shows such a link with "not in repo now".

## Run the app

1. Install the packages: `npm install`
2. Start the app: `npm run dev`
3. Open http://localhost:5173

## Add a project

One project is one plugin. The first start copies `projects.json` into the database. After that, the database is the only list of projects. In `projects.json`, `coverageRun` and `coverageLabel` set the Playwright run, and `cypressRun` and `cypressLabel` set the Cypress run.

1. Add the project: `npm run project -- add <id> "<name>" <plugin path> --playwright <specs dir> --cypress <feature dir>`. The test folders are relative to the plugin repo.
2. Select a coverage run: `npm run project -- set-run <id> <run folder> "<label>" --framework playwright` (or `--framework cypress`). The run folder holds `report.json` and `lines.json` from `coverage/analyze.py`. Without `--framework`, the run is a Playwright run. Use a separate run folder for each test tool. The command refuses a folder that is already the run of the other tool.
3. Show the list: `npm run project -- list`.
4. To read the plugin from another folder, use `npm run project -- set-path <id> <plugin path>`. Use a separate copy of the plugin on trunk, so that your own branch work does not change the app. The test site must load the same copy: link the copy into the site's `wp-content/plugins`. The copy's folder name must be the plugin's folder name. `set-path` refuses a new folder name, unless you add `--rename` because the plugin folder in the site has the new name too.

## Feature list

The "Features" tab holds the feature list: groups and features. A feature has:

- a title, a description, a group and a priority
- user roles: short names that features share. Type to see the names that other features use. A name that no feature uses is gone.
- requirements: what must be true before you check the feature, for example a setting, some data or the user who is logged in. They apply to every scope.
- lists: where it is, notes, out of scope, open questions. Notes hold only what no test can check, for example why the feature works as it does. A rule that a test can check is a scope. Each list item is one sentence that you can change or remove.
- a scope: the separate things the feature does, like the scenarios of a test. A scope can have its own requirements too, for example "The hide setting is checked".
- screenshots: images that show how the feature looks

Links:

- Each test links to a feature and to the scopes it checks. On a scope, click "+ Link a test". On a test page, use "Link to a scope".
- A test can check more than one scope.
- People make the links, or the AI skill makes them. `@feature:` tags in the tests do not make links.
- When you remove a link, the AI skill does not add it again.
- A scope with a Playwright test and a Cypress scenario shows "In both".
- Feature IDs (`F-…`) and scope IDs (`S-…`) are numbers. A new title keeps the ID.
- To move a scope to another feature, use "Move to feature…" on the scope. Its requirements, test links and the screenshots that show only this scope go with it. The scope keeps its ID.
- The AI skill does not add again a scope that a person deleted or moved to another feature. To get such a scope back, add it with the same title. When you rename a scope, the skill still finds it by its old title.
- A target feature cannot get two scopes with the same title. Rename one of them before the move.
- A new scope never gets the ID of a deleted scope.

### Screenshots

A screenshot belongs to a feature. It can also show one or more scopes of the feature.

- To add a screenshot to the feature, use one of these:
  - Click "+ Add screenshot".
  - Drop image files on the box.
  - Click the box, then press Ctrl+V.
- To add a screenshot for one scope, click "+ Screenshot" on the scope. The screenshot gets that scope.
- To show which scopes a screenshot shows, add the scopes on the screenshot. The scope then shows a small copy of the image.
- Click an image to see it full size. Press Escape to close it.
- Use PNG, JPEG, WebP or GIF images of 10 MB or less.

The images are in the database file, so the backup command also saves them. When you delete a scope, its screenshots stay on the feature.

The AI skill also adds screenshots. It takes them with playwright-cli on the test site. Its screenshots show "AI draft". Click the mark, or change the caption or the scopes, to remove the mark. When you delete a screenshot, the skill does not add a screenshot with the same caption again.

### Fill the list with the AI skill

The Claude Code skill `map-features` (in `.claude/skills/`) writes a first draft of the list. It does one unit at a time: one Playwright spec file, one Cypress `.feature` file, or one plugin code area. It does all Playwright files first, then all Cypress files, then the plugin code that is left. Start Claude Code in this folder and say, for example, "map the next cypress file for wwp".

- The skill reads the tests and the plugin code. It can also run the test or try the feature in a browser.
- It adds to the features that exist before it makes new ones, and it links each test to the scopes it checks.
- It puts the plugin code of each feature (files or functions) in the feature, for "Code by feature".
- It adds 1 to 4 screenshots to each feature that has a screen.
- Text it writes shows "AI draft" in the app. Its links show "linked by AI". Click "Mark as checked", or change the text, to remove the mark.
- It does not change or remove text that a person wrote or checked. It does not add again a link that a person removed, and it does not change a link that a person made.
- It records each unit it did. A unit shows again when its files change.

The skill writes through `npm run -s map -- <command>` (see `server/map.ts`). To see the progress: `npm run -s map -- status <project>`.

## Coverage views

A project has one coverage run for each test tool.

- The cards at the top of a project page always use the two runs together. The Playwright card and the Cypress card show the coverage of each run alone.
- Each tab has two panes. Use the switch at the right of the tabs:
  - Features: "Feature list" or "Code by feature".
  - Playwright: "Tests" or "Code coverage" (the Playwright run only).
  - Cypress: "Scenarios" or "Code coverage" (the Cypress run only).
- "Code by feature" uses the two runs together. Purple marks the code that only Cypress tests run. Those Cypress tests are the next tests to convert to Playwright. When a Playwright test runs that code, it becomes green.

"Code by feature" shows the plugin code of each feature: whole files, or functions in a file. The AI skill puts the code in the features. To remove code from a feature, click × on its row. The skill does not add it again. "Code in no feature" lists the feature lines that no feature holds. One line can be in more than one feature, and the totals count it one time.

When the app puts the two runs together:

- A line is library code when it is library code in one of the runs.
- Else the line gets the state that says the most: run by tests, then setup only, then never run.
- The feature page shows the functions that only the linked Cypress tests run.

WARNING: Make the two runs at the same plugin commit. Line numbers change when the code changes. The app shows a warning when the commits are not the same.

## Sync with new plugin code

A sync gets the latest commits of the remote branch into the tracker's own copy of the plugin. Then it writes a change report, and it runs the Playwright tests with coverage when the code changed. The plan is in `docs/sync-plan.md`.

WARNING: A sync changes the files of the copy. Turn it on only for the tracker's own copy, never for a working copy.

1. Turn on the sync: `npm run project -- set-sync <id> --branch trunk --site http://automation-tracker.local`. The site must be a local site (`localhost`, `*.local` or `*.localhost`). To turn it off, add `--off`.
2. Sync from the app: click "Sync now" on the project page. Or use the command line: `npm run project -- sync <id> [--tests auto|always|never]`.
3. Click "Show report" to see the change report of the last sync.

What a sync does:

1. It checks the copy. It stops when the copy is not on the sync branch, has changed files, or has commits that are not on the remote branch.
2. It gets the new commits (`git fetch`, then `git merge --ff-only`). It never runs `git clean`, so `.env` and `node_modules` stay.
3. It runs `npm ci` in the Playwright folder when the package files changed. When the Playwright version changed, it installs the Chromium browser.
4. It reads the files and tests again.
5. It writes the change report from the old commit to the new commit:
   - changed files and changed PHP functions (comments and white space do not count)
   - tests added, changed and removed
   - likely renamed tests: a new title or file gives a new test ID, and the links stay on the old ID. Click "Move links to the new test" to move them.
   - feature code that is not in the code now (file or function gone)
   - features to review: their linked tests or their code changed
6. It runs the tests, by the "Tests" choice:
   - "when code changed" (auto): when PHP code or Playwright files changed since the commit of the selected Playwright run.
   - "always" or "never".

The test run uses the Local site, 1 worker and `ECHOWP=false`, also when the copy's `.env` says `ECHOWP=true`. It empties `coverage-data/raw/`, runs the baseline page loads, runs the tests, and writes a new run folder in `data/projects/<id>/runs/`. The app selects the new run only when the report has tests and some tests passed. Else the old run stays selected. Only one test run can run at a time.

Keep the test site idle during the test run. Page loads outside a test count as test setup.

Each command of a sync runs without a terminal, with `coverage/no-sudo/` first in `PATH`. That folder holds stubs for `sudo`, `su`, `doas`, `pkexec` and `echowp` that only fail. So new trunk code cannot ask for a password.

To see the change report between any two commits: `npm run -s project -- changes <id> <old commit> <new commit> [--json]`.

## Make coverage data

The coverage trial uses the Local WP site `automation-tracker`. See `coverage/prepend.php`. Make one run for each test tool.

The recorder records only the plugins in `coverage/plugins.json`. The commands `add` and `set-path` write this file from the projects. To write it again, run `npm run project -- coverage-config`. The recorder finds each plugin in the site's `wp-content/plugins`, also through a link. Each request file keeps the lines of each plugin apart.

1. Empty `coverage-data/raw/` first. (The database is in `data/`, not in `coverage-data/`.) The Local site records every page load, and loads outside a test count as setup.
2. Run the baseline page loads: `coverage/baseline.sh <site url> <admin user> <admin password>`. The code that runs there is library code.
3. Run the tests of one tool:
   - Playwright: run the tests with `--reporter=list,<this repo>/coverage/test-window-reporter.cjs` and 1 worker.
   - Cypress: run `npx cypress run` in the plugin's Cypress folder. The Cypress tests run one at a time. Then run `python3 coverage/cypress-windows.py <Cypress folder>/report/json/cucumber-messages.ndjson`. It writes `coverage-data/test-windows.json` from the start and end times in the Cypress report. The `messages` output of the Cucumber preprocessor must be on (it is on in the plugin's `package.json`).
4. Copy `coverage-data/raw/` and `coverage-data/test-windows.json` into a run folder.
5. Run `python3 coverage/analyze.py <plugin path> <run folder>`. It leaves out the folders in `coverage/exclude-dirs.json`, the same list as the app's file list. If the project has its own folder list, add `--exclude <a,b,c>`.
6. Save the plugin commit in `<run folder>/run-info.json` (`pluginCommit`, `pluginDirty`). The app warns when the plugin code changed after the run.
7. Select the run: `npm run project -- set-run <id> <run folder> "<label>" --framework <playwright|cypress>`.

Setup requests do not count as tested code. These are setup requests: the Test Helper Plugin (`/wp-json/thp/`, used by Playwright), the Cypress Helper Plugin (`/wp-json/chp/`) and the login page.

NOTE: Some Cypress tests make their test data through the WooCommerce or plugin REST API (`/wp-json/wc/`, `/wp-json/wholesale/`). These requests count as tested code, because API tests use the same routes. So the Cypress run can show more tested code than the Cypress tests really check.

PHP files that no request loaded still count. `analyze.py` counts their runnable lines without running the code (`coverage/runnable-lines.php`, through `coverage/php-xdebug.sh`), and all of those lines count as never run.

The coverage script turns off OPcache for each request. With OPcache on, Xdebug does not report the skipped lines inside functions that ran.

Test IDs (`PW-…`, `CY-…`) come from the file path and the title. A rename gives a new ID.

## Check the parsers

Run `npm run check-parsers`. It compares the parsed tests and totals with the coverage runs. It also checks that each test in the Cypress run matches one scenario.
