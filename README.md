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

## Feature list

The "Features" tab holds the feature list: groups and features. A feature has:

- a title, a description, a group and a priority
- user roles and needs: short names that features share. Type to see the names that other features use. A name that no feature uses is gone.
- lists: where it is, rules, out of scope, open questions. Each list item is one sentence that you can change or remove.
- a scope: the separate things the feature does, like the scenarios of a test
- screenshots: images that show how the feature looks

Links:

- Each test links to a feature and to the scopes it checks. On a scope, click "+ Link a test". On a test page, use "Link to a scope".
- A test can check more than one scope.
- People make the links, or the AI skill makes them. `@feature:` tags in the tests do not make links.
- When you remove a link, the AI skill does not add it again.
- A scope with a Playwright test and a Cypress scenario shows "In both".
- Feature IDs (`F-…`) and scope IDs (`S-…`) are numbers. A new title keeps the ID.

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

### Fill the list with the AI skill

The Claude Code skill `map-features` (in `.claude/skills/`) writes a first draft of the list. It does one unit at a time: one Playwright spec file, one Cypress `.feature` file, or one plugin code area. It does all Playwright files first, then all Cypress files, then the plugin code that is left. Start Claude Code in this folder and say, for example, "map the next cypress file for wwp".

- The skill reads the tests and the plugin code. It can also run the test or try the feature in a browser.
- It adds to the features that exist before it makes new ones, and it links each test to the scopes it checks.
- It puts the plugin code of each feature (files or functions) in the feature, for "Code by feature".
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

## Make coverage data

The coverage trial uses the Local WP site `automation-tracker`. See `coverage/prepend.php`. Make one run for each test tool.

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
