# Plan: keep the tracker in sync with new plugin code

Status on 20 Nov 2026: the trial and phases 1 to 3 are done. Phase 4 is in progress. Phase 5 (mapping loop and review state) is built.

## Goal

The tracker must stay correct when the plugin code or the tests change. It must work for 40+ plugins, with hundreds of tests each.

## Decisions

- The tracker reads its own copy of each plugin, on `trunk`. It does not read the working copy of a developer.
- Headless Claude (`claude -p`) updates the feature data after a sync. It updates existing data.
- Changed on 20 Nov 2026: headless Claude also maps new units (the map-features skill), in a loop. See phase 5.
- The AI step is separate from the fixed steps (get code, scan, run tests). The fixed steps never need the AI.

## Done in the trial

- [x] Make the trunk copy: `/home/chili/Works/tracker-repos/woocommerce-wholesale-prices`.
- [x] Point the Local site `automation-tracker` to the copy. The old link target is in `data/projects/wwp/site-link-before-trunk.txt`.
- [x] Add the copy folder to `coverage/prepend.php`.
- [x] Make a full Playwright run on trunk: `data/projects/wwp/runs/2026-11-19-trunk-playwright`. 48 tests passed, 2 skipped, 6.4 minutes.
- [x] Point the app to the copy and the new run (`npm run project -- set-path`).
- [x] Write `coverage/fingerprints.php`: a fingerprint for each function, without comments and white space.
- [x] Write `coverage/select-tests.py`: the tests that ran the code that changed between two commits.
- [x] Try headless Claude on one feature (F-1) and one commit.

## What the trial found

- **Test selection saves little for this plugin.** Much plugin code runs on each page (hook setup, the onboarding card, the REST login check). A change there can affect each test.
  - Last 60 trunk commits: 74% of the test runs for each commit, 73% for each day, 89% for each week.
  - With a shortcut that has known misses: 46%, 56% and 89%.
  - The map came from 49 tests that run 15% of the feature lines. The share goes up when the tests grow.
- **How often we sync matters more than selection.** For the same 60 commits, a full run each week is 637 test runs. A daily sync with selection is 1,365.
- **JS changes select no tests**, because we have no JS coverage. This is a miss.
- **A full run takes about 7.5 seconds for each test.** 500 tests take about 1 hour on 1 worker.
- **Parallel runs need one site for each worker.** The plugin can do this with echowp, but echowp sites cannot record coverage now (no Xdebug or PCOV).
- **Headless Claude works.** One case with no change and a 72 KB diff: Opus $0.65 (it read the code to check), Sonnet $0.29. A case with real edits is not tested yet.

## Phase 1: Clean up the trial

- [x] Add `coverage-data*/`, `coverage/plugins.json` and `__pycache__/` to `.gitignore`. The folder `coverage-data-2026-11-18/` stays on disk.
- [x] Make `coverage/prepend.php` find the tracked plugins itself. It reads the plugin names from `coverage/plugins.json` (written by `npm run project -- coverage-config`), and finds each plugin in the site's `wp-content/plugins`. Each request file keeps the lines of each plugin apart. `coverage/raw_records.py` reads the new and the old format.
- [x] Fix the code review findings (19 Nov): plugin list at start, relative paths, folder name check, top-level specs folder, closure keys, site folder fallback, skip list, special file names.
- [x] Commit the trial and phase 1 files: `.gitignore`, `README.md`, `docs/sync-plan.md`, `server/cli.ts`, `server/index.ts`, `server/projects.ts`, `coverage/prepend.php`, `coverage/analyze.py`, `coverage/raw_records.py`, `coverage/fingerprints.php` and `coverage/select-tests.py`.

## Phase 2: Sync one plugin (wwp)

1. [x] Sync command: get the latest `trunk` in the copy. Done with `git fetch`, then `git merge --ff-only` (not `git reset --hard`): the sync first checks that the copy is on the branch, has no changed files and no own commits, so the result is the same, but a mistake stops the sync instead of losing work. It runs `npm ci` (not `npm install`, which can change the lock file) when the package files changed, and installs Chromium when the Playwright version changed. Turn the sync on for each project with `set-sync`.
2. [x] Save the synced commit for each project. Then the app can show "synced at" and the commit. Each sync is a row in the `syncs` table, with its report and test result.
3. [x] Change report: list what changed since the last sync (`server/changes.ts`, also `npm run -s project -- changes <id> <old> <new>`). It reads only the two commits. Checked on the last 60 trunk commits: no errors, about 0.1 s for each commit.
   - plugin files and functions (use `coverage/fingerprints.php`)
   - tests added, changed and removed
   - likely renamed tests: a new title gives a new test ID, so its links are lost. Offer to move the links.
   - renamed or removed functions in feature code, which then show "not in the code now"
   - features to review: features whose tests or code changed
