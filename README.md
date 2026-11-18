# Automation Tracker

Shows which plugin code the automated tests run, lists the Cypress and Playwright tests, and links the tests to a feature list.

## Data

All data is in one SQLite file: `data/tracker.db`.

- Projects, code files, Playwright tests and Cypress scenarios. The app scans the plugin repo again when the last scan is older than 5 seconds.
- Coverage runs. The app imports a run folder again when `report.json` or `lines.json` changes.
- Features, abilities and links to tests. People type these in the app.

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

The "Features" tab holds the feature list: groups, features and abilities. An ability is one thing a user can do with the feature.

- A test with the tag `@feature:<name>` links to the feature that owns the tag name `<name>`. The first scan makes one feature for each tag name in the tests.
- A tag name that is new after the first scan does not make a feature. The tab lists it under "Feature tags with no feature".
- You can also link a test by hand, and put each link on an ability.
- An ability with a Playwright test and a Cypress scenario shows "In both".
- When you remove a link that came from a tag, a scan does not add it again.
- Feature IDs (`F-…`) and ability IDs (`A-…`) are numbers. A new title keeps the ID.

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
