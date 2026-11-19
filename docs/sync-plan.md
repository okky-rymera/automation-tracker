# Plan: keep the tracker in sync with new plugin code

Status on 19 Nov 2026: the trial, phase 1 and phase 2 are done. The next step is phase 3.

## Goal

The tracker must stay correct when the plugin code or the tests change. It must work for 40+ plugins, with hundreds of tests each.

## Decisions

- The tracker reads its own copy of each plugin, on `trunk`. It does not read the working copy of a developer.
- Headless Claude (`claude -p`) updates the feature data after a sync. It updates existing data. It does not map from the start.
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

1. [ ] For each feature to review, collect: the diff of its code and tests, the changed tests, and the current feature data.
2. [ ] Run `claude -p` with `--json-schema`, `--max-budget-usd`, and only read tools. It returns proposals. It does not write to the database.
3. [ ] Save the proposals through `npm run -s map -- apply` with the "AI draft" mark. The current rules stay: the AI does not change text that a person wrote or checked.
4. [ ] Test a case where the feature must change. Compare Opus and Sonnet on the quality of the answer and the cost.
5. [ ] Show the cost of each update in the app (`total_cost_usd` in the JSON output).
6. [ ] Decide: `--bare` with an API key (same result on each machine, no personal settings), or the user login (personal hooks and `CLAUDE.md` load).

## Phase 4: Scale to 40+ plugins

1. [ ] Get coverage on sites that can run in parallel. Options: add PCOV to the echowp FrankenPHP build, or use a Docker site with Xdebug or PCOV.
2. [ ] With parallel sites, each request must name its test or worker. `coverage/prepend.php` already reads an `X-Coverage-ID` header. Test a worker header that the Playwright config sets.
3. [ ] Run the sync on a schedule (each night or each week), not only by hand. Run tests only when PHP or test files changed.
4. [ ] Make adding a plugin easy: the copy, the `.env` file, the test packages, the site link, and the project in the app.
5. [ ] Decide where the runs happen: this computer, a CI server (Buddy), or a cloud machine.

## Later

- [ ] JS coverage from the browser (Playwright can record V8 coverage in Chromium). Then JS changes can select tests too.
- [ ] Cypress runs in the sync.
- [ ] Test selection, only if the numbers improve when the tests grow. Run `coverage/select-tests.py` over the history again to check.

## Open decisions

- How often to sync: each night or each week.
- Where the tests run (phase 4).
- Which model the AI update uses, and the spend limit for each feature.
- Whether to keep the test selection script, or to keep only the change report.

## Safety

- Make a database backup before each large change (see `CLAUDE.md`).
- Never run `sudo`, directly or through a script. Check `faillock --user $USER` before and after the first test run of a session.
- To undo the site link, see `data/projects/wwp/site-link-before-trunk.txt`. To undo the app change, use the backup `data/tracker-backup-20261119-1227-before-trunk-copy.db`.