4. [x] Test run job (`server/test-run.ts`): run the baseline, the Playwright tests with the window reporter, `analyze.py`, write `run-info.json`, and select the run. Do it in the background, and show the progress in the app.
   - Keep the site idle during the run. Page loads outside a test count as setup.
   - Use only the Local site (`ECHOWP=false`). A command started by the app must never reach `sudo`.
   - Checked on 19 Nov: full run from the job, 47 passed, 2 skipped, 6.2 minutes, selected. Cancel and a server restart stop the tests and keep the old run. 0 failed logins.
   - The trial run counted 809 more runnable lines at the same commit. Its first 76 requests saw an older copy of the plugin (the site link changed during that run). The sync run is the clean one.
5. [x] Add a "Sync" button in the app that does steps 1 to 4. Also add a command for the same steps (`npm run project -- sync <id>`).

## Phase 3: AI update with headless Claude

Built on 19 Nov 2026 in `server/ai-update.ts`. Command: `npm run project -- ai-update <id> [--from <commit> --to <commit>] [--feature 1,2] [--model sonnet|opus] [--budget 1] [--bare] [--no-apply]`. Without `--from` and `--to`, it uses the commits of the last sync with a change report. Each check is a row in the table `ai_updates`.

1. [x] For each feature to review, collect: the feature data (`map feature --all`), the reasons from the change report, the diff of its code and test files (at most 80 KB), the changed PHP functions, code that is gone, likely renamed tests, and new tests that no feature links.
2. [x] Run `claude -p` with `--json-schema`, `--max-budget-usd`, `--tools Read,Grep,Glob`, `--strict-mcp-config` (no MCP servers) and `--disable-slash-commands`. The prompt goes on standard input. It runs under `setpriv --no-new-privs` with the no-sudo stubs. Claude reads the code at the new commit: the copy, or a temporary `git worktree` when the copy is at another commit. It does not write to the database.
3. [x] Save the answer through `npm run -s map -- apply` with unit kind `update` (not in the mapping order, so `next`, `skip` and `status` do not see it). The runner sets the feature ID, and drops item, scope and test IDs that do not exist, so one wrong ID does not stop the save. An answer with no change does not call apply.
4. [x] Test a case where the feature must change. Results on a copy of the database, feature F-1:
   - Case A, commit `d1c24928` (adds a "Wholesale Sale price" column, later reverted). Sonnet: $0.08, 7 s, correct (new column only with Premium, the hide setting removes both columns, it removed the open question about sale prices). Opus: $0.22, 23 s, correct and more detail (one line for each variation, column order, the new column uses the label "Wholesale Price:"), 5 new scopes.
   - Case B, commit `f40bf5b9` (`strpos` to `str_contains`, no change in behavior). Sonnet: $0.05, no change. Opus: $0.11, no change. Both correct.
   - Spend limit: with `--budget 0.01`, the run stopped with `error_max_budget_usd` and cost $0.02. The limit is checked after each step, so a run can go a little over it.
   - Not tested yet: links to new tests, and changes to an existing scope. Neither commit had tests. Test them on a sync that adds or changes tests.
