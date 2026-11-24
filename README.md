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

The code work comes from the code, not from a list of files that the AI looked at (`server/code-work.ts`). Each PHP function, and the code outside all functions of each file, must be in a feature or have a decision: library (start-up, helpers, glue) or unused (no plugin code loads or calls it). The app makes the guard lines (`defined( 'ABSPATH' )`) and blank lines library itself. The app keeps a content fingerprint of each sorted function (`server/code-fingerprint.ts`). After a sync, only the code that changed goes back to the AI, as "check". A save that leaves code of its files unsorted is refused, and a code unit cannot be skipped. `npm run -s check-fingerprint -- <project>` checks the fingerprints.

- The skill reads the tests and the plugin code. It can also run the test or try the feature in a browser.
- It adds to the features that exist before it makes new ones, and it links each test to the scopes it checks.
- It puts the plugin code of each feature (files or functions) in the feature, for "Code by feature".
- It adds 1 to 4 screenshots to each feature that has a screen.
- Text it writes shows "AI draft" in the app. Its links show "linked by AI". Click the mark, or change the text, to remove the mark. "Mark as reviewed" on a feature removes all its marks.
- It does not change or remove text that a person wrote or checked. It does not add again a link that a person removed, and it does not change a link that a person made.
- It records each unit it did. A unit shows again when its files change.
- It decides each test of a file: a link to the scopes it checks, or "left out" with a reason (a setup file, a helper). A done file comes back when it has a test with no link and no "left out" row. The Code screen lists the left-out tests, with a Remove button. When you delete a feature, its tests are left out too, so the AI does not make the feature again.
- It names the scopes of each code entry. A scope with code but no linked test shows "Code, no test" on the feature page, and the Tests screen lists these scopes under "Scopes to write tests for". You can change the scopes of a code entry on the feature's Code tab.

The skill writes through `npm run -s map -- <command>` (see `server/map.ts`). To see the progress: `npm run -s map -- status <project>`.

### Let Claude map the list without you

Features tab > "Map with AI" > "Start mapping". Claude Code runs the skill headless (`claude -p`), one unit after the other, with your claude.ai login. You can also start it on the command line: `npm run project -- map-loop <project> [--units 10] [--model opus]`.

- It stops when no unit is left, at the unit limit, or when you click "Stop". When a unit takes more than 60 minutes, the loop stops it, and the unit counts as failed.
- A unit that fails two times in one loop is parked, and the loop goes on with the next unit. A parked unit waits until its files change. The "Map with AI" screen lists the parked units, with "Try again".
- Before a Playwright file whose tests are not in the coverage run (a new file that no sync ran yet), the loop makes a short coverage run of that file. The new run keeps the other tests of the selected run, as a partial sync does.
- It uses your Claude plan, so it has no dollar limit.
- At the 5-hour or weekly limit of the plan, the loop stops the unit at once and ends. It does the same when the run starts to use paid extra usage.
- The loop does not save the stopped unit. That unit runs again at the next start. The loop shows when the limit resets.
- A limit of one model (for example the weekly Opus limit) stops only a loop that uses that model.
- It can use only the read tools, the `map` steps of the skill, the `run-spec` command, the tracker's echowp commands, and `playwright-cli`. The tool refuses all other commands. It does not run Cypress tests. This is a guard, not a sandbox: for example, the echowp `wp` command can still run PHP on the test site. The same guard against `sudo` as in the sync applies.
- It runs a spec file only on the tracker's own echowp site (`npm run project -- run-spec <project> <unit ref>`), and it stops the site after each unit.
- It makes a database backup before it starts. A sync and an AI update wait while it runs.
- The panel shows each unit, its cost (a list-price estimate of the plan use), the features it saved to, and the report of the run.

### Review state

Each feature in the list shows its review state:

- **New**: no person reviewed the feature yet.
- **Changed**: a person reviewed it, and the AI changed it after that. The "AI draft" marks show what changed, so you read only those parts.
- No tag: reviewed, and no AI change since.

Click "Mark as reviewed" on a feature to save your review. When you clear the last AI mark of a feature one by one, that also counts as a review. A feature that a person made counts as reviewed. Click "Mark as not reviewed" on a reviewed feature to show it as "New" again. It stays "New" until you click "Mark as reviewed". The buttons above the list show only the features in one state.

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

