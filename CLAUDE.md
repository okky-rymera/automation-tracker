# Automation Tracker: notes for Claude

## How to read and change the tracker data

The user can ask you to check features, or to change them (for example "move scope S-12 to F-3").
All data is in `data/tracker.db`. It is the only copy of the feature list.

Before a large change, make a backup:

```
sqlite3 data/tracker.db ".backup data/tracker-backup-$(date +%Y%m%d-%H%M)-before-<what>.db"
```

### Read

These commands do not need the server:

- `npm run -s project -- list` shows the project IDs.
- `npm run -s map -- features <project>` shows all features with their scopes, as JSON.
- `npm run -s map -- feature <project> <feature id> [--all]` shows one feature in full.

### Change

Use the app's API. It does the same checks as the web page.
Do not write SQL to the database: SQL skips these checks and the AI marks.

1. Make sure that the server runs: `curl -s localhost:5174/api/projects`.
2. If it does not run, start it in the background: `npm run server`.
3. Send the change with `curl -s -X <METHOD> -H 'content-type: application/json' -d '<body>' localhost:5174<route>`.

The routes are in `server/index.ts`. The code for each route is in `edits` in `server/features.ts`. Common routes:

| Change | Route |
|---|---|
| Add, change or delete a feature | `POST /api/projects/:id/features`, `PATCH` or `DELETE .../features/:fid` |
| Merge feature `from` into `:fid` | `POST .../features/:fid/merge` with `{ "from": <id> }` |
| Add a scope | `POST .../features/:fid/scopes` with `{ "title", "description" }` |
| Change or delete a scope | `PATCH` or `DELETE .../scopes/:sid`. `{ "groupId": <id> }` puts it in a scope group, `null` takes it out |
| Add a scope group to a feature | `POST .../features/:fid/scope-groups` with `{ "title" }` |
| Rename or delete a scope group | `PATCH .../scope-groups/:gid` with `{ "title" }`, or `DELETE`. A delete keeps the scopes, with no group |
| Add variations to a scope, or one more variation | `POST .../scopes/:sid/variations` with `{ "title", "values", "columns"? }`. `title` is required: the variation's own sentence. `values`: a list in column order, or `{ "<column>": "<value>" }`. The first call sets the columns (default: the keys of `values`, or `["Page"]`) |
| Change a variation, or rename the columns | `PATCH .../scopes/:sid` with `{ "title" }` or `{ "values" }` on a variation, or `{ "columns" }` on its scope (same number, same order) |
| Add or delete a column | `POST .../scopes/:sid/columns` with `{ "name", "value"? }`, or `DELETE .../scopes/:sid/columns/:index` (0 is the first) |
| End the variations of a scope | `DELETE .../scopes/:sid/variations`. Only with one variation (or none) left: its tests go back to the scope |
| Move a scope to another feature | `POST .../scopes/:sid/move` with `{ "featureId": <id> }` |
| Mark a feature or scope "To remove" | `PATCH .../features/:fid` or `.../scopes/:sid` with `{ "toRemove": { "reason": "<why>", "by": "ai" } }`. `{ "toRemove": null }` clears it |
| Add a requirement or list item | `POST .../features/:fid/items` with `{ "kind", "text", "scopeId"? }` |
| Link a test | `POST .../links` with `{ "testId", "scopeId" }` or `{ "testId", "featureId" }` |
| Set the scopes of a link | `PATCH .../links/:lid` with `{ "scopeIds": [] }` |
| Move all links of a renamed test | `POST .../links/move-test` with `{ "from": "<old test ID>", "to": "<new test ID>", "featureId"? }`. With `featureId`, only the active link to that feature moves |
| Create a GitHub issue to write tests (only when the user asks: it posts to GitHub) | `POST .../features/:fid/issues` with `{ "scopeId": <id> }` for one scope, or `{}` for all scopes of the feature with no test and no open issue. The AI writes it with the create-issue skill, with no plan, in 1 to 2 minutes |
| Add an issue that is on GitHub to a feature or scope | `POST .../features/:fid/issues/link` with `{ "issue": "1162" \| "owner/repo#12" \| "<issue link>", "scopeId"? }`. A number is an issue of the plugin repo. The app checks the issue on GitHub first |
| List the issues, or take one off the tracker | `GET .../issues`, or `DELETE .../issues/:iid` (the issue on GitHub stays) |
| Check the open issues on GitHub now (the app also does this at the daily sync interval, 24 hours by default) | `POST .../issues/sync`. It reads GitHub only. Only one check runs at a time |
| Sync the copy with the remote branch | `POST .../sync` with `{ "tests": "auto" \| "always" \| "never" }`. `GET .../sync` shows the state. |