5. [x] Show the cost of each update in the app: sync report > "AI updates", with the total, and a button to check the features to review of the last sync (Sonnet or Opus). A sync cannot start while an AI update runs. Tested once through the app route on a database copy ($0.02).
6. [x] Decided on 19 Nov 2026: the user login (claude.ai subscription). The run does not get `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, so it never bills an API key. The cost in the app is a list-price estimate of the plan use, not a bill. `--bare` stays in the code, but it was not tested.
7. [x] Decided on 19 Nov 2026: Opus is the default model. The limit is $1 (list price) for each feature. Sonnet stays a choice in the app and on the command line.
8. [x] Fixes after a code review on 19 Nov 2026:
   - Each AI update row has its process (`owner_pid`) and its claude run (`claude_pid`). Each process sees a running update in the database, so a sync from the app or the command line waits. When the process is gone (a server restart), the next look at the state marks its rows as failed, stops the claude run, and removes the temporary checkouts.
   - The prompt input cannot stop the server when claude exits early.
   - A link to an unknown scope, or a change to an item that the same answer removes, is dropped with a note. The rest of the answer is saved.
   - The cost stays saved when a step after the claude run fails.
   - The app button uses the saved report of the sync (its commits and features), and shows an error when the update cannot start.
   - The feature read, the diff and the save do not block the server.

## Phase 4: Scale to 40+ plugins

1. [ ] Get coverage on sites that can run in parallel. Options: add PCOV to the echowp FrankenPHP build, or use a Docker site with Xdebug or PCOV.
   - Hand test on 19 Nov 2026: echowp coverage works with no PHP build.
     - echowp uses FrankenPHP's own PHP 8.5.8. echowp has published no PHP builds (no `php-builds` release).
     - Xdebug and PCOV cannot be built into PHP (static-php-cli `ext.json`: `"target": ["shared"]`). The normal FrankenPHP binary cannot load add-on files.
     - FrankenPHP's own `frankenphp-linux-x86_64-gnu` (same release, 1.12.4) can load them.
     - No ready-made thread-safe Xdebug file for it was found. Xdebug 3.5.3 was built with `pecl install xdebug` in `php:8.5.8-zts-trixie`. Build ID `API20250925,TS` and the timer and signal settings match the binary.
     - It loaded. 400 parallel requests (16 PHP threads) each got correct coverage.
     - An echowp site got the binary from PATH and the settings from `PHP_INI_SCAN_DIR`, with no echowp change. Settings: `zend_extension`, `xdebug.mode=coverage`, `auto_prepend_file`.
     - 28 page loads gave 28 correct request files with wwp lines. Each file had the same 10,592 runnable lines.
     - Decided on 19 Nov 2026: the tracker makes the coverage PHP, not echowp. echowp does not change.
   - Built on 19 Nov 2026: `npm run project -- coverage-php` (`server/coverage-php.ts`). It downloads the "-gnu" binary, checks its sha256 against the GitHub digest, builds Xdebug in Docker, and checks it. It took 32 s. An echowp site with it gave 19 correct request files for 19 page loads.
   - echowp runs one FrankenPHP process for all projects of a home (echowp `docs/DESIGN.md:443`). So the binary on PATH must not reach the user's echowp. Decided on 19 Nov 2026: the tracker has its own echowp home.
   - Built on 19 Nov 2026: `npm run project -- echowp <id> <command>` (`server/echowp.ts`). It uses `ECHOWP_HOME=data/echowp-home`, the coverage PHP, plain HTTP, and ports from 8801 that neither home uses. After `up`, it checks the server's binary and `PHP_INI_SCAN_DIR` in `/proc`.
     - Test with wwp: first `up` 17.5 minutes (downloads). The user's registry did not change, and `echowp ls --all` of the user does not show the tracker's site.
     - Tracker MariaDB on port 3307, site on 8801. Page loads wrote request files. The copy has no changed files.
     - `stop` frees the site and admin ports. The tracker's MariaDB stays on until `down`.
   - Built on 19 Nov 2026: the sync test run always uses echowp (the user decided: no setting, nothing to start or stop by hand; the Local site and `--site` are gone). It starts `site-1` in profile `test` of the tracker's home, resets its database, runs the tests with 1 worker, and stops the site. The echowp stub in `coverage/no-sudo` stays: only the tracker's own code calls the real echowp.
     - Test with wwp on 19 Nov 2026 (DB copy, so the real selected run did not change): new test site in 25 s, reset in 1 s, 48 passed and 2 skipped in 7.4 minutes, site stopped after the run. Run folder `data/projects/wwp/runs/2026-11-19-1715-sync-b73e8a97`.
     - Compared with the Local site run at the same commit (`2026-11-19-1320-sync-b73e8a97`): tests ran 395 functions, against 367. 33 functions only on echowp (mostly admin notices and onboarding code of a fresh site), 5 only on Local. Cause: the site data differs (fresh template against an old site).
     - The user's echowp registry did not change. The copy has no changed files. No failed logins.
     - Real sync 6 from the app API ("Sync now", tests always): 47 passed, 2 skipped, 7.1 minutes, run `2026-11-19-1730-sync-b73e8a97` selected, site stopped after.
2. [x] With parallel sites, each request must name its test or worker.
   - Built on 19 Nov 2026. The run does not use a header: the port of the site names the worker. Each worker has its own site, so WP-Cron and loopback requests (which send no header) also go to the correct worker.
   - The run starts one echowp site for each worker (`site-1` … `site-N`, profile `test`) and resets each. Workers: half the CPUs, at most 4. `TRACKER_TEST_WORKERS` changes it for trials. There is no setting.
   - When another site has a port that a new site needs, the run removes the test sites of the project and starts all of them on a new block of free ports.
   - The run copies a wrapper next to the plugin's Playwright config, and removes it after the run. `coverage/playwright-wrapper.cjs` loads CommonJS configs, and `coverage/playwright-wrapper.mjs` loads ES module configs. Both use `coverage/playwright-wrapper-lib.cjs`.
   - The wrapper sets `BASE_URL` from the worker slot (`TEST_PARALLEL_INDEX`) before it loads the plugin's config. The plugin stays on `ECHOWP=false`, so it never calls echowp.
   - The run has 3 phases:
     1. Setup: the projects that other projects depend on, and `globalSetup`, once for each site. Setup projects that depend on each other keep their order.
     2. Main: the other projects, with `N` workers and no dependencies.
     3. Teardown: the teardown projects and `globalTeardown`, once for each site.
   - A config with no `projects` list runs as one main project.
   - Saved logins (`storageState` in the config): the setups run one after the other. After each setup, the run copies the login file for that site. Each worker reads the copy of its site. Without login files, the setups run at the same time. A `storageState` that a test file sets (not the config) is not covered.
   - Before the sites start, the run lists the tests for 2 different site URLs. When the lists differ (a test name holds `BASE_URL`), the run uses 1 worker.
   - `coverage/prepend.php` records the port of each request. `test-site.json` has a list of ports. The reporter saves the worker slot (`parallelIndex`). The run folder has `sites.json` (slot to port).
   - `analyze.py` and `select-tests.py` match a request only to tests of its worker (`raw_records.window_of`). Old runs (no `sites.json`) keep the time-only rule.
   - A cancel stops all commands of the sync (`killChildren` in `server/sync.ts`), also the setup commands that run at the same time. When a setup command cannot start, the run waits for the others before it stops the sites.
   - Test with wwp at `b73e8a97`, DB copy, compared with the 1-worker run `2026-11-19-1730-sync-b73e8a97` (7.1 minutes):
     - 2 workers: 4.8 minutes. 47 passed, 2 skipped (the same). 47 of 49 tests ran the same functions.
     - 4 workers, setup in parallel: 2.7 minutes. The same counts. 46 of 49 tests ran the same functions.
     - Run `2026-11-19-2052-sync-b73e8a97` (4 workers): 2 of the 3 other tests ran first on their site. The third ran second on its site. All differences are one-time code of a new site (`WWP_Getting_Started_Note`, `WWP_Onboarding_*`, `maybe_dispatch_admin`). This comes from test order, not from wrong matching.
     - The "tested" line count did not change. All-code coverage went from 31.3% to 31.8%, because setup now runs on 4 sites.
     - 605 of 682 requests came while tests of two or more workers ran. The old time-only rule would mix them.
     - `analyze.py` on a copy of the old run gives the same `report.json`, `lines.json` and `summary.txt`. `select-tests.py` runs on old and new runs.
     - No failed logins. The copy has no changed files after the run.
   - Test after the code review fixes (DB copy, 4 workers): 2.8 minutes, 47 passed, 2 skipped. 47 of 49 tests ran the same functions as the 1-worker run.
   - Port clash test: port 8806 held by another program, 5 workers. The run removed the 4 old sites and made 5 new sites on ports 8801 to 8805 in about 2 minutes. 47 passed, 2 skipped.
3. [ ] Run the sync on a schedule (each night or each week), not only by hand. Run tests only when PHP or test files changed.
4. [ ] Make adding a plugin easy: the copy, the `.env` file, the test packages, the site link, and the project in the app.
5. [ ] Decide where the runs happen: this computer, a CI server (Buddy), or a cloud machine.

## Phase 5: Mapping loop and review state

Built on 20 Nov 2026. The user asked for: a loop that runs the map-features skill headless, a mark for features that a person reviewed, and a way to see which features changed since the review.

1. [x] Review state of each feature (migration 22): `features.reviewed_at` and `features.ai_changed_at`.
   - "Mark as reviewed" (was "Mark as checked") clears the AI marks and saves the time.
   - After each change in the app, a feature with no open AI mark is reviewed now, when it was never reviewed or the AI changed it after the review (`sweepReviewed` in `server/features.ts`). So marks cleared one by one count as a review, and a feature that a person made counts as reviewed.
   - `map apply` sets `ai_changed_at` on each feature it saves to.
   - State in the app: New (never reviewed), Changed (reviewed, and AI marks are open again), no tag (reviewed). Filter buttons above the list.
   - Each AI write leaves a mark (checked in `server/map.ts`): new text and items are AI draft, a new scope on a checked AI link un-checks the link. A link that a person made, and a checked screenshot, are not changed: the tool only suggests.
   - Roles had no mark. Now a role that the AI adds puts "roles" in the feature's `ai_fields`. A person who adds or removes a role clears it. Tested on a copy: review F-1, AI adds a role → Changed; the person removes it → Reviewed.
   - Not a "Changed" reason: a linked test or code that is gone after a sync. The feature page shows these on their own.
   - Tested on a database copy: New → Reviewed → Changed (AI adds a note) → Reviewed (the person checks the note). A change to another feature does not change the time.
2. [x] `npm run project -- run-spec <project> <unit ref>` (`runSpec` in `server/test-run.ts`): one spec file on the tracker's echowp `site-1`, with a clean database, `ECHOWP=false`, 1 worker. The site stays on for playwright-cli. The skill used the plugin's `.env` before (`ECHOWP=true`: the person's own echowp home, and a path to `sudo`).
   - The first admin visit of a new site goes to the WooCommerce home page. A spec that runs first then fails. `runSpec` loads the pages of `coverage/baseline.sh` first, as the sync does. Before the fix: 1 failed, 2 passed. After: 3 passed.
   - The skill guide said `echowp down` to stop the site. `down` deletes the sites. The guide now says `stop site-1`.
3. [x] Mapping loop (`server/map-loop.ts`, tables `map_loops` and `map_runs`, command `map-loop`, Features tab > "Map with AI").
   - The runner picks the unit with `map next`, and gives one unit to each `claude -p` run. After the run, it checks `processed_units`: a unit that was not saved or skipped is "failed". A unit that fails two times stops the loop.
   - Limits: units, 60 minutes for each unit, and the plan limit. The run uses the claude.ai plan, so it has no dollar limit.
   - The runner reads the plan limit events (`--output-format stream-json --verbose`, `rate_limit_event`).
   - At the 5-hour or weekly limit, the runner stops the run. It does the same when the run starts to use paid extra usage.
   - Then the runner marks the unit "stopped" (not saved), and the loop ends. A limit of one model stops only a run of that model.
   - Tools: `--permission-mode dontAsk` with an allow list (read tools, Skill, Write in the run's scratch folder, the `map` steps of the skill (not `reset` or `move-scope`), `run-spec`, the tracker's `echowp`, `playwright-cli`, `faillock`). setpriv and the no-sudo stubs, as in the sync. No MCP servers.
   - A sync and an AI update do not start while a loop runs, and the reverse.
   - The runner stops the test site and closes the browser after each unit, and makes a database backup at the start.
4. [x] Trials on a database copy, 20 Nov 2026, Opus, unit `frontend/per-product-wholesale-price/cart-page.spec.js`:
   - Trial 1: $2.66, 4 minutes, "failed". The run did all the work, but could not save: a `Write(...)` permission rule does not allow the Write tool in `dontAsk` mode. An `Edit(...)` rule does (tested with a small Haiku run). Also `faillock --user $USER` was refused (a variable in the command). The prompt now gives the user name.
   - Trial 2: $1.18, 3 minutes, "done". New feature F-5 with 5 scopes in one scope group, 3 notes, 3 test links, 7 functions and 1 JS file, 2 screenshots. The spec ran with `run-spec` (4 passed). The run made test data on the site and deleted it. 0 failed logins. The copy has no changed files. The site stopped after the unit.
   - Rough estimate for wwp (real database, 20 Nov): 7 Playwright files and 82 Cypress files are left. Only Playwright units were measured ($1.18 saved, $2.66 when the save failed). No Cypress unit and no code unit was measured yet, so a total is a guess.
   - Start and Stop from the app, on a copy: a sync and an AI update are refused (409) while the loop runs. After Stop: no claude, run-spec or Playwright process is left, site-1 is stopped, the loop row says "Stopped by a person". A killed run-spec can leave the test-run lock: the loop removes a lock whose process is gone after each unit.
6. [x] Fixes after a code review on 20 Nov 2026:
   - A stop while the loop picks the next unit now stops it before a new claude run starts. Tested: start and stop at once, no unit, no claude run.
   - `sqlite3` is not in the allow list now (its `.shell` and `.system` run any command). The skill exports screenshots with `npm run -s map -- screenshots <project> <id> <folder>`.
   - The loop does not start without setpriv.
   - When the loop fails, its open unit rows become "failed".
   - Migration 23: review times in the ISO form of now() (the first form of step 22 wrote "YYYY-MM-DD HH:MM:SS").
   - A unit that runs longer than 60 minutes counts as failed, and the loop goes on. A unit with no known cost counts as its full limit. A unit limit above the total is lowered to the total. The panel checks every 30 s for a loop that the command line started.
   - Not changed: the review said that run-spec does not clean up on SIGTERM. It does: `server/sync.ts` catches SIGINT, SIGTERM and SIGHUP and calls process.exit, so the exit handlers run. Only a SIGKILL leaves the lock, and the loop removes a dead lock after each unit.
5. [x] Decided on 20 Nov 2026: button only (and the `map-loop` command). The loop does not start after a sync. Default limits stay: Opus, 10 units, $5 for each unit, $25 in total.

## Phase 6: Faster test runs for 40+ plugins

Goal: a sync must not run all tests for 95 minutes. One wwp sync on 21 Nov 2026 ran Cypress for 95 minutes (489 tests). 40 plugins at that speed need about 63 hours.

### What the research found (21 Nov 2026)

- **The site is the slow part.** The site was busy for 80 of the 95 minutes, 0.7 s for each request on average. 34 of the 80 minutes were Cypress Helper Plugin setup calls (`/wp-json/chp/...`).
- **The recorder makes each page 2.2 times slower.** `coverage/prepend.php` turns off opcache, the PHP code cache, for each recorded request. 4 pages on `cy-1`, median of 8 loads:

  | Mode | Time for 4 pages |
  |---|---|
  | No recording | 1.06 s |
  | Now: opcache off, `XDEBUG_CC_UNUSED \| XDEBUG_CC_DEAD_CODE` | 2.37 s |
  | Opcache on, lines only (flags 0) | 1.09 s |
  | Opcache on, `UNUSED \| DEAD_CODE` | 1.21 s |

  With opcache on, the recorded lines were almost the same: at most 5 different lines of about 1,440 for each page.
- **Cypress runs one test at a time on one site.** The computer has 8 CPUs. Playwright already uses 4 sites (7.1 → 2.7 minutes).
- **Most functions run in few tests or in almost all tests.** Share of tests that ran each function:

  | Share of tests | Playwright functions | Cypress functions |
  |---|---|---|
  | Less than 25% | 160 | 393 |
  | 25–90% | 29 | 82 |
  | 90% or more | 184 | 199 |

- **Test selection with a library limit.** Simulation over the last 60 trunk commits (27 Aug to 20 Nov 2026), with the runs `2026-11-21-0953-sync-3293b92d` and `2026-11-21-1022-sync-cypress-3293b92d`. A changed function that ran in the limit share of tests or more selects no test. Share of all test runs:

  | Rule | Playwright | Cypress |
  |---|---|---|
  | Selection with no library limit | 75% | 74% |
  | Library limit 90% | 18% | 42% |
  | Library limit 90%, Cypress helper files select only their own tests | 18% | 21% |
  | Library limit 50% | 10% | 40% |
  | Library limit 90%, one sync each week (16 weeks) | 42% | 74% |

  - Cypress is higher because a changed Cypress helper file selects all tests now. This occurs in 19 of 51 commits. Most are test data files (`cypress/fixtures/customer-import`, 25 changes) and step code (`cypress/step_definitions`, 12 changes).
  - The 21% row is a best case: the helper files selected no test in the simulation.
  - The numbers count tests, not minutes. Playwright has only 49 tests, so its numbers are rough.
  - The skipped library changes are about 2 functions for each commit. Almost all are startup code: the code outside functions of the main plugin file, `WooCommerceWholeSalePrices::__construct` and `::run`, the import/export and onboarding `run()` functions, and `WWP_Onboarding_State::get_state`.
  - The simulation scripts were in the session scratchpad. They were not kept. To do it again, add a library limit to `coverage/select-tests.py`.

### Steps

1. [x] **Keep opcache on while recording.** Built on 21 Nov 2026.
   - `coverage/prepend.php` keeps OPcache on and records only the lines that ran (no `XDEBUG_CC_UNUSED`, no `not_run`).
   - `coverage/analyze.py` counts the runnable lines of every plugin file with `coverage/runnable-lines.php` (8 at the same time, about 10 s for wwp). Lines that ran and old `not_run` lines also count.
   - `coverage/php-xdebug.sh` uses the tracker's coverage PHP 8.5 when it exists (before: Local WP's PHP 8.2).
   - The coverage ini (`server/coverage-php.ts`) has `opcache.optimization_level=0`, `opcache.validate_timestamps=1` and `opcache.revalidate_freq=0`. `syncCoverageIni` writes the ini again for an existing coverage PHP.
   - Static count against the recorded count (Cypress run at `3293b92d`): 12,010 against 12,026 lines in 89 loaded files. The differences are argument lines of calls over more lines.
   - Old Cypress run analyzed again: 12,714 runnable lines (was 12,690), feature coverage 43.9% (was 44.0%). 3 functions moved from library to never, because of one array line each. A run with OPcache on records those lines as run.
   - Playwright trial on a DB copy, 4 workers, at `3293b92d`: **1.6 minutes (was 2.7)**, 47 passed, 2 skipped (the same). Run `2026-11-21-1744-sync-3293b92d` (not selected).
     - No function has another category. 42 of 47 tests ran the same functions. The 5 others differ in one-time code of a new site (`maybe_dispatch_admin`, `should_register_wholesale_price_html_filter`): test order, as in step 2 of phase 4.
     - Tested lines 1,438 (was 1,459). The 31 lines that ran only in the old run are argument lines of calls over more lines (`__(`, `$post,`). The calls ran.
   - Cypress: see step 2 (with 4 sites).
2. [x] **Run Cypress on 4 sites at the same time** (`cy-1` … `cy-4`). Built on 21 Nov 2026.
   - `server/cypress-run.ts`: sites as for Playwright (half the CPUs, at most 4, `TRACKER_CYPRESS_WORKERS` for trials). `splitSpecs` splits the spec files by their time in the last selected Cypress run (longest first, into the group with the least time, plus 10 s for each file).
   - Each site gets its own plugin copy with the marker, the Cypress Helper Plugin and the options, at the same time. Baseline page loads on each site. `sites.json` in the run folder, `slot` in each test window, one log and one messages file for each site.
   - Each Cypress process runs in `xvfb-run -d`. Found: without it, all processes start Xvfb on display 99, and the process that ends first closes it. The others stopped in the middle of a spec (exit 1, no messages file). Without `xvfb-run`, the job uses 1 site.
   - Found: 2 requests can start in the same microsecond, and all FrankenPHP threads have one process ID. Two requests wrote into one file, and `analyze.py` failed. `coverage/prepend.php` now adds a random part to the file name and writes to a temp name first.
   - Found: on new sites (echowp puts the plugin in as a link to the tracker's copy), OPcache kept the code that it found through the link after the job put the real copy in. 3 of 4 sites recorded no plugin lines, and 53 admin tests failed (the plugin built its script URLs from the tracker's path). Fix: `opcache.revalidate_path=1` in the coverage ini. Check: after the baseline, each site must have recorded plugin lines, else the run is not made.
   - Full run on a DB copy at `3293b92d`, run `2026-11-21-2102-sync-cypress-3293b92d` (not selected in the real database):

     | | 1 site, OPcache off (`2026-11-21-1022-…`) | 4 sites, OPcache on |
     |---|---|---|
     | Time of the job | 95 min | **16.9 min** |
     | Passed / failed | 469 / 20 | 471 / 18 |
     | Feature line coverage | 44.0% | 43.6% |
     | Functions tested / never / library | 427 / 381 / 247 | 428 / 379 / 247 |

     - No test that passed before failed. 2 tests that failed before passed.
     - 293 of 469 tests ran the same functions. Median difference 0, 90th percentile 11 functions. The differences are mostly onboarding code and code that depends on what earlier tests on the same site left (other test order on each site).
3. [x] **Select tests by change, with a library limit of 90%.** Built on 21 Nov 2026.
   - `server/selection.ts` decides full or partial for each tool. `coverage/select-tests.py` has `--library-share` and `--tests-root` (the folder that the test paths are relative to; Cypress: the folder of `cypress.config.*`).
   - Found: the simulation in "What the research found" gave Cypress `--playwright-dir tests/Cypress/cypress/tests` only, so the test paths did not match, and changed Cypress spec files selected no test. `--tests-root` fixes this.
   - A changed function that 90% or more of the tests ran selects no test. It goes into `untested` in `run-info.json` (file, function, commit). Each partial run keeps the old list and adds to it. A full run clears it. The sync result shows the count ("2 library changes not tested again until the next full run").
   - Partial run: the jobs run only the selected spec files (Playwright: file filters of the main phase; Cypress: `--spec`). With no selected spec file, the job makes only the baseline.
   - `coverage/merge-run.py` adds the other tests from the selected run, with line numbers moved to the new commit (difflib over `git show` of both commits; renames from `git diff -M`). Lines in changed blocks are left out. Old sites get new slots and made-up ports (900000 + slot). Old baseline requests are not kept. Old tests of spec files that ran again, that are gone, or that the job leaves out are not kept.
   - Full run when: "always", no usable selected run, a support file changed (also Cypress step definitions and fixtures, for now), every spec file is selected, select-tests.py fails, or the last full run is 7 days old (step 4).
   - Test 1 (offline, Playwright): a made-up partial run of 3 spec files at `3293b92d`, with 41 tests kept from `2026-11-19-2052-sync-b73e8a97` (2 days older). Tested lines 1,439 against 1,438 in the full run. All 49 tests present. Each test at most 5 functions different (the code changed between the commits).
   - Test 2 (real partial Cypress run on a DB copy, base `2026-11-21-cypress-full-2` at `b73e8a97`, new commit `3293b92d`):
     - Selection: 45 of 64 spec files (348 of 501 tests). 2 library changes not tested again: `WWP_Wholesale_Prices::apply_product_wholesale_price_to_cart` (ran in 489 of 489 tests) and the code outside functions of `class-wwp-wholesale-roles.php`.
     - 14.4 minutes (a full run: 16.9). This change touched the long specs, so it saved little.
     - Feature line coverage 43.8% (full run at the same commit: 43.6%). No test missing. Median difference 0 functions for each test, 90th percentile 10.
     - Found: the merge kept 12 old tests of "Show activation status", which the job now leaves out. Fixed: old tests of left-out spec files are not kept. Then 489 tests in 63 spec files, as in the full run.
   - Fixes after the code review on 22 Nov 2026:
     - A spec file inside the test folder counted as a support file, so each spec change made a full run. `is_support` now leaves out the specs folder. Checked with `b73e8a97`: 2 spec changes, 5 real support files.
     - Documentation and example files (`*.md`, `*.txt`, `*.example`) in the test folder select no test and do not make a full run.
     - A partial run where every re-run test failed was "not a good run", and the sync failed. A partial run is now selected also with 0 passed (the kept tests are in the report).
     - `analyze.py` failed for an older run (with `not_run` lines) when no PHP with Xdebug was there. For such a run the recorded lines are complete, so it now goes on. Checked with `COVERAGE_PHP_DIR=/nonexistent`.
     - Cypress with `cypress.config.*` at the top of the repo: support file changes cannot be found, so the selection makes a full run.
   - Not done yet: Cypress step definitions and fixtures select only their own tests (now they make a full run). The feature pages do not show the `untested` list yet (only the sync result shows the count).
4. [x] **A full run as a safety net, each week.** Built into `server/selection.ts`: a full run when the last full run (`fullRunAt` in `run-info.json`, or `recordedAt` of an older full run) is 7 days old or older. `TRACKER_FULL_RUN_DAYS` changes it. A full run clears `untested`.
5. [x] **AI step for code that no test runs.** Built on 22 Nov 2026, in the map-features skill (its code units run after the Playwright and Cypress units).
   - New table `code_decisions` (migration 29, `server/code-decisions.ts`): a function that no test runs and that is library code, with a reason, `ai` or `person`, and the commit. The function is kept by name, so the decision stays when it moves.
   - `coverage.ts withMarks` counts each runnable line of such a function as a library mark. So the totals and the function state count it as library, as a person's line mark does.
   - `map apply` takes a top-level `library` list (`file`, `function`, `reason`). A code unit can send only `library`. The tool refuses a function name that the coverage run does not know.
   - `map next <project> code`: "open" functions (no test runs them, no feature holds them, not library). A file is a candidate when no code area holds it, or when it changed since its code area was done (`changedSinceArea`, from the area's file hash): this brings new code of a sync back.
   - API: `GET /api/projects/:id/code-decisions`, `DELETE` with `{ file, function }`.
   - Skill: for each open function of a code area, feature code goes into a feature (a new feature or scope with no test when none fits), library code into `library` with a reason.
   - Test on a DB copy: one function of `class-wwp-helper-functions.php` sent as library: its state is `library`, the file left the candidate list (112 files, was 113). With a changed area hash, the file came back with 34 open functions (was 35).
   - Not done yet: no screen in the app lists the decisions (only the API). The feature pages do not show the `untested` library changes of partial runs.

Estimate with all steps: Cypress about 3 to 6 minutes for each sync plus 2 to 3 minutes of site setup, and about 15 minutes for each full run. For 40 plugins: about 1 to 2 hours of computer time each day.

## Later

- [ ] JS coverage from the browser (Playwright can record V8 coverage in Chromium). Then JS changes can select tests too.
- [x] Cypress runs in the sync (21 Nov 2026, server/cypress-run.ts). It uses its own site `cy-1` with a real copy of the plugin, not a link.
- [x] Test selection: research done on 21 Nov 2026. See phase 6, step 3.

## Open decisions

- How often to sync: each night or each week.
- Where the tests run (phase 4).
- (Decided: Opus, $1 for each feature, with the claude.ai login. See phase 3.)
- (Decided on 21 Nov 2026: keep test selection, with a library limit. See phase 6.)
- The library limit: 90% is the suggestion. The full run: each week or each night.
- Whether the mapping loop also runs after each sync (decided for now: button only).

## Safety

- Make a database backup before each large change (see `CLAUDE.md`).
- Never run `sudo`, directly or through a script. Check `faillock --user $USER` before and after the first test run of a session.
- To undo the site link, see `data/projects/wwp/site-link-before-trunk.txt`. To undo the app change, use the backup `data/tracker-backup-20261119-1227-before-trunk-copy.db`.