1. Turn on the sync once, when you add a project: `npm run project -- set-sync <id> --branch trunk`. To turn it off, add `--off`. The tests always run on the tracker's own echowp site (see "Coverage on echowp sites"). You do not start or stop a site.
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
6. It runs the Playwright tests, by the "Tests" choice:
   - "when code changed" (auto): when PHP code or Playwright files changed since the commit of the selected Playwright run.
   - "always" or "never".
7. It runs the Cypress tests, by the same "Tests" choice. "When code changed" means: PHP code or files in the Cypress project folder (specs, step definitions, support files, packages) changed since the commit of the selected Cypress run. A full Cypress run takes about 100 minutes. See "Cypress in the sync".

The sync ends as "failed" when a test run ran but was not selected. The other run is still saved.

The test run starts the tracker's echowp test site, and uses 1 worker and `ECHOWP=false`, also when the copy's `.env` says `ECHOWP=true`. It empties `coverage-data/raw/`, runs the baseline page loads, runs the tests, and writes a new run folder in `data/projects/<id>/runs/`. The app selects the new run only when the report has tests and some tests passed. Else the old run stays selected. Only one test run can run at a time.

The tests are skipped (the sync still ends as done) when echowp is not installed or the copy has no `echowp.yml`.

Each command of a sync runs without a terminal, with `coverage/no-sudo/` first in `PATH`. That folder holds stubs for `sudo`, `su`, `doas`, `pkexec` and `echowp` that only fail. So new trunk code cannot ask for a password.

To see the change report between any two commits: `npm run -s project -- changes <id> <old commit> <new commit> [--json]`.

### Cypress in the sync

The Cypress run (`server/cypress-run.ts`) uses its own echowp sites, `cy-1` … `cy-4` in the profile `cypress`. The Playwright sites do not change.

Cypress runs one test at a time. So the job starts one Cypress process for each site, at the same time. The number of sites is the same as for Playwright: half the CPUs, at most 4. `TRACKER_CYPRESS_WORKERS` changes it (for trials). The job splits the spec files over the sites by their time in the last selected Cypress run. The port of each request names its site (`sites.json` in the run folder), so each request goes to a test of its own site.

Each Cypress process runs in its own hidden screen, through `xvfb-run -d` (package `xvfb`). Without it, all processes use Xvfb display 99: the process that ends first closes the screen, and the others stop in the middle of a spec. When `xvfb-run` is missing, the job uses 1 site.

WARNING: Some Cypress tests delete the plugin through WordPress. On a site where the plugin is a link to the tracker's copy, the delete removes the copy. On 21 Nov 2026 this deleted the copy of wwp. So no tracker site uses a link.

Each time a tracker site starts (the Playwright and Cypress jobs, `run-spec` of the mapping loop, and `npm run project -- echowp <id> up`, `reset` or `start`), the tracker removes echowp's link and puts a real copy of the plugin in its place, with the marker file `.tracker-site-copy` (`useRealPluginCopy` in `server/echowp.ts`). A start by hand copies only the sites that the command names, and not while a test run holds the lock. The copy refuses to start when the real path of the site's plugin folder is or holds the tracker's copy. After a Playwright or Cypress run, each site must still have its copy with the marker: else the run is not selected. Test on 22 Nov 2026: `wp plugin delete` on `site-1` deleted only the site's copy. The tracker's copy kept all its files.

Before each Cypress run, the job does these steps:

1. It installs the Cypress packages when `package.json` or the lock file changed.
2. It starts the sites with a clean database.
3. Each site gets a real copy of the plugin when it starts (see the warning above), without `.git`, `tests` and `node_modules`, with the marker file `.tracker-site-copy`.
4. It gets the Cypress Helper Plugin from GitHub trunk (`gh api`, so `gh` must be logged in). It turns the Test Helper Plugin off, because both plugins declare the same PHP function.
5. It sets the store and debug settings from the literal `wp option update` and `wp config set` lines of `cypress/support/wpCliSetup.sh`. It skips lines with `$` and logs them.

The run leaves out these tests:

- scenarios with a tag that starts with `@integration`, or the tag `@zip-test` (they need other paid plugins or a GitHub token)
- spec files in a top-level `Integration/` folder
- spec files with a step that deletes or installs a plugin (for wwp: "Show activation status")

The run is not selected in these cases:

- a site's plugin folder is a link, or the marker is gone after the run (a test deleted or replaced the plugin)
- the tracker's copy lost files
- Cypress could not build a spec file
- no scenario passed

For a short trial, set `TRACKER_CYPRESS_SPECS` to a comma-separated list of spec files, relative to the Cypress project folder.

Each site has its own log (`full-run-cy-1.log` …) and Cucumber messages file (`cucumber-messages-cy-1.ndjson` …) in the run folder. After the baseline page loads, each site must have recorded lines of the plugin. Else the job stops with the reason.

### Settings

The Settings tab holds the settings of the whole tracker: the daily sync, the AI step after it, and the test runs (full-run days, the library code limit, the number of test sites). A change works within 1 minute, with no restart (`server/settings.ts`, table `settings`).

An environment variable of the server wins over the screen, and the screen shows that setting as locked: `TRACKER_DAILY_SYNC`, `TRACKER_DAILY_SYNC_HOURS`, `TRACKER_DAILY_AI`, `TRACKER_DAILY_AI_MODEL`, `TRACKER_DAILY_AI_UNITS`, `TRACKER_DAILY_AI_MAX_USE`, `TRACKER_FULL_RUN_DAYS`, `TRACKER_LIBRARY_SHARE` (0.9 = 90%) and `TRACKER_TEST_WORKERS`.

### Daily sync

The tracker server syncs each project with sync on once a day, when it is due (`server/daily-sync.ts`). There is no fixed time: the computer does not need to be on at night.

- A project is due when its last sync started 24 hours ago or more. A sync that you start counts too. A failed sync counts too, so it runs again the next day, not each minute.
- The server checks each minute, from 1 minute after it starts. It syncs the due projects one after the other, with the tests on "when code changed": a partial run, or a full run each 7 days.
- A project that cannot sync now (a sync, an AI update or a mapping loop runs) is tried again at the next check.
- The sync panel shows when the project is due next.
- The Settings screen (the Settings tab) turns it off, or changes the 24 hours.
- `npm run project -- daily-sync` shows when each project is due, and syncs the due projects now.

**The AI step after the sync** (on by default; the Settings screen turns it off). It uses Sonnet; the Settings screen changes the model. When no project is due for a sync, the server gives one project at a time to Claude:

1. The AI update checks the features whose tests or code changed since the last AI check. The list keeps these features from day to day, so a day with no AI step loses nothing.
2. The mapping loop does at most 10 units: changed, new and unlinked test files, then the code that is in no feature and has no decision, and the code that changed.

- A project gets the AI step after each sync, until the loop finds no unit left. At the unit limit, it waits until the next day, so each project gets some AI work each day.
- The syncs go first. When a sync becomes due, the AI step stops after the current unit or feature.
- **Important:** the AI step uses your Claude plan, the same plan as your own Claude sessions. It does not start, and it stops between units, when a run reports 80% use or more of the 5-hour or weekly limit. It waits until that limit resets.
- A feature that the AI update cannot check on 2 days is parked. The Sync screen lists it, with "Try again".
- The Settings screen changes the number of units, the plan-use stop and the model.

### Partial runs (test selection)

When the code changed, the sync runs only the spec files that the change touches (`server/selection.ts`). The other tests keep their data from the selected run. This is the same for Playwright and Cypress.

1. `coverage/select-tests.py` compares the selected run's commit with the new commit. A changed function selects the tests that ran it in that run.
2. A changed function that 90% or more of the tests ran is library code (startup, hooks, glue). It selects no test. The run saves it in `run-info.json` (`untested`, with the commit) until the next full run. The sync result shows the count. `TRACKER_LIBRARY_SHARE` changes the limit.
3. The job runs the selected spec files. With no selected spec file, it makes only the baseline page loads.
4. `coverage/merge-run.py` adds the other tests from the selected run: their windows, and their requests with the line numbers moved to the new commit. Lines in changed code are left out. Each old site gets its own slot and a made-up port (900000 + slot), so old requests match only old tests.
5. `analyze.py` makes the report of all tests, as for a full run.

The Code screen shows the library changes that are not tested again, and the functions that the AI mapping called library code (with a Remove button).

The sync makes a full run in these cases:

