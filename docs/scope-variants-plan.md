# Plan: scope variants (one check on several pages)

Status on 23 Nov 2026: all steps are done. Step 9 replaced the "scope set" of steps 1 to 8: there is now one kind of thing, a scope, and a scope can have variations. Steps 1 to 8 stay here as the history of the decision. The checks were done as scripts on a copy of the database, because the project has no test framework.

## Goal

Some scopes check the same thing in different places. Example from F-5 (per-product wholesale price):

- S-44: wholesale price with the regular price crossed out, on the shop page
- S-41: the same, on the product page
- S-37: the same, in the cart
- S-426: the same, at checkout

The tracker must show these as one sentence with a table of values:

```
Wholesale customer sees the wholesale price with the regular price crossed out
| Page          | Tests      |
|---------------|------------|
| Shop page     | covered    |
| Product page  | covered    |
| Cart page     | covered    |
| Checkout page | no test    |
```

Each row keeps its own test links, coverage, screenshots and code.

## What other apps do (research on 23 Nov 2026)

- TestRail, Qase, Xray, Allure TestOps and Azure Test Plans keep one test case with a table of values. Each row gets its own result.
- Gherkin "Scenario Outline" with "Examples" is the same form. Each row runs as its own test.
- Known weak points:
  - Xray gives no report for each value.
  - In Azure, an automated test cannot link to one row.
  - In Qase, all rows share one expected result.

The tracker must not copy these weak points. A test must link to a row, not to the whole table.

## Decisions

### A row is a scope

Each row stays a normal scope, with its own S-id. The sentence above the rows is a new "scope set". It is not a scope.

Reason: many parts of the tracker find a scope by its ID. With rows as scopes, these parts need no change:

- test links (`link_scopes`, `server/features.ts:1031`)
- screenshots and code entries (`screenshot_scopes`, `code_scopes`, `server/map.ts:1011`)
- scope requirements (`feature_items.scope_id`, `server/db.ts:352`)
- the "To remove" mark, the AI marks and the "before" values
- the remembered old titles (`scope_titles_gone`, `server/features.ts:422`)
- the coverage counts (`scopeLinks` and `scopesToTest`, `web/src/app/data.ts:146` and `:210`)

S-37, S-41, S-44 and S-426 keep their IDs. No test link moves.

The set is in its own table, like scope groups (`scope_groups`, `server/db.ts:482`). Thus the set never counts as a scope with no test.

### A row keeps a full title

Each row keeps a full sentence as its title. The app makes it from the set sentence and the value: "Wholesale customer sees the wholesale price with the regular price crossed out (Cart page)".

Reason: the AI skills find a scope by its title (`resolveScopes`, `server/map.ts:1021`). The Tests page and the link list show the title alone. A title of only "Cart page" does not tell what the test checks.

The Feature screen shows only the value in the table. The full title shows on hover.

### One column first

A set has one column, with a name (default "Page"). More columns come later.

### Rules

- A test links to a row. The link list does not offer the set itself.
- The count "N of M scopes covered" does not change when scopes go into a set.
- A set sits in a scope group, in the same place as a scope.

## Steps

### 1. Database

- [x] Add migration step 34 in `server/db.ts` (step 33 is the last, `server/db.ts:689`):
  - New table `scope_sets`: `id`, `feature_id`, `group_id`, `title` (the sentence), `column_name`, `sort`, `ai_made`.
  - New columns on `scopes`: `set_id` (empty: not in a set) and `set_value` (for example "Cart page").
- [x] Show the sets in the feature data (`featureData`, `server/features.ts:160`).

### 2. API

- [x] `POST .../features/:fid/scope-sets` with `{ "title", "column" }`: add a set.
- [x] `PATCH .../scope-sets/:id` with `{ "title" }` or `{ "column" }`: change it. A new sentence changes the title of each row too. The old titles are remembered, as in a scope rename (`server/features.ts:819`).
- [x] `DELETE .../scope-sets/:id`: delete the set. Its rows stay as normal scopes.
- [x] `POST .../scope-sets/:id/rows` with `{ "value" }`: add a row. This makes a new scope with the full title.
- [x] `PATCH .../scopes/:sid` with `{ "setId", "setValue" }`: put a scope in a set, or take it out (`null`).
- [x] Update these edits:
  - Move (`moveScope`, `server/features.ts:845`): the row goes into the set with the same sentence on the target. If the target has no such set, the app makes one.
  - Merge (`mergeFeature`, `server/features.ts:631`): the sets go with their rows.
  - Delete (`deleteScope`, `server/features.ts:1008`): when the last row goes, the set goes too.

### 3. Web page

- [x] Feature screen (`web/src/app/screens/Feature.tsx`): show a set as one block. Show the sentence, then a table with the value, the coverage and the tests of each row.
- [x] Add "Add set", "Add row" and "Put in set" buttons.
- [x] Link list: not changed. A person links a test from inside a row, so the set cannot get a link.
- [x] Check that other screens still show the full row title: Tests, Test, Overview and Feature list.

### 4. AI skills and command line

- [x] Let the AI send a set for a scope: `ScopeIn` gets `set: { title, column, value }` (`server/map.ts:523`).
- [x] Update `.claude/skills/map-features` and `.claude/skills/answer-questions`. When one check applies to several pages, write one set with rows.
- [x] Update the AI review (`server/ai-update.ts`) in the same way.
- [x] Show the sets in `npm run -s map -- feature`.
- [x] Add the new routes to the route table in `CLAUDE.md`.

