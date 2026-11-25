---
name: fill-feature-gaps
description: One-time job. Fills the documentation gaps of the existing features in the automation tracker (settings, settings of other features, cases, exact results, screenshots), one feature at a time, so a person can learn each feature without running the plugin. It records each finished feature in progress.md, so it can stop at any point and continue later where it stopped. Use it when the user says "fill the next features", "continue the fill", "continue filling the gaps", "fill feature gaps", or "fill F-12". Delete this skill folder when all features are filled.
---

# Fill feature gaps (one-time job)

The map-features skill now has rules that make the tracker work as documentation
(settings, settings of other features, cases, exact results, a screenshot for each
scope with a screen). Features mapped before these rules have gaps. This skill
fills them, one feature at a time.

The files in this folder:

- `brief.md`: the instructions for one feature. A helper agent gets them.
- `progress.md`: one line for each finished feature. It is the only record of
  what is done. The app does not record it.
- `notes.md`: facts that earlier runs found for other features. A run gets the
  section of its feature.
- `next.py`: prints the features that are left, in fill order.

Work in the tracker repo root (`/home/chili/Works/Projects/automation-tracker`).

## Steps

1. **Show what is left.** Run `python3 .claude/skills/fill-feature-gaps/next.py wwp 5`.
   It prints how many are done and left, and the next 5 features. The order:
   high, medium, low priority, then the "Integration/…" features (code only).
   If the user named features ("fill F-12"), do those, in that order.
2. **Check the test site is free.** Run `curl -s localhost:5174/api/projects/wwp/map-loop`.
   If it shows `"running":true`, stop and tell the user: the mapping loop uses the same site.
   If the server does not run, start it in the background: `npm run server`.
3. **Fill one feature.** Start ONE helper agent (Agent tool, general-purpose,
   foreground) with the text of `brief.md`, where:
   - `{ID}` is the feature number,
   - `{NOTES}` is the section `## F-<id>` of `notes.md`, or "none",
   - `{INTEGRATION}` is empty for a normal feature. For an "Integration/…"
     feature it is the text in "Integration features" below.
   Run features one at a time: they all use the same test site.
4. **Record it at once.** When the helper saved its changes, add a line to
   `progress.md`: `- F-<id> <YYYY-MM-DD> <the text after PROGRESS:>`. Then:
   - delete the section `## F-<id>` from `notes.md`,
   - add each change that the helper found for OTHER features under the
     section of that feature in `notes.md` (make it if needed), with "(from F-<id>)",
   - put decisions and bugs for a person under "## For a person".
   If the helper did not save (an error, a stop), do not record the feature.
   Tell the user why. The next start does it again.
5. **Tell the user in 3–6 plain lines** what changed in the feature, any new
   open question, and what is next. Then go on with the next feature, until the
   user stops you, or the number the user asked for is done.
6. **At the end**, or when the user stops: say how many are done and left, and
   that a new start continues with the next feature. When none are left, tell the
   user the items under "## For a person", and that this skill folder can be deleted.

## Integration features

Use this text for `{INTEGRATION}`:

> This is an Integration feature: it needs another plugin that the test site does
> not have. Do not start the test site and take no screenshots. Work from the code
> of this plugin only (and the other plugin's code only if it is in the repo).
> Fill the settings, the settings of other features, the cases and the exact
> results from the code. Say "from the code" in each new scope description or note
> that you could not see on a site. Scopes with a screen stay without a screenshot:
> list them in the report as "needs <plugin> on the test site".

## Safety

- The helper follows `.claude/skills/map-features/references/running-tests.md`:
  never `sudo`, `su`, `doas`, `pkexec` or `echowp trust`. It checks
  `faillock --user $USER` before and after. If the count goes up, stop the
  whole job and tell the user at once.
- Each helper makes a database backup before it saves.
- No SQL writes. All changes go through `npm run -s map -- apply`.
