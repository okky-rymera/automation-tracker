# Automation Tracker

Shows which plugin code the automated tests run, lists the Cypress and Playwright tests, and links the tests to a feature list.

## Data

All data is in one SQLite file: `data/tracker.db`.

- Projects, code files, Playwright tests and Cypress scenarios. The app scans the plugin repo again when the last scan is older than 5 seconds.
- Coverage runs. The app imports a run folder again when `report.json` or `lines.json` changes.
- Features, scopes and links to tests. People type these in the app, or the AI skill writes a draft.

WARNING: The database holds the only copy of the feature list and the links. Make a backup copy of `data/tracker.db` before large changes.

To make a backup while the app runs, use `sqlite3 data/tracker.db ".backup data/tracker-backup.db"`.

A scan never deletes a test. A test that is gone from the repo stays in the database as "removed", so its links stay visible. The feature page shows such a link with "not in repo now".

## Run the app

1. Install the packages: `npm install`
2. Start the app: `npm run dev`
3. Open http://localhost:5173

## Add a project

One project is one plugin. The first start copies `projects.json` into the database. After that, the database is the only list of projects.

1. Add the project: `npm run project -- add <id> "<name>" <plugin path> --playwright <specs dir> --cypress <feature dir>`. The test folders are relative to the plugin repo.
2. Select a coverage run: `npm run project -- set-run <id> <run folder> "<label>"`. The run folder holds `report.json` and `lines.json` from `coverage/analyze.py`.
3. Show the list: `npm run project -- list`.

## Feature list

The "Features" tab holds the feature list: groups and features. A feature has:

- a title, a description, a group and a priority
- user roles and needs: short names that features share. Type to see the names that other features use. A name that no feature uses is gone.
- lists: where it is, rules, out of scope, open questions. Each list item is one sentence that you can change or remove.
- a scope: the separate things the feature does, like the scenarios of a test

Links:

- Each test links to a feature and to the scopes it checks. On a scope, click "+ Link a test". On a test page, use "Link to a scope".
- A test can check more than one scope.
- People make the links, or the AI skill makes them. `@feature:` tags in the tests do not make links.
- When you remove a link, the AI skill does not add it again.
- A scope with a Playwright test and a Cypress scenario shows "In both".
- Feature IDs (`F-…`) and scope IDs (`S-…`) are numbers. A new title keeps the ID.

### Fill the list with the AI skill

The Claude Code skill `map-features` (in `.claude/skills/`) writes a first draft of the list. It does one unit at a time: one Playwright spec file, one Cypress `.feature` file, or one plugin code area. Start Claude Code in this folder and say, for example, "map the next cypress file for wwp".

- The skill reads the tests and the plugin code. It can also run the test or try the feature in a browser.
- It adds to the features that exist before it makes new ones, and it links each test to the scopes it checks.
- Text it writes shows "AI draft" in the app. Its links show "linked by AI". Click "Mark as checked", or change the text, to remove the mark.
- It does not change or remove text that a person wrote or checked. It does not add again a link that a person removed, and it does not change a link that a person made.
- It records each unit it did. A unit shows again when its files change.

The skill writes through `npm run -s map -- <command>` (see `server/map.ts`). To see the progress: `npm run -s map -- status <project>`.

## Make coverage data

The coverage trial uses the Local WP site `automation-tracker`. See `coverage/prepend.php`.

1. Empty `coverage-data/raw/` first. (The database is in `data/`, not in `coverage-data/`.) The Local site records every page load, and loads outside a test count as setup.
2. Run the baseline page loads: `coverage/baseline.sh <site url> <admin user> <admin password>`. The code that runs there is library code.
3. Run the Playwright tests with `--reporter=list,<this repo>/coverage/test-window-reporter.cjs` and 1 worker.
4. Copy `coverage-data/raw/` and `coverage-data/test-windows.json` into a run folder.
5. Run `python3 coverage/analyze.py <plugin path> <run folder>`. It leaves out the folders in `coverage/exclude-dirs.json`, the same list as the app's file list. If the project has its own folder list, add `--exclude <a,b,c>`.
6. Save the plugin commit in `<run folder>/run-info.json` (`pluginCommit`, `pluginDirty`). The app warns when the plugin code changed after the run.

PHP files that no request loaded still count. `analyze.py` counts their runnable lines without running the code (`coverage/runnable-lines.php`, through `coverage/php-xdebug.sh`), and all of those lines count as never run.

The coverage script turns off OPcache for each request. With OPcache on, Xdebug does not report the skipped lines inside functions that ran.

Test IDs (`PW-…`, `CY-…`) come from the file path and the title. A rename gives a new ID.

## Check the parsers

Run `npm run check-parsers`. It compares the parsed tests and totals with the coverage run.
