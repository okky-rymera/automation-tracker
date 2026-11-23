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
      "group": "Wholesale Price",
      "description": "…",
      "priority": "high",
      "roles": ["Admin", "Wholesale customer"],
      "requirements": ["WooCommerce is active.", "A wholesale customer is logged in."],
      "where": ["…"],
      "notes": ["…", { "id": 12, "text": "…corrected text of an AI draft item…" }],
      "outOfScope": ["…"],
      "questions": ["…"],
      "removeItems": [15],
      "scopes": [
        { "title": "…", "group": "…topic, for example Hide column setting…", "description": "…", "requirements": ["…true for this scope only…"] },
        { "id": "S-14", "title": "…", "requirements": [{ "id": 21, "text": "…corrected AI draft requirement…" }] }
      ],
      "links": [
        { "testId": "CY-1a2b3c4d", "scopes": ["…title of a scope above…", "S-14"] },
        { "testId": "PW-9f8e7d6c" }
      ],
      "code": [
        { "file": "includes/class-example-prices.php", "functions": ["Example_Prices::filter_price_html"], "scopes": ["S-14"] },
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
  ],
  "leftOut": [
    { "testId": "CY-5e6f7a8b", "reason": "Setup only: it makes the products that the other scenarios use." }
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
- `roles` (labels): short names that many features share. They are
  only added. Use the spellings that `features` lists in `labelsInUse`. A name
  with other letter case becomes the existing name.
- `requirements`, `where`, `notes`, `outOfScope`, `questions` (lists): one sentence for each
  item. A text adds an item; the same text again adds nothing.
  `{ "id": 12, "text": "…" }` corrects an item, and `removeItems` deletes items
  by ID. Both work only on AI draft items. `feature <id>` shows the item IDs.
  The old `needs` and `rules` fields are refused: use `requirements`, and
  scopes or `notes`.
- Scope: matched by `id` (`S-14` or `14`), or else by the same title in that
  feature. A new title makes a new scope. The title of an AI draft scope can be
  changed: give its `id` and the new title. The ID, links and screenshot tags stay.
  A scope always needs its `title`, also when you send its `id` to change only
  the group. Without it, the tool refuses the payload.
- Scope `description`: a text replaces an AI draft description. `null`
  deletes an AI draft description. A person's description stays.
- Scope `group` (optional): the title of a scope group of the feature. The
  app shows the scopes of a group together, like a describe block of tests.
  `feature <id>` lists the groups in `scopeGroups`; a person can add a group
  that has no scopes yet. Use one of these titles when it fits. A new title
  makes a new group. A new group replaces an AI draft group. A group that a
  person chose stays, and so does "no group" when a person chose it. The title
  of a group that a person deleted is refused; the old title of a renamed group
  means the renamed group. The report says so. An empty or missing `group`
  does not take a scope out of its group. A new title longer than 200
  characters is refused for that scope only. When you move the last scope out
  of a group that the AI made, the tool deletes that empty group.
- Scope `requirements`: a list like the feature lists, for this scope only.
  `{ "id", "text" }` corrects an item of that scope. `removeItems` on the
  feature deletes scope items too.
  A scope item with the same text as a feature requirement is not added, and a
  feature requirement with the same text as a scope item is not added. A
  correction to such a text is not done. The report says so. A scope has no
  `rules` or `notes`.
- Link `scopes`: scope titles from this payload or the feature, or IDs like
  `S-14` (scope IDs are the same across all features; the ID must be in this
  feature). Leave it out only when the test checks the feature in general.
- To add only links, send a feature with just `id` and `links`.
- `leftOut` (top level, test units only): each test of the file that fits no
  feature, with a reason. Each test of the file needs a link or a `leftOut`
  entry, or the tool refuses the payload. When `next` gives `unlinkedTests`,
  decide those tests. A test unit can send only `leftOut`, with an empty
  `features` list.
- `library` (top level, code units): functions that no test runs and that are
  library code, each with `file`, `function` and `reason`. See SKILL.md, "Sort
  the code that no test runs".
- `group`: found by title, or made new.
- `code`: the plugin code of the feature. `file` is relative to the repo root
  and must exist. `functions` (optional) are names exactly as `code` or
  `test-code` list them, for example `Class_Name::method` or
  `Class_Name::{closure}`. A name that is in the file more than one time (closures)
  holds all of them. No `functions` = the whole file. Entries are only added; an
  entry that a person removed is not added again (the report says so).
  `scopes` (optional): the scopes that this code does, as titles or IDs, as for
  links. Leave it out only for code that does the feature in general. Scope tags
  are only added; on an entry that a person tagged, the report only suggests.

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

**requirements**: what must be true before a tester checks the feature, for
**every** scope: plugins, settings, data, and the user who is logged in. One
sentence each.
> "WooCommerce is active."
> "A wholesale role exists."
> "Logged in as admin or shop manager."
> "All other settings have their default values."

Give the last item when the scopes depend on default settings. Then a scope
with no requirements of its own means "default settings", not "nobody wrote it".

**where**: one item for each place a tester finds it.
> "Product edit screen > General tab > Wholesale Prices fields"
> "Shop page, product page and cart"

**notes**: only what no test can check. A rule that a test can check is a
**scope**, not a note: then the app shows if a test checks it. Ask "can a
tester see this pass or fail?" If yes, write a scope.
> Scope, not note: "A wholesale price higher than the normal price does not show"
> Note: "Admins and shop managers see the same column, because the column has no permission check."
> Note: "The plugin reads the setting when it starts, so a change shows on the next page load."

**Old data.** Old "rules" are now AI draft notes, and old "needs" labels are
now AI draft requirements with one or two words. When you work on a feature
that has them:
- Move each note that a test can check: add it as a scope, and put the note's
  ID in `removeItems`.
- Correct each short requirement to a full sentence with `{ "id", "text" }`.
- Clean each AI draft scope description that tells how it was checked
  ("tried by hand", "no test checks it"). Send the scope `id` with a
  description of facts only, or with `"description": null`. Keep a sentence
  that says a linked test checks only part of the scope.

**outOfScope**: one item for each thing it does not do, and which feature does it if one does.
> "Minimum order quantities (see F-22)."
> "Price tiers by quantity: premium add-on only."

**questions**: only what a person must decide, or what you tried and could
not prove. First read the code, or try it on the test site (SKILL.md, step 2).
A fact that you can check is not a question.
> "The wholesale price does not show in the mini cart widget. Is this intended?"
> "Without Premium, the column shows no wholesale sale price. Does Premium add it?"

**screenshots**: 1–4 images for a feature that has a screen. The caption names
the place and what the image shows.
> "Settings > Prices tab: the option to hide the wholesale price column"
> "Product list in the admin: the wholesale price column with the role name"

**priority**: how bad a failure is for a store. `high`: stores lose money or
orders, or customers see wrong prices. `medium`: a feature does not work, with a
workaround. `low`: display or text. Leave empty when unsure.

**scopes**: the separate things the feature does, like the scenarios of a
test. Each has a result a tester can see. One scope = one thing to check.

- The **title** says the result, and what makes this scope different from the
  others. If the difference is a requirement, name it in a few plain words.
  Write the actor only when it is not the actor of the feature requirements.
- The **requirements** of the scope give the exact setting, data or user for
  this scope only. Do not repeat the feature requirements.
- The **description** is optional. It holds facts about the behavior that do
  not fit in the title. Do not write how you checked it ("tried by hand",
  "no test checks it"): that goes in `unit.note` and the chat report.
  One exception: when a linked test checks only part of the scope, say which
  part no test checks. The app shows a scope with no test, but it cannot
  show a scope that a test checks only in part.

> Title: "An empty text shows the wholesale price with no label"
> Description: "The plugin does not put back the default \"Wholesale Price:\" text."
> Not a description: "Tried by hand: the price shows with no label. No test checks it."
>
> Title: "Checking the hide checkbox and saving removes the column"
> Description: "The linked test sets the value directly. No test checks the box on the settings page."

> Title: "Shows the role name and wholesale price of a variable product"
> Requirements: "A variable product has a wholesale price for one wholesale role."
>
> Title: "The hide setting removes the column"
> Requirements: "The setting Wholesale settings > Prices tab > \"Hide Wholesale Price on Admin Product Listing\" is checked."
>
> Title: "Guest sees only the normal price"

**Settings that turn something off.** Many settings have a negative label:
"Hide …", "Disable …", "Do not …". "With the setting on" then means "the
feature is gone", and readers misread it. So in all text:

- Do not write "the setting is on" or "off".
- Name the setting by its label, and say "checked" or "unchecked".
- Or say what the setting does: "the hide setting removes the column".
- Do not make a scope for the default case, when the feature is not in use
  (see the next rule). Example: no scope "Shows the column" for a feature that
  hides the column.

**No scope for the page before the feature changes it.** A scope must show a
result that this feature makes. When the feature is not in use, the page shows
what WooCommerce or another feature makes. That is not a scope of this feature.

- Do not make a scope like "Guest sees the price by default" for a feature that
  hides the price. The feature that shows the price owns that result.
- Make one scope for "turn the setting on, then off": the result comes back.
  This checks that the feature undoes its own change. Example: "Guest sees the
  price again on the shop page after the owner turns the setting on and then off".
  One such scope for each feature is enough.
- Keep a scope for the default value of the feature's own setting when its label
  can confuse a reader. Example: "The hide checkbox is unchecked by default".
- Keep the scopes that show who the feature does not change. They check that the
  feature stays inside its limits. Example: "Logged-in customer still sees the price".
- Keep the scopes where "default" names a value that this feature makes or uses.
  Examples: the default label text that the feature shows, or the "default
  wholesale role" setting.

A test that checks only the page before the feature changes it has no scope
here. Do not link it. Put it in `leftOut` with the reason "Checks only the page
before <feature> changes it. A person can remove this test." Also name it in the
report. The "feature on" test can check that page as its first step instead.

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
      "group": "Wholesale Orders",
      "description": "Adds a note to each order that a wholesale customer places, so staff can find wholesale orders fast.",
      "priority": "low",
      "roles": ["Admin", "Shop manager"],
      "requirements": ["WooCommerce is active.", "A wholesale role exists."],
      "where": ["Plugin settings > Orders tab > \"Order note\" field", "WooCommerce > Orders > order screen"],
      "notes": ["Staff asked for the note, so they can find wholesale orders without opening each customer."],
      "outOfScope": ["Emails to the customer (see F-30)."],
      "questions": ["An order that an admin makes for a wholesale customer gets no note. Is this intended?"],
      "scopes": [
        {
          "title": "A new wholesale order shows the note text",
          "requirements": ["The \"Order note\" setting has a text.", "A wholesale customer places the order."]
        },
        {
          "title": "An order from a normal customer has no note",
          "requirements": ["The \"Order note\" setting has a text.", "A normal customer places the order."]
        },
        {
          "title": "An empty note setting adds no note",
          "requirements": ["The \"Order note\" setting is empty.", "A wholesale customer places the order."]
        },
        {
          "title": "A change to the order later does not add the note again",
          "requirements": ["The \"Order note\" setting has a text.", "An admin edits a wholesale order and saves it."]
        }
      ],
      "links": [
        {
          "testId": "PW-00000001",
          "scopes": ["A new wholesale order shows the note text", "An order from a normal customer has no note"]
        }
      ],
      "code": [
        { "file": "includes/class-example-order-note.php", "functions": ["Example_Order_Note::add_note"], "scopes": ["A new wholesale order shows the note text", "An empty note setting adds no note"] },
        { "file": "includes/class-example-settings.php", "functions": ["Example_Settings::order_note_field"] }
      ]
    }
  ],
  "library": [
    { "file": "includes/class-example-order-note.php", "function": "Example_Order_Note::__construct", "reason": "Only adds the hooks of the class." }
  ]
}
```
