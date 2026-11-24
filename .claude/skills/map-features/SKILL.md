---
name: map-features
description: Builds the feature list in the automation tracker one small unit at a time. It takes one Playwright spec file, one Cypress .feature file, or one plugin code/settings area, studies it (reads the code, runs the test, or tries the feature with playwright-cli), then writes the feature, description, scope (its scenarios), requirements, notes, out of scope, roles and other fields into the tracker database, links each existing test to the scopes it checks, puts the plugin code (files and functions) that does the feature in it, so the app can show code coverage by feature, and adds screenshots that show how the feature looks. It works in this order: Playwright files, then Cypress files, then the code that is left. It records which files and code areas are done, so the next run continues where the last one stopped. Use this skill whenever the user wants to fill, grow or check the feature list or feature matrix, map tests to features, find which feature a test file or code file belongs to, or says things like "do the next Cypress file", "map the next feature", "continue the feature mapping", "what features does this spec cover", or "process the settings page" — even if they do not say "skill" or "feature list".
---

# Map features, one unit at a time

The automation tracker (this repo) holds a feature list for each WordPress plugin:
groups > features > scopes, plus links from Playwright tests and Cypress
scenarios to them. A scope is one separate thing the feature does, like one
scenario of a test. Each link names the scopes the test checks. People check this list in the app (Features tab). This skill
writes a first draft of it from the tests and the plugin code.

One run = one unit. A unit is one of:

- **playwright**: one spec file
- **cypress**: one `.feature` file
- **code**: one plugin feature or settings area (a few PHP/JS files that work together)

Small units keep each draft easy for a person to check, and a stopped session
loses at most one unit. So process one unit, save it, report, and stop. Do the
next unit only when the user asks for more ("do 3 more" is fine: then repeat the
whole loop 3 times, saving after each one).

## The tool

All database reads and writes go through one command, run from the tracker
repo root (`/home/chili/Works/Projects/automation-tracker`). Output is JSON.

```bash
npm run -s map -- status   <project>                    # progress
npm run -s map -- next     <project> [playwright|cypress|code]  # no kind: Playwright, then Cypress, then code
npm run -s map -- features <project>                    # compact feature list
npm run -s map -- feature  <project> <id>               # one feature, all fields and links
npm run -s map -- code     <project> <repo file>        # functions, coverage state, tests that ran them
npm run -s map -- test-code <project> playwright|cypress <ref>  # functions the tests of one test file ran (a hint)
npm run -s map -- apply    <project> <payload.json>     # write + mark the unit done (one transaction)
npm run -s map -- skip     <project> <kind> <ref> <reason>  # test units only: a code unit cannot be skipped
npm run -s map -- reset    <project> <kind> <ref>       # process that unit again next time
```

`npm run project -- list` shows the project IDs. If there is only one project, use it.

Do not write to the database in any other way (no `sqlite3` writes, no app API
calls). The tool keeps the rules that protect people's work:

- It does not change or remove text that a person wrote or checked. It can fill empty fields. Each field
  has its own AI mark, so filling an empty field does not give the right to change the other fields.
- Roles, list items (requirements too), scopes, the scopes of a link, the code of a feature and screenshots are only added.
- It does not add again code that a person removed from a feature.
- It does not add again a screenshot that a person deleted (it matches by caption).
- It does not add again a link that a person removed, and it does not change a link that a person made.
- It does not add again a scope that a person deleted or moved to another feature (it matches by title or S-id).
  The report says so, and the tool skips the requirements, links and screenshots of that scope in the payload.
  Do not send the scope again. If the moved scope belongs in this unit, send it under its new feature.
- A scope that a person renamed is still found by its old title, so the tool does not make a copy.
- It does not write to a feature or a scope marked "To remove" (`toRemove` in `features` and `feature`).
  A person decided that it must go, with its tests. The report says so, and the tool skips the text, scopes,
  links, code and screenshots for it. Do not link a new test to it: link the test to a scope that stays,
  or put it in `leftOut`. Set or clear the mark only when a person asks (see CLAUDE.md).
