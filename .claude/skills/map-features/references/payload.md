# Payload for `npm run -s map -- apply`

## Format

```json
{
  "unit": {
    "kind": "cypress",
    "ref": "Pricing/Wholesale price on shop.feature",
    "files": [],
    "note": "Read the steps and the price filter code. Ran the scenario: passed."
  },
  "features": [
    {
      "id": 39,
      "title": "Wholesale prices on the shop page",
      "group": "Pricing",
      "description": "…",
      "priority": "high",
      "roles": ["Admin", "Wholesale customer"],
      "needs": ["WooCommerce"],
      "where": ["…"],
      "rules": ["…", { "id": 12, "text": "…corrected text of an AI draft item…" }],
      "outOfScope": ["…"],
      "questions": ["…"],
      "removeItems": [15],
      "scopes": [
        { "title": "…", "description": "…" },
        { "id": "S-14", "title": "…" }
      ],
      "links": [
        { "testId": "CY-1a2b3c4d", "scopes": ["…title of a scope above…", "S-14"] },
        { "testId": "PW-9f8e7d6c" }
      ],
      "code": [
        { "file": "includes/class-example-prices.php", "functions": ["Example_Prices::filter_price_html"] },
        { "file": "includes/class-example-price-settings.php" }
      ],
      "screenshots": [
        {
          "file": "/tmp/claude-1000/<session scratchpad>/f39-shop-page.png",
          "caption": "Shop page: a wholesale customer sees the wholesale price under the normal price",
          "scopes": ["S-14"]
        }
      ]
    }
  ]
}
```

- `unit.kind`: `playwright`, `cypress` or `code`.
- `unit.ref`: for test files, the `ref` from `next`. For code, the area name.
- `unit.files`: repo-relative paths. Required for `code` (the files the area
  uses; they must exist; PHP, JS and Vue files are all fine). For test files,
  the tool adds the test file itself. Add another file only if it belongs to
  this test file alone (for example its own fixture). Do not add shared page
  objects or step files: a change for any other test would mark this unit
  "changed" too.
- `unit.note`: one line on how you checked the feature. People read it later.
- Feature `id`: give it to add to an existing feature. Leave it out for a new
  feature. A new feature with the same title as an existing one is refused.
- Every field except `title` (for a new feature) is optional. Leave out what
  you do not know or do not change.
- `title`, `description`, `priority`, `group`: one value each. The tool fills an
  empty field, and replaces text only while the feature is an AI draft.
- `roles`, `needs` (labels): short names that many features share. They are
  only added. Use the spellings that `features` lists in `labelsInUse`. A name
  with other letter case becomes the existing name.
- `where`, `rules`, `outOfScope`, `questions` (lists): one sentence for each
  item. A text adds an item; the same text again adds nothing.
  `{ "id": 12, "text": "…" }` corrects an item, and `removeItems` deletes items
  by ID. Both work only on AI draft items. `feature <id>` shows the item IDs.
- Scope: matched by `id` (`S-14` or `14`), or else by the same title in that
  feature. A new title makes a new scope.
- Link `scopes`: scope titles from this payload or the feature, or IDs like
  `S-14` (scope IDs are the same across all features; the ID must be in this
  feature). Leave it out only when the test checks the feature in general.
- To add only links, send a feature with just `id` and `links`.
- `group`: found by title, or made new.
- `code`: the plugin code of the feature. `file` is relative to the repo root
  and must exist. `functions` (optional) are names exactly as `code` or
  `test-code` list them, for example `Class_Name::method` or
  `Class_Name::{closure}`. A name that is in the file more than one time (closures)
  holds all of them. No `functions` = the whole file. Entries are only added; an
  entry that a person removed is not added again (the report says so).

- `screenshots`: images of the feature. `file` is the full path of a local
  PNG, JPEG, WebP or GIF file of 10 MB or less (save it in the session
  scratchpad folder). A relative path is refused. `caption` is required: it
  says what the image shows, and it must be different for each screenshot of
  the feature. `scopes` (optional): scope titles or IDs, as for links.
  Screenshots are only added. The tool finds a screenshot that is already
  there by the first caption it got (letter case and extra spaces do not
  count), also when a person changed the caption since. `feature <id>` shows
  that first caption as `firstCaption`. For a screenshot that is already
  there, the tool does not read the file, and it adds only missing scopes
  (when no person checked it). A screenshot that a person deleted is not
  added again (the report says so).

