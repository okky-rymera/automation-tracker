---
name: map-features
description: Builds the feature list in the automation tracker one small unit at a time. It takes one Playwright spec file, one Cypress .feature file, or one plugin code/settings area, studies it (reads the code, runs the test, or tries the feature with playwright-cli), then writes the feature, description, scope (its scenarios), rules, out of scope, roles and other fields into the tracker database and links each existing test to the scopes it checks. It records which files and code areas are done, so the next run continues where the last one stopped. Use this skill whenever the user wants to fill, grow or check the feature list or feature matrix, map tests to features, find which feature a test file or code file belongs to, or says things like "do the next Cypress file", "map the next feature", "continue the feature mapping", "what features does this spec cover", or "process the settings page" — even if they do not say "skill" or "feature list".
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
npm run -s map -- next     <project> playwright|cypress|code
npm run -s map -- features <project>                    # compact feature list
npm run -s map -- feature  <project> <id>               # one feature, all fields and links
npm run -s map -- code     <project> <repo file>        # functions, coverage state, tests that ran them
npm run -s map -- apply    <project> <payload.json>     # write + mark the unit done (one transaction)
npm run -s map -- skip     <project> <kind> <ref> <reason> [--files a.php,b.php]  # code needs --files
npm run -s map -- reset    <project> <kind> <ref>       # process that unit again next time
```

`npm run project -- list` shows the project IDs. If there is only one project, use it.

Do not write to the database in any other way (no `sqlite3` writes, no app API
calls). The tool keeps the rules that protect people's work:

- It does not change or remove text that a person wrote or checked. It can fill empty fields. Each field
  has its own AI mark, so filling an empty field does not give the right to change the other fields.
- Roles, needs, list items, scopes and the scopes of a link are only added.
- It does not add again a link that a person removed, and it does not change a link that a person made.
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
- Otherwise run `next <project> <kind>`. It gives first a file that changed
  since it was processed (`state: "changed"`), then a new file. For a changed
  file, look at `previous.features` and at tests with `newSinceLastTime: true`:
  often you only add the new tests to the features that exist.
- For `code`, `next` gives candidate PHP files with the most code that no
  Playwright test ran. Choose **one plugin feature or settings area** (for
  example "Settings > Prices > Hide wholesale price column"), not one file. The
  area name is the `ref`. To choose well:
  - Skip big helper files (many small functions for many features). Their code
    gets mapped through the areas that use it.
  - The coverage data comes from Playwright only. An area with no Playwright
    coverage can still have many Cypress tests. Run `features` first: a feature
    with many Cypress links (CY) already covers that area well, so a different
    area is a better use of the run.
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
  installed, do not search the disk for it: judge the step from its words, and
  put real doubts in `questions`.
- **For code areas**: run `code <project> <file>` for each main file. It shows
  each function's coverage state and the Playwright tests that ran it. These
  tests are candidates to link. The states:
  - `tested`: a test ran it while it did its checks.
  - `setup`: only the test setup ran it (log in, make products).
  - `background`: it ran during tests, but on requests the test did not cause.
  - `never`: no test ran it. It shows scopes that no test checks. Still list
    those scopes: a gap in the list is useful information.
  - `library`: it runs on every page load (menus, hooks, routes). It proves
    nothing about one feature, so its tests are not candidates.
- **Try it, when reading leaves a doubt** about what the user sees: run the test,
  or open the feature with `playwright-cli` (load the `playwright-cli` skill). See
  `references/running-tests.md` for how and for the safety rules. Do this
  before you write text that you are not sure of. If you cannot confirm a
  behavior, put it in `questions` instead of stating it as fact.

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
- Use the role and need names that `features` lists in `labelsInUse`, so one
  role does not get two names ("Wholesale customer", not "Wholesale buyer").

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
| group | The product area, for example "Pricing", "Settings", "REST API" |
| description | 1–3 sentences: what it does and why a store owner uses it |
| priority | high / medium / low: how bad a failure is for stores. Leave empty if unsure |
| roles | Labels: who uses or sees it ("Admin", "Wholesale customer") |
| needs | Labels: settings, plugins or features it needs ("WooCommerce") |
| where | List: admin screens, settings tabs, shop pages, REST routes |
| rules | List: the rules it must follow, one item each |
| outOfScope | List: what it does not do; name the feature that does it if there is one |
| questions | List: what you could not confirm |
| scopes | The separate things it does, like test scenarios, each with a visible result |
| links | Each test, with the scopes it checks |

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

If `apply` fails, nothing was saved. Read the error, fix the payload, run it again.

### 5. Report and stop

Tell the user, in plain words:

- which unit you processed, and how you checked it (read, ran the test, tried it)
- the features you made or added to, with their IDs (F-12), and the scopes (S-4)
- which tests you linked, and which you did not link and why
- open questions, and any person's text that the tool kept
- the progress (`status`): for example "Cypress: 5 of 82 files done"

Then stop. Say the command or phrase to do the next unit.

## Groups

Use the groups that exist (`features` lists them). If there are none yet, use
names from this list, so that later runs use the same names: Pricing,
Products, Cart and checkout, Orders, Customers and roles, Settings, Admin
screens, REST API, Import and export, Onboarding, Integrations.

## Writing style

Write all feature text in plain, simple English, as the user's CLAUDE.md asks:
short sentences, active voice, common words, no internal code names. A person
who does not read code must understand each feature. Put code names (hooks,
option keys, class names) only in `where` or `needs`, and only when
they help a tester find the thing.

Write about behavior, not about tests: do not name spec files or test IDs in
feature text. The links show which tests check what.

The actor of a scope is the person or system that acts: admin, shop
manager, wholesale customer, guest, or for an API "an API client".