- It marks what it writes as "AI draft" and its links as "linked by AI", so the app shows them for review.

Links come only from people and from this skill. `@feature:` tags in the tests
do not make links, but they are a good hint for which feature a test belongs to.

The tool tells you in its `report` when it kept a person's text. Tell the user
about these items: the person may want your suggestion.

## The loop

### 1. Pick the unit

- If the user named a file or area, use it. For a test file, the unit `ref` is the
  path that `next` and the tests table use (relative to the Playwright or Cypress
  folder), not the repo path. Run `next` for that kind to see the format.
- Otherwise run `next <project>` with no kind. It keeps this order: all
  Playwright spec files first, then all Cypress `.feature` files, then the
  plugin code that the feature list does not account for yet. Do not change the order, unless the user
  names a kind. For one kind, run `next <project> <kind>`.
- In each kind, `next` gives first a file that changed
  since it was processed (`state: "changed"`), then a new file. For a changed
  file, look at `previous.features` and at tests with `newSinceLastTime: true`:
  often you only add the new tests to the features that exist.
- After the changed and new files, `next` gives a done file that has tests with
  no decision (`state: "unlinked"`). `unlinkedTests` lists them. Decide only
  those tests: link each one to the scopes it checks, or put it in `leftOut`.
  Leave the other tests of the file as they are.
- A unit that failed 2 times in one mapping loop is parked: `next` skips it
  until its files change (`state: "parked"`).
- For `code`, `next` gives the PHP files with code that the feature list does
  not account for, most lines first. Each file lists its `items`: one for each
  function, and `(code outside functions)` for the class lines, start-up code
  or template HTML outside all functions. An item is:
  - `open`: no feature holds it, and it has no `library` or `unused` decision.
    Tests can run it or not: code that tests run belongs in a feature too.
  - `check`: it was sorted, but its code changed since (a sync). `heldBy` or
    `decision` says where it is now. Keep it there (send the entry again), move
    it (`removeCode` on the old feature, `code` on the new one), or decide again.

  Choose **one plugin feature or settings area** (for
  example "Settings > Prices > Hide wholesale price column"), not one file. The
  area name is the `ref`. `unit.files` lists the files whose items the unit
  sorts. `apply` refuses a payload that leaves an item of these files out, so
  sort all items of each file you list (other items of a big file can go to
  other features or to `library` in the same payload). To choose well:
  - Big helper files (many small functions for many features): put their
    shared helpers in `library` (see "Sort the code that no test runs").
  - The coverage data comes from the Playwright run and the Cypress run, when
    the project has both. With only a Playwright run, an area with no coverage
    can still have many Cypress tests. Run `features` first: a feature with many
    Cypress links (CY) already covers that area well, so a different area is a
    better use of the run.
  - Prefer one screen, one settings section, or one REST route: about 1–6 files.
  - A file can be in more than one area (a shared menu or order file). A file
    leaves the `next` list only when each of its items is sorted.

### 2. Study it

The aim is to know what the feature does for a user, so the text is true and
not only a copy of test titles.

- **Read the unit**: the spec or `.feature` file, the page objects or step
  definitions it calls, and the plugin code that does the work (search the
  plugin repo for the setting names, hooks, REST routes or shortcodes you see).
- **For Cypress**: step text maps to code in `tests/Cypress/cypress/step_definitions`
  and `cypress/support`. Many shared steps come from the package
  `@rymera-web-co/automated-test-helper`. If its `node_modules` folder is not
  installed, do not search the disk for it: judge the step from its words.
  When the words leave a doubt, try the behavior with `playwright-cli`.
- **For test files**: run `test-code <project> <kind> <ref>`. It lists the
  plugin functions that the tests of the file ran. Use it as a hint for the
  feature's code (step 4), not as the answer: shared helpers and test setup
  show there too (`otherTests` > 0 often means shared code). Cypress tests that
  make their data through the REST API make the list longer. If the tests are
  not in a coverage run, find the code by reading it.