### 5. Convert F-5

- [x] Make a backup of `data/tracker.db`.
- [x] Make the sets through the API, not with SQL. Candidates in F-5:
  - "Wholesale customer sees the wholesale price with the regular price crossed out": S-44, S-41, S-37, S-426
  - "Customers and guests see only the regular price": S-45, S-42, S-39. S-429 stays out: it is about regular customers only, and it also checks the subtotal.
  - "A product with no wholesale price keeps its regular price for a wholesale customer": S-430, S-431, S-425, S-427
- [x] The present titles do not use one sentence. For example, S-426 says "of each item at checkout". Each row gets the new full title. The old title is remembered, so the AI does not make it again.
- [x] Check that the F-5 coverage count is the same before and after. Result: 44 of 48 before and after, and the same test links.
- [x] The rows were in page groups. All rows of a set must be in one group, so the 3 sets are in "No group".

### 6. Tests

- [x] Check the set edits on a copy of the database: add, change, delete, move, merge, delete of the last row, and the AI write. The project has no test framework, so the checks are a script, not saved tests.

### 7. More columns (added on 23 Nov 2026)

- [x] Migration step 35: a set has a list of column names, and a row has a list of values.
- [x] A person names each column, adds a column, renames it and deletes it. A set has 1 to 6 columns.
- [x] A person or the AI types each row. The app does not make combinations: some combinations do not make sense, for example a price range on the product page.
- [x] The AI sends `values` with the column names as keys. A new key adds a column.
- [x] The Feature screen shows the set as a table with a header row.
- [x] Checked on a copy of the database: columns, rows, moves, AI writes, and the screen.

### 8. Set text and a table layout (added on 23 Nov 2026)

Research: data tables with rows that open in place (Carbon, PatternFly, American Express, Visa), and test tools (Xray, Qase, CucumberStudio, Allure). They edit a check once, on the parent, and keep the status of each row in its line.

- [x] Migration step 36: a set has a description and requirements for each row. A row has no description.
- [x] A row title always comes from the sentence and the values. A person cannot rename it.
- [x] The group and "Move to feature" are on the set. A set moves with all its rows.
- [x] The Feature screen shows a set as a card. It opens to the set text and a table: ID with copy button, values, coverage, tests. A row opens in place for its values, its own requirements, its tests and its screenshots.
- [x] F-5: the shared text moved to the 3 sets. Coverage and test links did not change.
- [x] A row has no requirements either. A scope that joins a set gives its requirements to the set. In F-5, the S-426 requirement (a cart with a fixed price and a percentage discount) is now a sentence in the set description, because it is true only at checkout.

### 9. One kind of thing: a scope with variations (added on 23 Nov 2026)

Problem with steps 1 to 8: a set and a scope were two different things. A person could put a scope into a set, and then its requirements went to the set and applied to each row, which was wrong for one row.

Research: WooCommerce variable products and Shopify product variants. A product is one thing. With no options, the price and image are on the product. With options, each variant has its own price and image, and the product keeps the description. Azure Test Plans gives each parameter row its own result. Xray does not show the coverage of each value, so the tracker links tests to a variation, never to the whole scope.

- [x] Migration step 37: `scopes.columns` (a scope with variations) and `scopes.parent_id` and `var_values` (a variation). Each set became a scope with a new S-id: S-733, S-734 and S-735 in F-5. The rows became their variations and kept their numbers, with the prefix SV- (S-44 is SV-44 now).
- [x] The scope has the sentence, description, requirements, group and move. A variation has its values, test links, screenshots, code and coverage.
- [x] A scope with variations takes no test, screenshot or code, and does not count. Each variation counts. F-5: 44 of 48 before and after, with the same test links. The project: 730 counted scopes before and after.
- [x] No move of a scope into another scope. "Add variations" on a scope moves its tests to the first variation. "Remove variations" (one variation left) moves them back.
- [x] "All variations": in the screenshot and code tag dialog, a tick box above the variation boxes. In the link pickers, one row "all N variations" above one row for each variation. Both choose each variation that exists now. A variation added later shows "No test" until a test links to it.
- [x] The AI sends `variations` on a scope. It links to SV- IDs. A link to a scope with variations, and an old `set` payload, are refused.
- [x] Checked on a copy of the database: 37 checks of the rules above.

## Later (not in this plan)

- One shared list of values (Shop page, Product page, Cart page, Checkout page) for all features.
- A "To remove" mark on a full set.

### 10. Each variation has its own title (added on 27 Nov 2026)

The scope title is the general result. Each variation needs its own title: the result in that case, for example "Logged-in customer sees the price and the button to the external site" (Product type: External product). Reason: the results for each case were in one paragraph of the scope description (S-1712), and a variation had no place for its own result.

- [x] A new variation needs a title (API, edit forms, AI payloads). The title is unique in the feature. A new scope title, new values or a new or deleted column do not change it.
- [x] The page shows the title, with the values under it as "Column: value" tags. One-line lists show "title · values".
- [x] A deleted or renamed variation is remembered by its title and its values, so the AI does not add it again.
- [x] The AI can give a variation a new title (`{ "id": "SV-44", "title" }`). A title that the app made before ("<scope title> (<values>)") counts as empty.
- [x] Give the old variations their own titles (352 on 27 Nov 2026, AI draft for review), and move per-variation results out of the scope descriptions. The 2 variations of S-18 (marked "To remove") keep the old title.