IDs: `F-12` is feature 12, `S-40` is scope 40, `SV-44` is variation 44 (in the scopes routes, send 44), `G-3` is group 3, and `IMG-7` is screenshot 7. Send only the number.
Test IDs start with `PW-` (Playwright) or `CY-` (Cypress). Send them in full.
The web page has a copy button next to each ID. A copied scope or screenshot ID tells its feature too, for example `F-12/S-40` or `F-12/IMG-7`.
The command line and the request bodies accept a copied ID (`F-12/S-40` is scope 40). In a URL path, send only the number (`.../scopes/40`).

The command line can move a scope too. It does not need the server:
`npm run -s map -- move-scope <project> <scope id> <feature id>`.

### What the "To remove" mark does

Use it when the user wants a feature or scope to go, but its tests are still there.
Set the mark only when the user asks. Send `"by": "ai"`, so the app shows who set it.

- The links, code and screenshots stay.
- The item does not count in the coverage counts. A marked feature counts all its scopes as marked.
- The Tests page shows "To remove" on a test that has links only to marked items. A Cypress test then shows "do not convert".
- The AI skills do not write to a marked item. The AI review skips a marked feature.
- A moved scope keeps its own mark. A scope that has only the mark of its feature loses it when it moves out.
- When the tests are gone, delete the scope or the feature.

### What scope variations do

A scope can have variations: one check in several places, for example the 4 pages where one price check applies.

- The scope keeps the sentence (its title), the description, the requirements, the group and "Move to feature".
- The scope has 1 to 6 columns with names that a person or the AI chooses, for example "Page" and "Product type".
- A person or the AI types each variation. The app does not make combinations.
- Each variation has an SV- ID (for example `SV-44`), its own title, its values, its test links, screenshots, code and coverage. S- and SV- IDs share one number series.
- A scope with variations takes no test link, screenshot or code itself, and does not count in the coverage counts: each variation counts.
- Each variation needs its own title: a sentence that tells what the plugin does in this case, for example what the user sees there. The scope title is the general result. A title is unique in the feature. The page shows the values under the title, as "Column: value" tags.
- A new scope title, new values or a deleted column do not change the variation titles. A renamed variation is remembered by its old title and its old values, as in a rename.
- Variations from before 27 Nov 2026 can still have the title that the app made: "<scope title> (<values>)". The AI replaces such a title, and the review shows the change.
- A variation has no description, requirements or group, and cannot move alone. It moves with its scope.
- A scope that is already there cannot become a variation of another scope.
- When a scope with tests gets its first variation, its tests, screenshots and code go to that variation. "Remove variations" (only with one variation left) puts them back on the scope.
- When the last variation is deleted, the scope has no variations: it is a normal scope again, with no tests. A deleted scope takes its variations with it.
- A "To remove" mark on the scope counts for each of its variations.
- A feature merge keeps each scope with its variations.

### What a move does

A scope moves with its requirements, its test links, and the screenshots that show only this scope.
It goes into the target's scope group with the same title, or into the group that a person renamed from that title.
The target gets that group if it does not know the title. If a person deleted a group with that title from the target, the scope has no group there.
An AI-made group that has no scopes after the move is deleted.
A screenshot that shows other scopes too stays, and loses only the tag of this scope.
When a test link has no scope left on the old feature, the link is marked removed.
Then the AI skill does not link the test to the old feature again.
The old feature remembers the title and ID of the moved scope. Then the AI skill does not make the scope again there.
A deleted or renamed scope is remembered in the same way. To get a deleted scope back, add a scope with the same title.
The app refuses a move when the target feature has a scope with the same title.