- **For code areas**: run `code <project> <file>` for each main file. It shows
  each function's coverage state, the tests (PW-… and CY-…) that ran it, the
  features and decision that hold it, and its `work` status (`open` or `check`).
  `outsideFunctions` is the same for the code outside all functions. These
  tests are candidates to link. The states:
  - `tested`: a test ran it while it did its checks.
  - `setup`: only the test setup ran it (log in, make products).
  - `background`: it ran during tests, but on requests the test did not cause.
  - `never`: no test ran it. It shows scopes that no test checks. Still list
    those scopes: a gap in the list is useful information.
  - `library`: it runs on every page load (menus, hooks, routes). It proves
    nothing about one feature, so its tests are not candidates.
- **Confirm the behavior before you write it.** Reading alone is not enough.
  See `references/running-tests.md` for how and for the safety rules.
  - **Playwright unit:** always run the spec file. Put the result in
    `unit.note` ("Ran the file: 2 passed") and in the report. A failed or
    flaky test is information: say which test and what failed.
  - **Cypress unit:** run it only when the user asks (it is slow). Try the
    main behavior with `playwright-cli` instead (load the `playwright-cli` skill).
  - **Code unit:** try the main behavior with `playwright-cli`, or run a
    candidate test from the `code` output.
- **Answer your own doubts. Do not ask them.** When you are not sure of a
  behavior, read the code to the result, or try it on the test site. Then
  write what you found as a scope, note or out-of-scope item. Do not state a
  guess as fact.
- **Ask a question only when one of these is true:**
  - A person must decide, for example "Is this behavior intended, or is it a bug?"
  - The answer needs something that you do not have, for example a paid
    add-on that is not on the test site.
  - Text that a person wrote or checked is now wrong. The tool cannot change
    it, so the question says what is wrong and what the code does.
- **Check each question before you send it.** Read the scopes, notes and
  requirements of the feature: they must not answer it already. Write in the
  report what you tried for each question, and why it did not give the answer.

### 3. Match against the features that exist

Run `features <project>`. **Add to an existing feature when it fits** (give its
`id`) instead of making a near copy. Make a new feature only
when no feature covers the behavior. Run `feature <project> <id>` to see the full
text and links of a candidate.

One test file can cover more than one feature: then the payload has more than
one feature. A test can link to more than one feature too, but only when it
really checks each one.

**Before you add to an existing feature, run `feature <project> <id>`** and
build on what is there. An AI draft feature can be replaced by your text, so:

- Send only what you add or make better. A list item you send as text is
  added (the same text again adds nothing). To correct one of your own AI
  draft items, send `{ "id": 12, "text": "…" }`. To delete one, put its ID in
  `removeItems`. The tool refuses both for items that a person wrote or
  checked: then name the problem in `questions` and in your report.
- Reuse a scope when it means the same thing: give its `id` (`S-4`). A new
  title makes a new scope, so a reworded copy makes a near copy.
- **Before you make a scope, read the title and the requirements of each
  scope that is there.** Do not make a scope that says the same result in
  other words. But a step to another scope's result can be its own scope,
  when a person sees its own result and it can fail by itself.
  Example: S-3 "Checking the hide checkbox and saving removes the column" and
  S-10 "A checked hide checkbox stays checked after save and page reload" are
  two scopes. A save can hide the column, while the settings page shows the
  box unchecked again. Then S-10 fails and S-3 passes.
  Link a test only to the scopes whose result it asserts. A test that checks
  the box and reloads the settings page links to S-10, not to S-3.
- A scope `description` holds only facts about the behavior that do not fit
  in the title. Leave it empty when the title says all. Do not write how you
  checked the scope ("tried by hand", "no test checks it"): put that in
  `unit.note` and in the chat report. The app already shows which scopes
  have no test.
- Exception: when a linked test checks only part of a scope, say in the
  scope `description` which part no test checks. Example: "The linked test
  sets the value directly. No test checks the box on the settings page."
  The app cannot show this gap in another way.
- Use the role names that `features` lists in `labelsInUse`, so one
  role does not get two names ("Wholesale customer", not "Wholesale buyer").
