You fill the documentation gaps of ONE existing feature in the automation tracker: F-{ID} of project "wwp" (WooCommerce Wholesale Prices). Work in /home/chili/Works/Projects/automation-tracker. Run all commands, playwright-cli too, from that folder (playwright-cli sessions belong to the folder where they start).

Goal: the tracker is the documentation of the plugin. A person (or an AI that writes a test plan) must understand how F-{ID} works from the tracker alone, without running the plugin. Apply the map-features skill's rules to F-{ID} only.

Read first:
- CLAUDE.md (how to read and change tracker data)
- .claude/skills/map-features/SKILL.md — especially "Write the feature so a person does not need the test site", "Add screenshots, so a person sees how the feature looks", and the writing-style rules
- .claude/skills/map-features/references/payload.md (payload format; the `settings` list; settings of other features go in scope requirements)
- .claude/skills/map-features/references/running-tests.md (safety rules: NEVER run sudo/su/doas/pkexec or `echowp trust`; follow it exactly)

Steps:
0. Make a backup: `sqlite3 data/tracker.db ".backup data/tracker-backup-$(date +%Y%m%d-%H%M)-before-backfill-f{ID}.db"`. Run `faillock --user $USER`.
1. `npm run -s map -- feature wwp {ID}` and `npm run -s map -- screenshots wwp {ID} <your scratchpad dir>`; open the existing PNGs with Read. Note each scope with `toRemove`: skip those scopes completely.
2. Read the plugin code of F-{ID} (its `code` entries; plugin repo at /home/chili/Works/tracker-repos/woocommerce-wholesale-prices). Find: the settings it owns (place, label, choices, default), settings of OTHER features that change its scopes, and the cases (product types, classic vs block cart/checkout, mini cart, pages, roles).
3. Fill the gaps per the rules: `settings` items; scope requirements for other features' settings (with feature ID); for each case a scope/variation or an outOfScope line with the reason; scope descriptions where title + image do not give the exact result. Confirm new behavior on the site or in the code; do not state a guess as fact. Do not edit other features: only report what they need. You may correct text that a person wrote in F-{ID} (fields, list items with { id, text }) only when the code or the site proves it wrong; say so in the report.
4. Screenshots: each scope with a screen must be in at least one screenshot, unless a still image truly cannot show it ("it looks like another image" is not a reason). First re-tag existing images that already show a scope: send `{ "id": "IMG-n", "scopes": [...] }` — this works also on screenshots that a person checked, so do NOT take copies. Replace an old or wrong image with `{ "id", "replace": true, "file" }`; fix a wrong caption with `newCaption`. Take new ones only when needed, with `playwright-cli -s=backfill ...`, window 1280x800, per the skill's screenshot rules. Test site: `npm run -s project -- run-spec wwp <a Playwright spec ref linked to F-{ID}>` starts site-1 and leaves it on (Bash timeout 600000). Test pages you create show in the site's top menu: give them neutral names ("Cart (classic)"). If no Playwright spec is linked, use any spec of a related feature to start the site. The wholesale settings page opens on the General tab; click the tab you need. Do not print .env values. Set every changed site setting back, delete test data you made, and stop the site at the end.
5. Save with `npm run -s map -- apply wwp <payload.json>` with unit `{ "kind": "update", "ref": "backfill F-{ID}", "note": "<what you checked and how>" }`. Do NOT write SQL. Do not change plugin code or tests.
6. Run `faillock --user $USER` at the end. If the count went up at any time, stop and say so first.

More rules (learned from earlier runs):
- Cleanup: if a site option did not exist before you changed it, delete it. Do not set it to a value.
- A screen that the real site cannot reach easily can be shown by faking the server answer; start its caption with "(simulated)". Prefer the real screen.
- playwright-cli uploads only files inside the tracker repo: use a temporary folder there and delete it after.
- In zsh, a command held in a shell variable does not split into words: use a small script or a function.
- If the payload is very large, save it in more than one apply with the same unit ref; the last apply carries the full note.
{INTEGRATION}
Facts that earlier runs found for this feature (check each one before you write it; it can be wrong or already done):
{NOTES}

Report back (plain words, short):
- what you added: settings items, scope requirements, new scopes / outOfScope lines, scope descriptions, screenshots (captions + scopes), re-tags, questions
- scopes with a screen that still have no screenshot, and why
- changes that OTHER features need (feature ID, scope ID, the change) — not written
- anything in the skill rules that was unclear or made you guess
- problems with the site or tools
- end with one line: `PROGRESS: <one short line: what the run did>` (for example `PROGRESS: 2 settings, 5 new scopes, 18 screenshots`)