## Fields: what to write

Sources: requirements traceability matrix templates (stable ID per
requirement, linked tests, priority, acceptance criteria), and QA feature
matrices (user roles, preconditions, business rules, risk). The tracker already
holds test status and coverage, so the fields hold only what people know.

**title**: what a store owner calls it. "Wholesale prices on the shop page",
not "WWP price filter v3".

**description**: 1–3 sentences: what it does, for whom, and why.
> Shows the wholesale price to wholesale customers on the shop and product pages. Other visitors see the normal price.

**roles**: the user roles that use or see it, as short names.
> "Admin", "Shop manager", "Wholesale customer", "Guest", "API client"

**needs**: what must be there or switched on, as short names.
> "WooCommerce", "Wholesale role", "WooCommerce Wholesale Prices Premium"

**where**: one item for each place a tester finds it.
> "Product edit screen > General tab > Wholesale Prices fields"
> "Shop page, product page and cart"

**rules**: one item for each rule. These are what tests must check.
> "A wholesale price shows only when it is lower than the normal price."
> "Prices follow the WooCommerce tax display setting."

**outOfScope**: one item for each thing it does not do, and which feature does it if one does.
> "Minimum order quantities (see F-22)."
> "Price tiers by quantity: premium add-on only."

**questions**: one item for each thing you could not confirm, as a question.
> "Does the wholesale price show in the mini cart widget?"

**screenshots**: 1–4 images for a feature that has a screen. The caption names
the place and what the image shows.
> "Settings > Prices tab: the option to hide the wholesale price column"
> "Product list in the admin: the wholesale price column with the role name"

**priority**: how bad a failure is for a store. `high`: stores lose money or
orders, or customers see wrong prices. `medium`: a feature does not work, with a
workaround. `low`: display or text. Leave empty when unsure.

**scopes**: the separate things the feature does, like the scenarios of a
test. Each has a result a tester can see. One scope = one thing to check.
Write the actor and the result:
> "Admin sets a wholesale price on a simple product, and a wholesale customer sees it on the product page"
> "Guest sees only the normal price"

Include scopes that no test checks yet. Gaps are the point of the list.
Negative and edge cases are scopes too ("Wholesale price higher than the
normal price does not show"). Most features have 3–10 scopes. More is allowed,
but check if the feature is really two features (for example a setting and the
screen it changes can be one feature; two different screens are often two). If
you think a split is right, suggest it in the report: do not split a feature
yourself.

## Complete example (code area)

This feature is made up. It shows the form only: do not copy its facts.

```json
{
  "unit": {
    "kind": "code",
    "ref": "Settings > Orders > Wholesale order note",
    "files": ["includes/class-example-order-note.php", "includes/class-example-settings.php"],
    "note": "Read the setting and the checkout code. Tried the setting on and off with playwright-cli."
  },
  "features": [
    {
      "title": "Wholesale order note",
      "group": "Orders",
      "description": "Adds a note to each order that a wholesale customer places, so staff can find wholesale orders fast.",
      "priority": "low",
      "roles": ["Admin", "Shop manager"],
      "needs": ["WooCommerce", "Wholesale role"],
      "where": ["Plugin settings > Orders tab > \"Order note\" field", "WooCommerce > Orders > order screen"],
      "rules": [
        "The note is added only to orders from a wholesale role.",
        "An empty setting adds no note.",
        "The note is added one time, when the order is placed."
      ],
      "outOfScope": ["Emails to the customer (see F-30)."],
      "questions": ["Is the note added to orders made in the admin for a wholesale customer?"],
      "scopes": [
        { "title": "Admin sets the note text, and a new wholesale order shows it" },
        { "title": "Order from a normal customer has no note" },
        { "title": "Admin clears the setting, and new orders have no note" }
      ],
      "links": [
        {
          "testId": "PW-00000001",
          "scopes": ["Admin sets the note text, and a new wholesale order shows it", "Order from a normal customer has no note"]
        }
      ]
    }
  ]
}
```