- Put a requirement that every scope shares in the feature `requirements`.
  Put a requirement of one scope in that scope's `requirements`.
- Give a scope a `group` when the feature has two or more topics, so the app
  shows the scopes of one topic together. Example: the scopes about the
  "hide column" checkbox go in group "Hide column setting". The describe
  blocks of the linked tests are a good hint. Use the groups that the feature
  has already. A feature with one topic needs no groups.
  When this unit gives a feature its second topic, put the scopes that are
  already there in groups too. Send each one with its `id`, its `title` and
  the `group`. Example: F-3 has the groups "Settings page", "Cart page" and
  "Checkout page".
- When one check applies in several places or cases (pages, roles, product
  types), write one scope with `variations`: the scope has the sentence, the
  description and the requirements. Each variation is an object with the
  column names as keys, for example
  `{ "Page": "Cart page", "Product type": "Variation" }`. F-5 has 3 such
  scopes (S-733, S-734, S-735).
  - A variation has an SV- ID (for example SV-44) and the title
    "<scope title> (<values, in column order, with commas>)". It has no
    description, no requirements and no group of its own.
  - Link each test, screenshot and code entry to the variation that it
    checks: its SV- ID or its title. A scope with variations takes no link,
    screenshot or code itself: the tool refuses the payload.
  - Write each variation that the plugin really has. Do not make all
    combinations of the values.
  - A fact about one variation only goes in the scope description, and names
    the variation. Also write "which part no test checks" there.
  - Use the column names that the scope has (see `columns` in
    `feature <id>`). A new key adds a column: the other variations have no
    value there. A scope has at most 6 columns.
  - The tool only adds variations. It does not change or delete one, and it
    does not add again a variation that a person deleted.
  - When a scope that has tests gets its first variation, its tests,
    screenshots and code go to that first variation.
  - Do not join scopes that are there already into one scope with
    variations. Write a new scope with variations only for new checks, or
    ask the person.
  - Use variations only when the sentence means the same in each place. A
    scope that checks more, or for other users, is a separate scope.
  - Use the values "Shop page", "Product page", "Cart page" and "Checkout
    page" for pages.

Choose the feature scope by behavior, not by test file. If the code you read
does the same thing for several screens or REST routes, look in the sibling
test folders for files that test the same behavior. Then one feature can hold
them all, and later units add to it.

### 4. Write the payload and apply it

Write the payload JSON to the session scratchpad folder, then run `apply`. The
format and a full example are in `references/payload.md`. Read it the first time
you write a payload in a session.

What goes in each field, in short (details and examples in `references/payload.md`):

| Field | Content |
|---|---|
| title | The feature in a few plain words, as a store owner says it |
| group | The product feature it belongs to, for example "Wholesale Price" (see Groups). Not a screen type like "Settings" |
| description | 1–3 sentences: what it does and why a store owner uses it |
| priority | high / medium / low: how bad a failure is for stores. Leave empty if unsure |
| roles | Labels: who uses or sees it ("Admin", "Wholesale customer") |
| requirements | List: what must be true for every scope: plugins, settings, data, the logged-in user |
| where | List: admin screens, settings tabs, shop pages, REST routes |
| notes | List: only what no test can check: reasons, code facts, limits. A testable rule is a scope |
| outOfScope | List: what it does not do; name the feature that does it if there is one |
| questions | List: only what a person must decide, or what you tried and could not prove |
| scopes | The separate things it does, like test scenarios, each with a visible result, an optional group (topic), and its own requirements |
| links | Each test, with the scopes it checks |
| code | The plugin files or functions that do the feature |
| screenshots | Images of the feature: a PNG file, a caption, and the scopes it shows |

Link every test in the unit that checks a feature, **to the scopes it checks**.
A link with no scope says only "this test is about the feature", which tells a
reader little. So make the scopes first, then link each test to its scopes.
Leave out the scopes only for a test that checks the feature in general.
Do not link a test that checks only the page before the feature changes it.
Put it in `leftOut` (see "No scope for the page before the feature changes it"
in `references/payload.md`).
Points to know:

- **A test can check several scopes.** Give all of them in `scopes` (a list).
  Give only the scopes the test really checks with an assert or an expected
  result, not the steps it only passes through on the way.
- **One test ID can be several runs.** A `Scenario Outline` with an Examples
  table, or a Playwright test made in a loop (its title shows `${…}`), has one
  ID. Write the scope so it matches all the rows or runs, or link the test to
  each variation that it runs.
- **A code unit** has no tests of its own. Link the candidate tests from the
  `code` output, or send no links if no test checks the area.
- **Links only**: to add links to a feature without new text, send just
  `id` and `links` for it.
- The tool only adds scopes to a link. It never removes one. If a scope on a
  link is wrong, say so in the report: a person removes it in the app.
- **Decide each test of the file.** Link it, or put it in `leftOut`. The tool
  refuses a test-file payload that leaves a test with no decision, because
  `next` would give the file again and again. A test fits no feature when it is
  a setup file, a helper, or a test of something that is gone:

  ```json
  "leftOut": [
    { "testId": "PW-1a2b3c", "reason": "Setup only: it makes the products that other tests use." }
  ]
  ```

  `leftOut` goes at the top level of the payload, next to `features`. A test
  unit can send only `leftOut`, with an empty `features` list. If the whole
  file has no feature, run `skip` with the reason. A person sees the left-out
  tests in the app and can send one back to you.

**Put the code of the feature in `code`.** The app uses it to show code
coverage by feature (Features tab > "Code by feature"). Give:

- `{ "file": "includes/class-x.php" }` when the whole file does this feature.
- `{ "file": "includes/class-x.php", "functions": ["Class_X::method"] }` when
  only some functions do it. Use the function names exactly as `code` or
  `test-code` lists them. The tool refuses a name that the coverage run does not know.
- **Name the scopes of the code.** Add `"scopes": ["<scope title or S-id>"]` to
  each entry: the scopes that this code does. Leave `scopes` out only for code
  that does the feature in general (its menu, its settings page frame). The
  app then shows which scopes have code but no test: the tests to write next.
  Example: `{ "file": "includes/class-x.php", "functions": ["Class_X::save"], "scopes": ["Save the price"] }`.
- Put in only code that does the feature: its settings, screens, hooks, REST
  routes and the logic behind them. Leave out shared helpers, plugin start-up
  code and test setup. One function can be in more than one feature when it
  really does each of them.
- **A template goes with the code that loads it.** When a function of the
  feature loads a template or a data file (`require WWP_VIEWS_PATH .
  'view-x.php'`, `$i18n = require ... 'I18n/settings.php'`), put that file in
  the same feature as a whole file: `{ "file": "views/view-x.php" }`. The
  template has no functions, so the coverage run does not name it, but it is
  the screen of the feature.
- For a test file, start from `test-code`, then read the code to check it.
  For a code area, use the files of the area.
- The tool only adds code, with one exception: `removeCode` on a feature takes
  out code that the AI added, to move it after a change:
  `"removeCode": [{ "file": "includes/class-x.php", "function": "Class_X::old" }]`
  (no function: the whole-file entry). Code that a person added stays. If
  other code you added before is wrong, say so in the report: a person removes it in the app.

**Sort the code (code units).** For each `open` or `check` item of the files
in `unit.files`, decide (the coverage state does not matter: `tested` code
needs a feature too). If `next <project> code` says "No coverage run yet",
stop: the code work comes from a coverage run, so no code unit is possible.

- **Feature code**: it does something a user or admin can see or use (a
  setting, a screen, a REST route, a price rule, an email). Put it in the
  `code` of a feature, with the scope it does. If no scope fits, make a scope
  for it, with no test link. If no feature fits, make a feature. Write the
  scopes from the code, as for any feature.
