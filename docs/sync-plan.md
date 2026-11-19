# Plan: keep the tracker in sync with new plugin code

Status on 19 Nov 2026: the trial and phases 1 to 3 are done. The next step is phase 4.

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
- (Decided: Opus, $1 for each feature, with the claude.ai login. See phase 3.)
- Whether to keep the test selection script, or to keep only the change report.

## Safety

- Make a database backup before each large change (see `CLAUDE.md`).
- Never run `sudo`, directly or through a script. Check `faillock --user $USER` before and after the first test run of a session.
- To undo the site link, see `data/projects/wwp/site-link-before-trunk.txt`. To undo the app change, use the backup `data/tracker-backup-20261119-1227-before-trunk-copy.db`.
