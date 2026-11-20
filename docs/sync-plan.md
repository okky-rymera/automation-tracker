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

## Later

- [ ] JS coverage from the browser (Playwright can record V8 coverage in Chromium). Then JS changes can select tests too.
- [ ] Cypress runs in the sync.
- [ ] Test selection, only if the numbers improve when the tests grow. Run `coverage/select-tests.py` over the history again to check.

## Open decisions

- How often to sync: each night or each week.
- Where the tests run (phase 4).
- (Decided: Opus, $1 for each feature, with the claude.ai login. See phase 3.)
- Whether to keep the test selection script, or to keep only the change report.
- Whether the mapping loop also runs after each sync (decided for now: button only).

## Safety

- Make a database backup before each large change (see `CLAUDE.md`).
- Never run `sudo`, directly or through a script. Check `faillock --user $USER` before and after the first test run of a session.
- To undo the site link, see `data/projects/wwp/site-link-before-trunk.txt`. To undo the app change, use the backup `data/tracker-backup-20261119-1227-before-trunk-copy.db`.