- **Library code**: start-up, hook registration, small helpers that many
  features call, or glue. Put it in the top-level `library` list of the
  payload, one entry for each function, with a reason. `"function": ""` is the
  code outside all functions of the file:

  ```json
  "library": [
    { "file": "includes/class-x.php", "function": "Class_X::helper", "reason": "A small helper that the price and cart features call." },
    { "file": "plugin.bootstrap.php", "function": "", "reason": "Start-up checks: the plugin stops when WooCommerce is missing." }
  ]
  ```

  The app then counts its lines as library code, not as code that no test
  runs, and `next` does not offer it again. A person can remove a decision.
  The `ABSPATH` guard at the top of a file and blank lines are library
  already: the app finds them itself.
- **Unused code**: no plugin code loads or calls it (search the plugin for its
  name or file name first, and say what you searched in the reason). Put it in
  the top-level `unused` list, in the same form as `library`. The overview
  shows it apart, so the team can delete it. A template that no PHP file
  `require`s is unused as a whole: `{ "file": "views/view-x.php", "function": "", "reason": "No PHP file requires it (searched for view-x)." }`.
- A code unit can send only `library` and `unused`, with an empty `features`
  list. A code unit cannot be skipped: code that fits no feature is library or unused.
- Do not leave an item out: `apply` refuses the payload and names the items.

**Add screenshots, so a person sees how the feature looks.** People open the
feature page to learn the feature. A picture of the settings and of the result
shows it faster than text.

- **When:** the feature has a screen that a person sees: an admin screen, a
  settings section, or a shop page. A REST API or background feature has no
  screen: send no screenshots.
- **Each scope with a visible result gets a screenshot tag.** This includes
  each scope you add to or link in this unit. Run `feature <project> <id>`
  first, and look at the `scopes` of each screenshot, not only the captions.
  Then, for each scope that no screenshot shows:
  1. Look at the existing images. Export them with a read-only command (no writes):
     `npm run -s map -- screenshots <project> <id> <scratchpad>`. It lists each file with its caption.
     Then open the PNG files with the Read tool.
  2. If an image shows the scope, send that screenshot again with its
     caption (or its `firstCaption`) and the scope in `scopes`. The tool adds
     only the tag. It does not need the file for a screenshot that is there.
  3. If no image shows it, take a new screenshot.
- **What:** 1–4 screenshots for each feature. Take the place where a person
  sets it up (the settings or the edit screen), and the result that the user
  sees (for example, the shop page with the wholesale price). One screenshot
  for each scope is not necessary.
- **How:** use `playwright-cli` on the test site, as `references/running-tests.md`
  says. Its safety rules apply. Set the window to 1280×800
  (`playwright-cli resize 1280 800`). Scroll so that the part that matters is
  in view, and take a screenshot of the window
  (`playwright-cli screenshot --filename=<path>.png`). Do not take a full page
  of a long screen. Save the PNG files in the
  session scratchpad folder, and give their full paths in the payload.
- **One scope at a time:** turn on only the settings that the scope needs.
  Keep the other settings at their default values. A test can change many
  settings in one scenario. Do not copy all of them into the picture. If the
  site has other settings on before you start, set them to their defaults
  first, and set them back after the screenshot.
  Outside the mapping loop, change site settings only when no loop runs. A
  loop test on the same site can need those settings. To check, run
  `curl -s localhost:5174/api/projects/<project>/map-loop`. If it shows
  `"running":true`, wait or ask the user.
- **Show where it is:** do not crop to the setting. Take the window, so that
  the admin menu, the tab and the setting show together. If they do not fit
  in 1280×800, make the window taller (for example `resize 1280 1080`).
- **Own browser:** the mapping loop can use the default browser at the same
  time. Outside the loop, use a named session (`playwright-cli -s=<name>`).
- **Data:** do not show passwords, license keys, API keys or real customer
  data in the image. If a setting must change to show a result, set it back
  after the screenshot.
- **Caption:** say what the image shows, in plain words, for example
  "Settings > Prices: the option to hide the wholesale price column". Each
  caption in a feature must be different. The tool uses the caption to find a
  screenshot that is already there, so the same caption adds nothing. A person
  can change a caption: `feature <project> <id>` then shows the caption you
  sent as `firstCaption`. Use that one to refer to the screenshot.
