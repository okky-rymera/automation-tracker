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
npm run -s map -- skip     <project> <kind> <ref> <reason> [--files a.php,b.php]  # code needs --files
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
  plugin code that no unit holds yet. Do not change the order, unless the user
  names a kind. For one kind, run `next <project> <kind>`.
- In each kind, `next` gives first a file that changed
  since it was processed (`state: "changed"`), then a new file. For a changed
  file, look at `previous.features` and at tests with `newSinceLastTime: true`:
  often you only add the new tests to the features that exist.
- For `code`, `next` gives candidate PHP files with the most **open**
  functions: no test runs them, no feature holds them, and they are not
  library code. A file with `changedSinceArea: true` is in a code area that is
  done, but a sync changed it: look only at its open functions. Choose **one plugin feature or settings area** (for
  example "Settings > Prices > Hide wholesale price column"), not one file. The
  area name is the `ref`. To choose well:
  - Big helper files (many small functions for many features): put their
    shared helpers in `library` (see "Sort the code that no test runs").
  - The coverage data comes from the Playwright run and the Cypress run, when
    the project has both. With only a Playwright run, an area with no coverage
    can still have many Cypress tests. Run `features` first: a feature with many
    Cypress links (CY) already covers that area well, so a different area is a
    better use of the run.
  - Prefer one screen, one settings section, or one REST route: about 1–6 files.
  - A file can be in more than one area (a shared menu or order file). A file in
    any done area leaves the `next` candidate list.

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
  each function's coverage state and the tests (PW-… and CY-…) that ran it. These
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
Points to know:

- **A test can check several scopes.** Give all of them in `scopes` (a list).
  Give only the scopes the test really checks with an assert or an expected
  result, not the steps it only passes through on the way.
- **One test ID can be several runs.** A `Scenario Outline` with an Examples
  table, or a Playwright test made in a loop (its title shows `${…}`), has one
  ID. Write the scope so it matches all the rows or runs, or link the test to
  one scope for each row.
- **A code unit** has no tests of its own. Link the candidate tests from the
  `code` output, or send no links if no test checks the area.
- **Links only**: to add links to a feature without new text, send just
  `id` and `links` for it.
- The tool only adds scopes to a link. It never removes one. If a scope on a
  link is wrong, say so in the report: a person removes it in the app.
- If a test fits no feature (a setup file, a helper, a test of something that
  is gone), say so in the report and leave it out. If the whole file has no
  feature, run `skip` with the reason.

**Put the code of the feature in `code`.** The app uses it to show code
coverage by feature (Features tab > "Code by feature"). Give:

- `{ "file": "includes/class-x.php" }` when the whole file does this feature.
- `{ "file": "includes/class-x.php", "functions": ["Class_X::method"] }` when
  only some functions do it. Use the function names exactly as `code` or
  `test-code` lists them. The tool refuses a name that the coverage run does not know.
- Put in only code that does the feature: its settings, screens, hooks, REST
  routes and the logic behind them. Leave out shared helpers, plugin start-up
  code and test setup. One function can be in more than one feature when it
  really does each of them.
- For a test file, start from `test-code`, then read the code to check it.
  For a code area, use the files of the area.
- The tool only adds code. If code you added before is wrong, say so in the
  report: a person removes it in the app.

**Sort the code that no test runs (code units).** For each open function of the
area (state `never`, `setup` or `background` in the `code` output), decide:

- **Feature code**: it does something a user or admin can see or use (a
  setting, a screen, a REST route, a price rule, an email). Put it in the
  `code` of a feature. If no feature fits, make a feature or a scope for it,
  with no test link. Write its scopes from the code, as for any feature.
- **Library code**: start-up, hook registration, small helpers that many
  features call, glue, or code that nothing calls. Put it in the top-level
  `library` list of the payload, one entry for each function, with a reason:

  ```json
  "library": [
    { "file": "includes/class-x.php", "function": "Class_X::helper", "reason": "A small helper that the price and cart features call." }
  ]
  ```

  The app then counts its lines as library code, not as code that no test
  runs, and `next` does not offer it again. A person can remove a decision.
  A code unit can send only `library`, with an empty `features` list.
- Do not leave an open function out. A function you leave out comes back
  only when a sync changes its file.

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
  (`playwright-cli resize 1280 800`). Take a screenshot of the part that
  matters (`playwright-cli screenshot e12 --filename=<path>.png`), or of the
  window. Do not take a full page of a long screen. Save the PNG files in the
  session scratchpad folder, and give their full paths in the payload.
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

**Settings that turn something off** ("Hide …", "Disable …", "Do not …"): do
not write "the setting is on" or "off" anywhere. Quote the label and say
"checked" or "unchecked", or say what the setting does. See
`references/payload.md` > scopes.
