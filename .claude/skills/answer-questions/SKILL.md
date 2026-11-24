---
name: answer-questions
description: Answers the open questions of a feature in the automation tracker. For each question, it reads the plugin code, runs a test or tries the feature on the test site with playwright-cli, writes a report with the answer and the proof, and updates the feature (a new scope, note or out-of-scope item) and removes the answered question. Open questions come from people (the "Open questions" list in the Features tab) or from the map-features skill. Use this skill when the user says "answer the open questions", "answer the questions on F-3", "check question #12", "find out if the feature does X and update it", or wants the AI to confirm something about a feature with the code or a test. To build new features from test files or code, use map-features instead.
---

# Answer the open questions of a feature

The automation tracker (this repo) holds a feature list for each WordPress
plugin. Each feature has a list of open questions. A person adds a question
when they want to know something about the feature. The map-features skill
adds a question when it could not confirm a behavior.

This skill finds the answer, gives a report, and puts the answer in the
feature. Then the person reads the report and checks the new text in the app.

## The tool

Use the same command as map-features, from the tracker repo root
(`/home/chili/Works/Projects/automation-tracker`). Output is JSON.

```bash
npm run -s project -- list                       # project IDs and plugin repo paths
npm run -s map -- features <project>             # all features, short
npm run -s map -- feature  <project> <id>        # one feature: questions with their IDs, scopes, notes
npm run -s map -- code     <project> <repo file> # functions of a file, and the tests that ran them
npm run -s map -- apply    <project> <payload.json>
```

Do not write to the database in any other way (no `sqlite3` writes, no app API calls).

## 1. Pick the questions

- The user named a question (`#12`) or a feature (`F-3`): use it.
- The user said "all": run `features <project>`, then `feature <project> <id>`
  for each feature. Do one feature at a time: answer, apply, report.
- Read the full feature first. You must know its scopes, notes and
  requirements before you answer, so you do not add a copy of them.

## 2. Find the answer

Do these steps in this order. Stop when you have proof.

1. **Look in the feature.** A scope, note or requirement can already answer
   the question. Then the answer is "already in S-4", and nothing new is written.
2. **Read the plugin code.** Search the plugin repo for the setting names,
   hooks, labels and functions. Follow the code to the result that the user
   sees. Give the file and line of each fact.
3. **Try it**, when the question is about what a person sees or what happens
   in the shop. Run the test that checks it, or open the page with
   `playwright-cli` (load the `playwright-cli` skill). Make the data you need,
   look at the result, then set it back.

Rules for proof:

- A code comment, a changelog line or a function name is not proof. Follow
  the code that runs, or try it.
- Code that has many conditions (settings, roles, add-ons) needs a try.
- When the code and the try do not agree, the try wins. Say so in the report.
- Know how the platform works. For example, WordPress loads the plugin again
  on each page load, so "the plugin reads it at start" means "on each page".

**Safety and the test site.** Before you run a test or open the test site,
read `.claude/skills/map-features/references/running-tests.md` and obey its
rules. It also gives the commands to start the site, make test data with
WP-CLI, log in, and stop the site. In short: never run `sudo`, use only a
local or echowp test site, do not change plugin code or test files, and set
back all data and settings that you change.

## 3. Decide where the answer goes

| The answer is… | Write it as |
|---|---|
| A behavior that a test can check | A scope, with its own requirements if needed |
| A behavior of a scope with variations in one more place or case | That scope with its `id`, its title and `variations` with the new variation only, for example `[{ "Page": "Checkout page" }]`. A variation has no description or requirements: put them on the scope |
| A fact that no test can check (a reason, a limit) | A note |
| "The feature does not do this" | An out-of-scope item, and name the feature that does it, if one does |
| Already in the feature | Nothing new. Name the scope or note in the report |

Write **one item for each answer**. Do not write the same fact as a note and
as an out-of-scope item.

"The feature does not do X" goes to out of scope, for example "Sorting the
product list by wholesale price: the column header is not a sort link." Make
it a scope only when the plugin stops X on purpose, and a test must check that
it stays so, for example "A guest does not see the wholesale price."

Then put the question ID in `answeredQuestions`. This removes the question.

Keep the question (do not put it in `answeredQuestions`) when:

- You cannot get proof. Say in the report what you tried and what stopped you.
- The answer depends on a paid add-on that is not on the test site. Answer
  for the plugin that you tested, and say so in the item ("without Premium, …").
  Remove the question only when the question is about the plugin you tested.
  When it asks about the add-on, keep it open, and say what you found.
- A person must decide, for example "Is this a bug, or does it work as intended?"
  Give the facts in the report, and say what the person must decide.
- The answer shows that a person's text in the feature is wrong. The tool
  cannot change that text. Name the item and the correct text in the report.

Follow the writing rules of map-features for all text: plain words, short
sentences, active voice. Read `.claude/skills/map-features/SKILL.md` >
"Writing style", and `references/payload.md` > scopes for scope titles.

## 4. Apply

Write the payload to the session scratchpad folder, then run `apply`.

```json
{
  "unit": { "kind": "answer", "ref": "F-1 questions #10, #11", "note": "Read the column code. Tried the sale price on the test site." },
  "features": [
    {
      "id": 1,
      "answeredQuestions": [10, 11],
      "scopes": [
        { "title": "Wholesale customer sees the wholesale sale price when a product has one", "requirements": ["A simple product has a wholesale price and a wholesale sale price for one role."] }
      ],
      "notes": ["The hide setting takes effect on the next page load, so the product list after Save shows the change."]
    }
  ]
}
```

- `unit.kind` is always `"answer"`. `unit.ref` names the feature and the
  questions. `unit.note` says in one line how you checked.
- The other feature fields work as in map-features
  (`.claude/skills/map-features/references/payload.md`). New text is AI draft,
  so a person sees it for review in the app.
- `answeredQuestions` removes the questions in the same save. If the save
  fails, nothing changes and the questions stay.
- Link a test to the new scope only when you ran it, or read it, and it really
  checks the scope.
- Do not write to a feature or a scope marked "To remove" (`toRemove`). A person
  decided that it must go. Set or clear the mark only when a person asks.
- When the feature has the mark, do not answer its questions and do not send a
  payload. The tool skips all changes to such a feature, also the notes and
  `answeredQuestions`. List its open questions in the report as skipped.
- When only a scope has the mark, put the answer on a scope that stays, or in a
  note of the feature.
- Do not add a scope for the page before the feature changes it. Follow the rule
  "No scope for the page before the feature changes it" in the map-features
  `references/payload.md`.
- Do not add a scope that checks the marketing text of an upsell or promotion
  screen. Follow the rule "No scopes for marketing text" in the map-features
  "Writing style".

## 5. Report

Tell the user, for each question:

- **The question**, its ID, and who wrote it (a person or the AI).
- **The answer**, in one or two plain sentences. Bold the yes or no.
- **The proof**: what you read (file:line) and what you tried (the test, or the
  page and the steps). Say "read only" when you did not try it.
- **The change** in the feature: the new scope (S-id), note or item, and
  "question removed". Or say why the question stays.

End with the list of questions that stay open, and what a person must do
for each.