- **Scopes:** give the scopes whose result the image shows. Leave them out for
  an image of the feature in general.

The tool only adds screenshots. It does not change an image that is there. If a
screenshot you added before is wrong, say so in the report: a person deletes
it in the app. `feature <project> <id>` shows deleted screenshots with
`removed: true`. Do not send their captions again.

If `apply` fails, nothing was saved. Read the error, fix the payload, run it again.

### 5. Report and stop

Tell the user, in plain words:

- which unit you processed, and how you checked it (read, ran the test, tried it), with the test result
- the features you made or added to, with their IDs (F-12), and the scopes (S-4)
- which tests you linked, and which you did not link and why
- the code you put in each feature (files and functions)
- the screenshots you added or tagged, with their captions and scopes, or why a scope has none
- each open question you added, what you tried, and why a person must answer it
- any person's text that the tool kept
- the progress (`status`): for example "Cypress: 5 of 82 files done"

Then stop. Say the command or phrase to do the next unit.

## Groups

A group is the product feature that a store owner knows, for example
"Wholesale Price", "Wholesale Roles", "Order Form". Choose it by what the
feature does, not by where it is set or tested:

- Do not use the screen type as a group ("Settings", "Admin screens"). A
  setting goes in the group of the behavior that it changes. Example: the
  "Wholesale Price Text" setting changes the wholesale price, so its group is
  "Wholesale Price", not "Settings".
- Do not use the test folder (`backend/settings/…`) or the `@area:` tag as
  the group.
