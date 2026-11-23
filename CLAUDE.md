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
| Move a scope to another feature | `POST .../scopes/:sid/move` with `{ "featureId": <id> }` |
| Mark a feature or scope "To remove" | `PATCH .../features/:fid` or `.../scopes/:sid` with `{ "toRemove": { "reason": "<why>", "by": "ai" } }`. `{ "toRemove": null }` clears it |
| Add a requirement or list item | `POST .../features/:fid/items` with `{ "kind", "text", "scopeId"? }` |
| Link a test | `POST .../links` with `{ "testId", "scopeId" }` or `{ "testId", "featureId" }` |
| Set the scopes of a link | `PATCH .../links/:lid` with `{ "scopeIds": [] }` |
| Move all links of a renamed test | `POST .../links/move-test` with `{ "from": "<old test ID>", "to": "<new test ID>" }` |
| Sync the copy with the remote branch | `POST .../sync` with `{ "tests": "auto" \| "always" \| "never" }`. `GET .../sync` shows the state. |

IDs: `F-12` is feature 12, `S-40` is scope 40, `G-3` is group 3, and `IMG-7` is screenshot 7. Send only the number.
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
