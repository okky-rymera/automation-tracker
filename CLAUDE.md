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
| Change or delete a scope | `PATCH` or `DELETE .../scopes/:sid` |
| Move a scope to another feature | `POST .../scopes/:sid/move` with `{ "featureId": <id> }` |
| Add a requirement or list item | `POST .../features/:fid/items` with `{ "kind", "text", "scopeId"? }` |
| Link a test | `POST .../links` with `{ "testId", "scopeId" }` or `{ "testId", "featureId" }` |
| Set the scopes of a link | `PATCH .../links/:lid` with `{ "scopeIds": [] }` |
| Move all links of a renamed test | `POST .../links/move-test` with `{ "from": "<old test ID>", "to": "<new test ID>" }` |
| Sync the copy with the remote branch | `POST .../sync` with `{ "tests": "auto" \| "always" \| "never" }`. `GET .../sync` shows the state. |

IDs: `F-12` is feature 12, and `S-40` is scope 40. Send only the number.

The command line can move a scope too. It does not need the server:
`npm run -s map -- move-scope <project> <scope id> <feature id>`.

### What a move does

A scope moves with its requirements, its test links, and the screenshots that show only this scope.
A screenshot that shows other scopes too stays, and loses only the tag of this scope.
When a test link has no scope left on the old feature, the link is marked removed.
Then the AI skill does not link the test to the old feature again.
The old feature remembers the title and ID of the moved scope. Then the AI skill does not make the scope again there.
A deleted or renamed scope is remembered in the same way. To get a deleted scope back, add a scope with the same title.
The app refuses a move when the target feature has a scope with the same title.