- Use the names that the plugin uses in its menus and docs.
- Use the groups that exist (`features` lists them) when one fits. Make a new
  group only when none fits. A screen-type group ("Settings", "Admin
  screens", "Pricing") never fits, also when it exists.
- For an existing feature that has a group, send `group` only when its group
  is an AI draft. The tool keeps a group that a person set.
- If an existing feature is in a screen-type group or another wrong group,
  do not move it. In the report, name the feature, its group and the group
  you suggest. A person moves it in the app, or tells you to move it.

### Integration groups

Some behavior works only when another plugin is active. This can be a
third-party plugin (WooCommerce Product Bundles) or another plugin of the
same company (Premium, Lead Capture, Order Form, Payments). A person must
install that plugin to test it, so it must not hide inside a core feature.

- Put such a feature in the group "Integration/<plugin name>", for example
  "Integration/Wholesale Prices Premium". Use the existing Integration group
  for the plugin when there is one.
- Do not add "With Premium …" scopes to a core feature. Make or use a
  separate feature in the Integration group, for example "Wholesale price
  for each Premium wholesale role" next to the core "Per-product wholesale
  price".
- Some scopes show the locked field or the upsell when the other plugin is
  not active. Put these scopes in the same Integration feature. Example:
  "Without Lead Capture, the Register Text field is locked". A whole upsell
  page or popup for another plugin is different: it goes in the "Upsells"
  group (see "No scopes for marketing text").
- Link a test from an `Integration/<plugin>/` folder, or with an
  `@integration:<plugin>` tag, only to Integration features. Do not link it
  to a core scope, also when it checks the core behavior on the way.
- If a core feature already has integration scopes, do not move them and do
  not add to them or link tests to them. In the report, name each scope and
  the Integration feature you suggest. A person moves it, or tells you to.
- Make the feature and its scopes make sense as product behavior. Do not
  copy the layout of the test files.

## Writing style

Write all feature text in plain, simple English, as the user's CLAUDE.md asks:
short sentences, active voice, common words, no internal code names. A person
who does not read code must understand each feature. Put code names (hooks,
option keys, class names) only in `where` or `requirements`, and only when
they help a tester find the thing.

Write about behavior, not about tests: do not name spec files or test IDs in
feature text. The links show which tests check what.

The actor of a scope is the person or system that acts: admin, shop
manager, wholesale customer, guest, or for an API "an API client". When the
feature requirements name the user ("Logged in as admin or shop manager"),
the scope titles do not repeat it.

**Scope titles must not contradict each other.** Read the titles one after the
other, under the feature title. Each title says what is different about its
scope. When the difference is a requirement, name it in a few plain words
("The hide setting removes the column"), and put the exact setting in the
scope requirements.

**One sentence pattern for scopes that check the same thing.** Some scopes
check the same result in different places: another page, another role,
create or update. Write them with the same pattern, so that only the
different part changes. Before you write a scope, read the other scope titles
of the feature. Copy their sentence order. The word list and the subject rule
below always win: when an old title uses a word from the "Do not write"
column, or has no subject, copy only its sentence order, not those words.

- Good: "Wholesale customer sees the discounted wholesale price of a
  percentage discount on the shop page", "… on the product page", "… in the cart".
- Bad: "A percentage discount shows the discounted price on the shop page" and
  "Wholesale customer sees the percentage wholesale price in the cart".

Give each title a subject: "The column shows the role name", not "Shows the
role name". Do not write a title with no verb, such as "Empty cell for a
product with no wholesale price". When the feature requirements already name
the user, do not use the user as the subject (see the actor rule above). Use
the page or the thing as the subject: "The cart shows the wholesale price".

**Do not make copies when you reword.** The tool finds an existing scope by
its ID, or by its exact title. A changed title without an ID makes a new
scope, and the test links are split between the two.

- To reword a scope that the AI wrote, send its `id` with the new title.
- Do not reword a scope that a person wrote or checked. Send its title exactly
  as it is, or send only its `id`.
- To send a screenshot again, use its `firstCaption` from `feature <id>`
  exactly. A reworded caption can add a screenshot that a person deleted.

Use these words, and only these words, for these things:

| Thing | Write | Do not write |
|---|---|---|
| The price without a wholesale discount | regular price | retail price, normal price |
| A price with a line through it | crossed-out price, or "with the regular price crossed out" | struck through, struck-through |
| The page of one product | product page | single product page |
| An API scope that creates or updates | "Create: …", "Update: …" | no prefix on one of the two |

Quote a UI label as it is, also when it uses another word, for example the
setting "Hide Retail Price".

An API title has the prefix, then a subject, then a verb: "Create: a simple
product gets the wholesale price, and the response shows it for that role".

**No scopes for marketing text.** Promotion screens are upsell pages,
upgrade popups, About pages and Getting Started pages. Their marketing text
changes often. Examples are headings, feature lists, reasons to buy, bonus
offers, logos and reviews. A check of that text is fragile. It tests nothing
that the plugin does.

- Do not write a scope that checks only that text. A scope such as "The page
  shows the upsell title and description" or "The popup shows a short text"
  must not exist.
- Do not quote that text in new scope titles, descriptions or screenshot
  captions. Write "the upsell page" or "the upgrade popup", not its heading.
- Keep the caption of a screenshot that is there already. The tool matches
  screenshots by caption, so a new caption adds a copy.
- Write scopes for what the screen does:
  - when it shows or hides,
  - what opens it,
  - where each button or link goes,
  - what a button installs or turns on.
- A short button or link label is fine when it names the thing that a person
  clicks, for example "Activate Plugin".
- Link a test that also checks what the screen does to those scopes only.
  Put a test that checks only marketing text in `leftOut`, with the reason
  "Checks only marketing text".
- A feature can already have a scope that checks only marketing text. Do not
  change it and do not link tests to it. Name it in the report, so a person
  can delete it or mark it "To remove".
- The same promotion screen can exist for several plugins. For new scopes,
  write one scope with variations, with a "Plugin" column. Do not make one
  feature for each plugin. For scopes that are there already, follow the
  variations rule: do not join them, but name them in the report.
- A whole upsell page or popup for another plugin goes in the "Upsells"
  group. It shows when that plugin is not active, so you can test it without
  that plugin. This is an exception to "Integration groups". A locked field
  inside a screen of an Integration feature stays in that Integration feature.

**Settings that turn something off** ("Hide …", "Disable …", "Do not …"): do
not write "the setting is on" or "off" anywhere. Quote the label and say
"checked" or "unchecked", or say what the setting does. See
`references/payload.md` > scopes.