- the sync asks for "always"
- there is no selected run, or it has no requests, windows or plugin commit
- the last full run is 7 days old or older (the Settings screen changes it). This tests the library changes again, and clears the `untested` list.
- a test support file changed (page objects, config, Cypress `support/`): the script cannot see which specs use it. Two Cypress exceptions:
  - A changed step file selects only the tests that used its changed steps. The run saves the step patterns of each test.
  - A changed fixture selects the tests whose spec or step names it.
  - A changed hook, a changed helper, or a fixture named in a support file still makes a full run.
- the change touches every spec file, or `select-tests.py` fails

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

The coverage script records only the lines that ran. `analyze.py` counts the runnable lines of each plugin file without running the code (`coverage/runnable-lines.php`, through `coverage/php-xdebug.sh`). The helper uses the tracker's coverage PHP (the same PHP version as the test sites) when it exists, else Local WP's PHP. Lines that ran always count as runnable. PHP files that no request loaded still count: all of their lines count as never run.

OPcache (the PHP code cache) stays on while the script records. Before 21 Nov 2026 the script turned it off for each request, and each request was about 2.2 times slower. The coverage ini turns off the OPcache optimizer (`opcache.optimization_level=0`), checks the file times on each request, and resolves links again (`opcache.revalidate_path=1`). Without the last setting, a new Cypress site kept running the plugin code from the tracker's copy (through echowp's link) after the job put a real copy in its place. With OPcache on, some argument lines of a call over more lines do not show as run, although the call ran (about 0.2% of the lines in the wwp Playwright run). The functions that each test ran do not change.

Test IDs (`PW-…`, `CY-…`) come from the file path and the title. A rename gives a new ID.

### Coverage on echowp sites

Each sync test run does these steps:

1. It starts the project's test site (`site-1` in the echowp profile `test`) in the tracker's echowp home. A stopped site starts again in about 1 second.
2. It resets the site's database to the echowp template. The admin login comes from the `.env` file of the plugin's Playwright folder.
3. It runs the tests on the site, with 1 worker.
4. It stops the site, also when the run fails, when you cancel it, or when the server stops during the run.

All the tracker's sites use one PHP server, so each of them can record coverage. During a run, the file `coverage-data/test-site.json` gives the port of the test site. Then only requests to that port are recorded, and you can use the other tracker sites.

You can also start the tracker's sites yourself:

```
npm run project -- echowp <id> up          # start the sites of the project's copy
npm run project -- echowp <id> stop <site> # stop one site, keep its data
npm run project -- echowp <id> down        # remove all the tracker's sites, stop its database
```

Any echowp command works: the tracker adds the settings below and `--dir <the project's copy>`.

- The tracker uses its own echowp home, `data/echowp-home/` (`ECHOWP_HOME`). It has its own PHP server, database, site list and downloads. echowp runs one PHP server for all projects of a home, so a shared home could give your own sites Xdebug.
- Your own `echowp` commands do not change, and they do not see the tracker's sites.
- `up` makes the coverage PHP first when it is missing. Then it serves plain HTTP, and picks ports from 8801 that neither echowp home uses. When the project has sites already, new sites get the next ports after them. At the end, it checks that the server runs the coverage PHP.
- The first `up` downloads MariaDB, WP-CLI and WordPress into the tracker's home. It took 17 minutes (MariaDB came slowly from archive.mariadb.org).
- `down` always uses `--all`. It removes only the tracker's sites, because they are the only sites in this home.

The coverage PHP comes from `npm run project -- coverage-php`. The normal echowp PHP cannot load Xdebug. This command downloads the FrankenPHP "-gnu" binary of the version that echowp uses, and checks its checksum. Then it builds Xdebug in the matching official PHP Docker image, and checks that Xdebug records the correct lines. The files go to `data/coverage-php/current/`. A second run reuses them. It needs Linux and Docker without `sudo`. When a sync must make the coverage PHP first, a cancel stops the download and the Docker build.

WARNING: The sites must ask for the same PHP version as the binary (or have no `php` setting). `up` stops when they do not.

- `--check` tests the current files again.
- `--frankenphp <version>` and `--xdebug <version>` choose other versions.
- `--force` builds again.

When echowp moves to a new FrankenPHP version, run `coverage-php` again.

## Check the parsers

Run `npm run check-parsers`. It compares the parsed tests and totals with the coverage runs. It also checks that each test in the Cypress run matches one scenario.
